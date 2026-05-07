'use strict';

// services/ed_runtime.js
// Ed's awareness pipeline runtime. Polls agent_tasks for eic_review_briefing
// tasks, performs EIC final review on the dev-edited briefing, and advances
// the briefing to qa stage via PATCH /api/pipeline/briefings/:id/status.
//
// Token strategy: mirrors ruth_runtime.js — self-provisions a fresh JWT at
// startup, stores the hash in agent_tokens. Requires AGENT_JWT_SECRET and
// API_BASE_URL in env.
//
// Run within the main server process — polled by the scheduler cron.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;

// ── Token management ─────────────────────────────────────────────────────────

let _edToken = null;

async function ensureEdToken() {
  if (_edToken) {
    try {
      jwt.verify(_edToken, process.env.AGENT_JWT_SECRET);
      return _edToken;
    } catch (_) {
      // Token expired or invalid — re-provision below
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Ed', agent_team: 'awareness' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Ed', hash);
  _edToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureEdToken();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Agent ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE()}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${json.error || json.message || JSON.stringify(json)}`);
  }
  return json;
}

// ── Briefing fetch ────────────────────────────────────────────────────────────

async function getBriefingForReview(contentId) {
  const row = await db.pool.query(
    `SELECT id, edition_date, subject_line, body_md, pipeline_status,
            threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id
     FROM briefings WHERE id = $1`,
    [contentId]
  ).then(r => r.rows[0] || null);
  return row;
}

// ── EIC review ────────────────────────────────────────────────────────────────

function applyEICReview(briefing) {
  const issues = [];

  if (!briefing.subject_line || briefing.subject_line.trim().length === 0)
    issues.push('subject_line missing');

  if (!briefing.body_md || briefing.body_md.trim().length < 50)
    issues.push('body_md too short or empty');

  const threatCount = Array.isArray(briefing.threat_item_ids) ? briefing.threat_item_ids.length : 0;
  const innovCount  = Array.isArray(briefing.innovation_item_ids) ? briefing.innovation_item_ids.length : 0;

  if (threatCount !== 3)  issues.push(`threat composition ${threatCount}/3`);
  if (innovCount  !== 2)  issues.push(`innovation composition ${innovCount}/2`);
  if (!briefing.growth_item_id)   issues.push('growth_item_id missing');
  if (!briefing.training_byte_id) issues.push('training_byte_id missing');

  return { issues };
}

// ── Task execution ────────────────────────────────────────────────────────────

async function executeEdEICReview(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'ed', event: 'EIC_REVIEW_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const briefing = await getBriefingForReview(task.content_id);
    if (!briefing) {
      throw new Error(`Briefing ${task.content_id} not found`);
    }

    if (briefing.pipeline_status !== 'dev_edit') {
      console.log(JSON.stringify({
        ts, runtime: 'ed', event: 'SKIP_WRONG_STATUS',
        briefing_id: briefing.id, pipeline_status: briefing.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    const { issues } = applyEICReview(briefing);

    if (issues.length > 0) {
      const error_message = `EIC review blocked — issues: ${issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'ED_EIC_REVIEW_BLOCKED',
        briefing_id: briefing.id,
        edition_date: briefing.edition_date,
        task_id: task.id,
        issues,
        message: `Ed cannot complete EIC review for ${briefing.edition_date} — ${error_message}.`,
      });
      console.warn(JSON.stringify({
        ts, runtime: 'ed', event: 'EIC_REVIEW_BLOCKED',
        briefing_id: briefing.id, issues,
      }));
      return;
    }

    // Advance briefing to eic_review — AWARENESS_DISPATCH fires Jeff's task + notification
    await apiCall(`/api/pipeline/briefings/${briefing.id}/status`, 'PATCH', {
      to_status:  'eic_review',
      agent_name: 'Ed',
      notes:      `EIC review complete. Editorial standards verified: subject line, composition, source integrity.`,
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'ed', event: 'EIC_REVIEW_COMPLETE',
      briefing_id: briefing.id, edition_date: briefing.edition_date, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'ED_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Ed runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'ed', event: 'RUNTIME_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollEdTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Ed'
        AND task_type   = 'eic_review_briefing'
        AND status      = 'queued'
        AND created_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY created_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeEdEICReview(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'ed', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollEdTasks, ensureEdToken };
