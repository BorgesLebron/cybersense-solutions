'use strict';

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');
const { postAgentStatusToActiveMeeting } = require('./meetings');

const ACQUISITIONS_SYSTEM_PROMPT = `You are the Acquisitions Editor for CyberSense: Daily Digital Awareness Brief, a daily professional intelligence newsletter focused on workforce cyber awareness, institutional resilience, and human-centric risk. You operate upstream of writing and are responsible for identifying content that is timely, credible, and directly relevant to digital awareness and professional decision-making. Do not generate prose; only provide a structured outline suitable for editorial drafting.

Use the provided Topic Selection to draft the outline for the Daily Digital Awareness Brief.

Draft the training Byte that goes in accordance with the theme of the letter.

Produce a complete Daily Digital Awareness Brief outline that includes:
• A unifying daily theme supported by all selected items
• Select the three recent, compelling, and most relevant to the them for Situational Awareness entries
• One Training Byte explanation with vulnerability and mitigation
• One Career Development entry meeting ROI criteria
• Two Modernization and AI Insight entries

Each selected item must be justified with a one-sentence rationale linking it to the newsletter mission.`;

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
  // Deduplication: hard 30-day lookback — never reuse a byte used in the last 30 days
  // regardless of pool size. Pool-size-relative exclusion caused strict 4-edition
  // rotation when the pool was small.
  const trainingByte = await db.pool.query(`
    SELECT id, title, body_md
    FROM training_modules
    WHERE type = 'training_byte'
      AND pipeline_status = 'published'
      AND id NOT IN (
        SELECT training_byte_id
        FROM briefings
        WHERE training_byte_id IS NOT NULL
          AND edition_date >= CURRENT_DATE - INTERVAL '30 days'
      )
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

// ── LLM acquisitions outline ──────────────────────────────────────────────────

function formatTopicSelection(threats, innovations, growthItem, trainingByte, editionDate) {
  const nd = item => (item && item.normalized_data) || {};
  const lines = [
    `Edition Date: ${editionDate}`,
    '',
    'SITUATIONAL AWARENESS — THREAT INTELLIGENCE:',
    ...threats.map((t, i) => {
      const d = nd(t);
      return [
        `${i + 1}. ${t.title || 'Threat Advisory'}`,
        `   CVE: ${d.cve_id || 'N/A'} | CVSS: ${d.cvss_score || 'N/A'} | Category: ${d.category || 'threat'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
      ].filter(Boolean).join('\n');
    }),
    '',
    'MODERNIZATION AND AI INSIGHT:',
    ...innovations.map((item, i) => {
      const d = nd(item);
      return [
        `${i + 1}. ${item.title || 'Innovation Item'}`,
        `   Category: ${d.category || 'innovation'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
        d.summary   ? `   Summary: ${String(d.summary).slice(0, 250)}` : null,
      ].filter(Boolean).join('\n');
    }),
    '',
    'CAREER DEVELOPMENT / PROFESSIONAL GROWTH:',
    growthItem ? (() => {
      const d = nd(growthItem);
      return [
        `1. ${growthItem.title || 'Growth Item'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
        d.summary   ? `   Summary: ${String(d.summary).slice(0, 250)}` : null,
      ].filter(Boolean).join('\n');
    })() : '(none available)',
    '',
    'TRAINING BYTE — USE THIS CONTENT VERBATIM (do not rewrite or summarize):',
    trainingByte
      ? `Title: ${trainingByte.title}\n\n${trainingByte.body_md}`
      : '(no published byte available — write one aligned to the day\'s SA threats)',
    '',
    '---',
    'After your outline, append one line: SUBJECT: <concise email subject line for this edition, under 60 characters>',
  ];
  return lines.join('\n');
}

async function buildAcquisitionsOutline(threats, innovations, growthItem, trainingByte, editionDate) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: ACQUISITIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formatTopicSelection(threats, innovations, growthItem, trainingByte, editionDate) }],
  });

  const text = (message.content[0]?.text || '').trim();
  const subjectMatch = text.match(/^SUBJECT:\s*(.+)$/m);
  const subjectLine = subjectMatch
    ? subjectMatch[1].trim().slice(0, 120)
    : (threats[0]?.title || `Daily Awareness Brief — ${editionDate}`);
  const body_md = text.replace(/^SUBJECT:.*$/m, '').trimEnd();

  return { subjectLine, body_md };
}

// ── Briefing content builder (scaffold fallback) ──────────────────────────────

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

    // Re-queue whenever the training byte is the only missing item — supports
    // both the scheduled 04:00 CT production path and manual daytime testing.
    if (!trainingByte && missing.length === 1 && missing[0].startsWith('training_byte')) {
      await db.updateTask(task.id, { status: 'queued' });
      console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'AWAITING_TRAINING_BYTE', edition_date: editionDate, retry_after: 'next poll' }));
      return;
    }

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

    let subjectLine, body_md;
    try {
      ({ subjectLine, body_md } = await buildAcquisitionsOutline(threats, innovations, growthItem, trainingByte, editionDate));
      console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'LLM_OUTLINE_GENERATED', edition_date: editionDate }));
    } catch (llmErr) {
      console.warn(JSON.stringify({ ts, runtime: 'ruth', event: 'LLM_FALLBACK', edition_date: editionDate, error: llmErr.message }));
      ({ subjectLine, body_md } = buildContent(threats, innovations, growthItem));
    }

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

    // Post to meeting (Gemma task) — non-critical, must not fail the cycle
    try {
      await postAgentStatusToActiveMeeting('Ruth', 'awareness', {
        event: 'BRIEFING_SUBMITTED',
        edition_date: editionDate,
        briefing_id: result.id,
        threats: threats.length,
        innovations: innovations.length,
        growth: !!growthItem,
        training_byte: !!trainingByte
      });
    } catch (meetingErr) {
      console.warn(JSON.stringify({ ts, runtime: 'ruth', event: 'MEETING_POST_FAILED', error: meetingErr.message }));
    }

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
