'use strict';

// services/barbara_runtime.js
// Barbara's normalization runtime. Polls agent_tasks for normalize_threat and
// normalize_intel tasks queued by the pipeline routes when Rick and Ivan/Charlie
// submit records. Fetches the source record, computes readiness flags, and
// submits to POST /api/pipeline/repository/process — which handles downstream
// notifications (James, Ruth, Kirby, Owen).
//
// Token strategy: mirrors rick_runtime.js and ruth_runtime.js.
// Run within the main server process — polled by the scheduler cron.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const BATCH_LIMIT     = 10;
const POLL_WINDOW_HRS = 72; // wider window — Barbara drains a backlog, not a 12h cycle

// ── Token management ──────────────────────────────────────────────────────────

let _barbaraToken = null;

async function ensureBarbaraToken() {
  if (_barbaraToken) {
    try {
      jwt.verify(_barbaraToken, process.env.AGENT_JWT_SECRET);
      return _barbaraToken;
    } catch (_) {}
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Barbara', agent_team: 'normalization' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Barbara', hash);
  _barbaraToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureBarbaraToken();
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

// ── Normalization: threat records ─────────────────────────────────────────────

function normalizeThreat(threat) {
  const cvss = parseFloat(threat.cvss_score) || 0;
  const isKev      = threat.category === 'known_exploited_vulnerability';
  const isImmediate = threat.priority === 'immediate';
  const hasCve     = !!threat.cve_id;

  return {
    source_type: 'threat',
    source_id:   threat.id,
    normalized_data: {
      title:       threat.threat_name,
      cve_id:      threat.cve_id || null,
      category:    threat.category,
      severity:    threat.severity,
      cvss_score:  cvss,
      source_url:  threat.source_url || null,
      priority:    threat.priority,
      tags:        threat.tags || [],
      ingested_at: threat.ingested_at,
    },
    correlation_tags: buildThreatCorrelationTags(threat, cvss, isKev, isImmediate),
    ready_for_intel:     isKev || isImmediate || (hasCve && cvss >= 9.0),
    ready_for_awareness: true,
  };
}

function buildThreatCorrelationTags(threat, cvss, isKev, isImmediate) {
  const tags = new Set(threat.tags || []);
  if (isKev)           tags.add('kev-advisory');
  if (cvss >= 9.0)     tags.add('critical-cvss');
  if (isImmediate)     tags.add('immediate-priority');
  if (threat.cve_id)   tags.add('has-cve');
  return [...tags];
}

// ── Normalization: intel items (innovation/growth/policy) ─────────────────────

function normalizeIntelItem(item) {
  const isHighPriority = item.priority === 'high';

  return {
    source_type: item.type,
    source_id:   item.id,
    normalized_data: {
      title:       item.headline,
      category:    item.category,
      type:        item.type,
      summary:     item.summary || null,
      priority:    item.priority,
      tags:        item.tags || [],
      ingested_at: item.ingested_at,
    },
    correlation_tags: [...new Set([...(item.tags || []), item.type])],
    ready_for_intel:     isHighPriority,
    ready_for_awareness: true,
  };
}

// ── Task execution ────────────────────────────────────────────────────────────

async function executeNormalizeTask(task) {
  const ts = new Date().toISOString();

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    let payload;

    if (task.task_type === 'normalize_threat') {
      const rows = await db.pool.query(
        'SELECT * FROM threat_records WHERE id=$1', [task.content_id]
      ).then(r => r.rows);

      if (!rows.length) {
        console.warn(JSON.stringify({
          ts, runtime: 'barbara', event: 'SOURCE_NOT_FOUND',
          task_id: task.id, task_type: task.task_type, content_id: task.content_id,
        }));
        await db.updateTask(task.id, { status: 'failed', error_message: 'Threat record not found' });
        return;
      }
      payload = normalizeThreat(rows[0]);

    } else if (task.task_type === 'normalize_intel') {
      const rows = await db.pool.query(
        'SELECT * FROM intel_items WHERE id=$1', [task.content_id]
      ).then(r => r.rows);

      if (!rows.length) {
        console.warn(JSON.stringify({
          ts, runtime: 'barbara', event: 'SOURCE_NOT_FOUND',
          task_id: task.id, task_type: task.task_type, content_id: task.content_id,
        }));
        await db.updateTask(task.id, { status: 'failed', error_message: 'Intel item not found' });
        return;
      }
      payload = normalizeIntelItem(rows[0]);

    } else {
      await db.updateTask(task.id, { status: 'failed', error_message: `Unknown task type: ${task.task_type}` });
      return;
    }

    await apiCall('/api/pipeline/repository/process', 'POST', payload);
    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'NORMALIZED',
      task_id: task.id, task_type: task.task_type,
      source_type: payload.source_type, source_id: payload.source_id,
      ready_for_intel: payload.ready_for_intel, ready_for_awareness: payload.ready_for_awareness,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    console.error(JSON.stringify({
      ts, runtime: 'barbara', event: 'TASK_ERROR',
      task_id: task.id, task_type: task.task_type, error: e.message,
    }));
    throw e;
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollBarbaraTasks() {
  const ts = new Date().toISOString();
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name  = 'Barbara'
        AND task_type   IN ('normalize_threat', 'normalize_intel')
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HRS} hours'
      ORDER BY started_at ASC
      LIMIT $1
    `, [BATCH_LIMIT]).then(r => r.rows);

    if (!tasks.length) return;

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_START', queued: tasks.length,
    }));

    let processed = 0;
    let errors = 0;

    for (const task of tasks) {
      try {
        await executeNormalizeTask(task);
        processed++;
      } catch (_) {
        errors++;
      }
    }

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_COMPLETE', processed, errors, total: tasks.length,
    }));

    if (errors > 0) {
      await notifyAgents(['Barret'], {
        type: 'BARBARA_BATCH_ERRORS',
        processed, errors, total: tasks.length,
        message: `Barbara normalization batch: ${errors} of ${tasks.length} tasks failed. ${processed} normalized successfully.`,
      });
    }

  } catch (e) {
    console.error(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollBarbaraTasks, ensureBarbaraToken };
