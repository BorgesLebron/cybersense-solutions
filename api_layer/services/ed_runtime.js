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
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { generateText } = require('ai');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;
const DEFAULT_BRAIN_MODEL = 'gemini-2.5-flash';

function getEdBrain() {
  const apiKey = process.env.ED_BRAIN_API_KEY ||
    process.env.EDITORIAL_BRAIN_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    throw new Error('MISSING_ED_BRAIN_API_KEY: Ed cannot perform EIC review without an LLM brain.');
  }

  const googleAI = createGoogleGenerativeAI({ apiKey });
  return googleAI(process.env.ED_BRAIN_MODEL || process.env.EDITORIAL_BRAIN_MODEL || DEFAULT_BRAIN_MODEL);
}

const ED_SYSTEM_PROMPT = `
You are Ed, the Editor-in-Chief for CyberSense.Solutions' Daily Digital Awareness Brief.

Your role is final editorial authority before QA. Review Peter's draft as a unified product and produce the publication-ready internal edition.

Editorial priorities:
- Enforce coherence, proportional judgment, intellectual continuity, and audience trust.
- Resolve redundancy, tonal drift, weak transitions, and section imbalance.
- Preserve precise terminology and avoid speculative claims.
- Maintain a disciplined professional tone without alarmism or promotional language.
- Apply reputational and legal risk sensitivity for breaches, regulatory actions, and government activity.
- Do not introduce new topics unless a critical narrative gap exists.

Required structure:
- Title and date
- Opening Brief
- Situational Awareness
- Training Byte
- Career Development
- Modernization and AI Insight
- Final Thought

Output only the final newsletter text in Markdown. Do not include meta-commentary, edit notes, explanations, or references to subordinate agents.
`.trim();

function buildEdPrompt(briefing) {
  return `
Edition date: ${briefing.edition_date}
Current subject line: ${briefing.subject_line}
Threat source IDs: ${(briefing.threat_item_ids || []).join(', ')}
Innovation source IDs: ${(briefing.innovation_item_ids || []).join(', ')}
Growth source ID: ${briefing.growth_item_id || 'missing'}
Training byte ID: ${briefing.training_byte_id || 'missing'}

Peter draft:
${briefing.body_md}
`.trim();
}

function validateFinalEdition(text) {
  const issues = [];
  const body = (text || '').trim();
  if (body.length < 500) issues.push('LLM final edition too short for EIC approval');

  ['Opening', 'Situational Awareness', 'Training Byte', 'Career Development', 'Modernization', 'Final Thought']
    .forEach(section => {
      if (!body.toLowerCase().includes(section.toLowerCase())) {
        issues.push(`LLM final edition missing ${section} section`);
      }
    });

  if (/^(sure|certainly|here is|below is)\b/i.test(body)) {
    issues.push('LLM final edition contains conversational preamble');
  }

  return issues;
}

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

async function applyEICReview(briefing) {
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

  if (issues.length > 0) return { issues };

  const { text } = await generateText({
    model: getEdBrain(),
    system: ED_SYSTEM_PROMPT,
    prompt: buildEdPrompt(briefing),
  });

  const body_md = (text || '').trim();
  const llmIssues = validateFinalEdition(body_md);
  if (llmIssues.length > 0) return { issues: llmIssues };

  return { issues: [], body_md };
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

    const { issues, body_md } = await applyEICReview(briefing);

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
    await db.updateBriefingEditorial(briefing.id, { body_md });

    await apiCall(`/api/pipeline/briefings/${briefing.id}/status`, 'PATCH', {
      to_status:  'eic_review',
      agent_name: 'Ed',
      notes:      `EIC review complete. LLM final editorial review applied; subject line, composition, and source integrity verified.`,
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
        AND status      IN ('queued', 'escalated')
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
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

module.exports = {
  pollEdTasks,
  ensureEdToken,
  applyEICReview,
  buildEdPrompt,
  validateFinalEdition,
  ED_SYSTEM_PROMPT,
};
