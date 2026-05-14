'use strict';

// services/ruth_runtime.js
// Ruth's awareness pipeline runtime. Polls agent_tasks for DAILY_CYCLE_START
// triggers, queries intel_repository for composition items, and submits the
// 7-item briefing package to POST /api/pipeline/briefings.
//
// Token strategy: self-provisions a fresh JWT at startup and stores the hash
// in agent_tokens so requireAgentToken middleware accepts it. Requires
// AGENT_JWT_SECRET and API_BASE_URL (defaults to localhost:PORT) in env.
//
// Run within the main server process — polled by the scheduler cron.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const COMPOSITION = { threats: 3, innovations: 2, growth: 1 };
const POLL_WINDOW_HOURS = 12;

function nextCtDate(daysAhead = 1) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// ── Token management ─────────────────────────────────────────────────────────

let _ruthToken = null;

async function ensureRuthToken() {
  if (_ruthToken) {
    try {
      jwt.verify(_ruthToken, process.env.AGENT_JWT_SECRET);
      return _ruthToken;
    } catch (_) {
      // Token expired or invalid — re-provision below
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Ruth', agent_team: 'awareness' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Ruth', hash);
  _ruthToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureRuthToken();
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

// ── Repository query ──────────────────────────────────────────────────────────

async function selectCompositionItems() {
  const queue = await apiCall('/api/pipeline/repository/queue?pipeline=awareness&limit=60');
  const items = queue.data || [];

  const threats    = items.filter(i => i.source_type === 'threat').slice(0, COMPOSITION.threats);
  const innovations = items.filter(i => i.source_type === 'innovation').slice(0, COMPOSITION.innovations);
  const growthItem  = items.find(i => i.source_type === 'growth') || null;

  // Training byte: Kirby delivers these as training_modules type='training_byte'.
  // Query directly — not routed through intel_repository.
  const trainingByte = await db.pool.query(`
    WITH published AS (
      SELECT id, title, created_at
      FROM training_modules
      WHERE type = 'training_byte'
        AND pipeline_status = 'published'
    ),
    recent_unique AS (
      SELECT training_byte_id, MAX(edition_date) AS last_used
      FROM briefings
      WHERE training_byte_id IS NOT NULL
      GROUP BY training_byte_id
    ),
    exclusions AS (
      SELECT training_byte_id
      FROM recent_unique
      ORDER BY last_used DESC
      LIMIT GREATEST((SELECT COUNT(*) FROM published) - 1, 0)
    )
    SELECT id, title
    FROM published
    WHERE id NOT IN (SELECT training_byte_id FROM exclusions)
    ORDER BY created_at DESC
    LIMIT 1
  `).then(r => r.rows[0] || null);

  const missing = [];
  if (threats.length    < COMPOSITION.threats)     missing.push(`threats (need ${COMPOSITION.threats}, found ${threats.length})`);
  if (innovations.length < COMPOSITION.innovations) missing.push(`innovations (need ${COMPOSITION.innovations}, found ${innovations.length})`);
  if (!growthItem)   missing.push('growth item (0 found)');
  if (!trainingByte) missing.push('training_byte (no published candidate available — Kirby runtime may need to publish new bytes)');

  return { threats, innovations, growthItem, trainingByte, missing };
}

// ── Briefing content builder ──────────────────────────────────────────────────

function buildContent(threats, innovations, growthItem) {
  const topThreat = threats[0];
  const subjectLine = topThreat?.title ||
    `Daily Awareness Briefing — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const threatSection = threats
    .map(t => `### ${t.title || 'Threat Advisory'}\n_Source ID: ${t.source_id}_`)
    .join('\n\n');

  const intelSection = [
    ...innovations.map(i => `### Innovation: ${i.title || 'Innovation Item'}`),
    `### Growth: ${growthItem?.title || 'Growth Item'}`,
  ].join('\n\n');

  const body_md = `${threatSection}\n\n---\n\n${intelSection}`;

  return { subjectLine, body_md };
}

// ── Cycle execution ───────────────────────────────────────────────────────────

async function executeRuthDailyCycle(task) {
  const ts          = new Date().toISOString();
  const editionDate = nextCtDate();

  console.log(JSON.stringify({
    ts, runtime: 'ruth', event: 'CYCLE_START',
    edition_date: editionDate, task_id: task.id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    // Idempotency — skip if briefing already exists for today
    const existing = await db.getBriefingByDate(editionDate);
    if (existing) {
      console.log(JSON.stringify({
        ts, runtime: 'ruth', event: 'ALREADY_EXISTS',
        edition_date: editionDate, briefing_id: existing.id,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    // Select composition items from intel_repository
    const { threats, innovations, growthItem, trainingByte, missing } = await selectCompositionItems();

    console.log(JSON.stringify({
      ts, runtime: 'ruth', event: 'COMPOSITION_RESULT',
      edition_date: editionDate,
      threats_found: threats.length,
      innovations_found: innovations.length,
      growth_found: !!growthItem,
      training_byte_found: !!trainingByte,
      missing: missing.length > 0 ? missing : null,
    }));

    if (missing.length > 0) {
      const error_message = `Incomplete repository: ${missing.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'RUTH_COMPOSITION_INCOMPLETE',
        edition_date: editionDate,
        task_id: task.id,
        missing,
        message: `Ruth cannot compose briefing for ${editionDate} — ${error_message}. 0700 CT delivery at risk.`,
      });
      console.warn(JSON.stringify({
        ts, runtime: 'ruth', event: 'COMPOSITION_INCOMPLETE',
        edition_date: editionDate, missing,
      }));
      return;
    }

    const { subjectLine, body_md } = buildContent(threats, innovations, growthItem);

    const result = await apiCall('/api/pipeline/briefings', 'POST', {
      edition_date:       editionDate,
      subject_line:       subjectLine,
      body_md,
      threat_item_ids:    threats.map(t => t.source_id),
      innovation_item_ids: innovations.map(i => i.source_id),
      growth_item_id:     growthItem.source_id,
      training_byte_id:   trainingByte.id,
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'ruth', event: 'BRIEFING_SUBMITTED',
      edition_date: editionDate, briefing_id: result.id, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'RUTH_CYCLE_ERROR',
      edition_date: editionDate,
      task_id: task.id,
      error: e.message,
      message: `Ruth runtime error for ${editionDate}: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'ruth', event: 'CYCLE_ERROR',
      edition_date: editionDate, error: e.message,
    }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollRuthTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Ruth'
        AND task_type   = 'daily_cycle'
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeRuthDailyCycle(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'ruth', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollRuthTasks, ensureRuthToken };
