'use strict';

/**
 * api_layer/services/kirby_runtime.js
 * Kirby's training content production runtime.
 * 
 * Kirby (Instructional Designer) is responsible for:
 * 1. Daily Training Byte (150-250 words) - Required for Ruth's Awareness cycle.
 * 2. Training Modules and Simulation Scenarios.
 * 
 * Kirby polls agent_tasks for 'production' tasks and listens for signals.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { google } = require('@ai-sdk/google');
const { generateText } = require('ai');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;

// ── LLM Configuration ────────────────────────────────────────────────────────

function getKirbyBrain() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('MISSING_GOOGLE_API_KEY: Kirby cannot function without his LLM brain.');
  }
  return google('gemini-1.5-flash');
}

const KIRBY_SYSTEM_PROMPT = `
You are Kirby, the Lead Instructional Designer at CyberSense.Solutions. 
Your goal is to transform complex technical threat intelligence into concise, actionable "Daily Training Bytes" for a professional workforce.

VOICE AND TONE:
- Professional, authoritative, and security-focused.
- Direct and unsensational.
- Clear and jargon-aware (explain acronyms if they are obscure).

STRUCTURE OF A TRAINING BYTE (Markdown):
1. ## Why This Matters: A 2-sentence explanation of the business/operational impact.
2. ## What You Need to Know: 3-4 bullet points explaining the core technical threat or vulnerability.
3. ## Defensive Actions: 3 specific, actionable steps for security teams or end-users.
4. ## Knowledge Check: A single multiple-choice question with 3 options and the correct answer hidden below.

CONSTRAINTS:
- Word count: 150-250 words.
- Format: Strictly Markdown.
- No conversational filler (e.g., "Certainly!", "Here is your byte"). Start directly with the content.
- Focus on ACTION. Every byte must tell the reader what to DO.
`.trim();

// ── Token management ─────────────────────────────────────────────────────────

let _kirbyToken = null;

async function ensureKirbyToken() {
  if (_kirbyToken) {
    try {
      jwt.verify(_kirbyToken, process.env.AGENT_JWT_SECRET);
      return _kirbyToken;
    } catch (_) {
      // Token expired or invalid
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Kirby', agent_team: 'training' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Kirby', hash);
  _kirbyToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureKirbyToken();
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

// ── Content Production Logic ──────────────────────────────────────────────────

/**
 * Generates a Training Byte based on a threat repository item.
 * Kirby prioritizes threats already selected for the day's briefing for thematic alignment.
 */
async function produceDailyTrainingByte(task) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'kirby', event: 'PRODUCING_BYTE', task_id: task.id }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    // 1. Select source intelligence (Thematic Alignment)
    // We look for the most recent draft/published briefing to see what threats are being highlighted.
    const briefing = await db.pool.query(`
      SELECT * FROM briefings 
      WHERE pipeline_status IN ('draft', 'dev_edit', 'eic_review', 'published')
      ORDER BY edition_date DESC, created_at DESC
      LIMIT 1
    `).then(r => r.rows[0]);

    let sourceIntel = null;

    if (briefing && briefing.threat_item_ids && briefing.threat_item_ids.length > 0) {
      // Pick one of the threats from the briefing
      sourceIntel = await db.pool.query(`
        SELECT r.*, t.threat_name, t.severity, t.summary, r.normalized_data
        FROM intel_repository r
        JOIN threat_records t ON t.id = r.source_id
        WHERE r.source_id = ANY($1::uuid[])
        LIMIT 1
      `, [briefing.threat_item_ids]).then(r => r.rows[0]);
    }

    // Fallback if no briefing found or no threats in it
    if (!sourceIntel) {
      sourceIntel = await db.pool.query(`
        SELECT r.*, t.threat_name, t.severity, t.summary, r.normalized_data
        FROM intel_repository r
        JOIN threat_records t ON t.id = r.source_id
        WHERE r.source_type = 'threat'
          AND t.severity IN ('high', 'critical')
        ORDER BY r.processed_at DESC
        LIMIT 1
      `).then(r => r.rows[0]);
    }

    if (!sourceIntel) {
      throw new Error('No qualifying intelligence found for training byte generation.');
    }

    // 2. Generate content with LLM
    const brain = getKirbyBrain();
    const prompt = `
      THREAT DATA:
      Name: ${sourceIntel.threat_name}
      Severity: ${sourceIntel.severity.toUpperCase()}
      Summary: ${sourceIntel.summary}
      Raw Details: ${JSON.stringify(sourceIntel.normalized_data || {})}

      Task: Generate a Daily Training Byte based on this threat.
    `;

    const { text } = await generateText({
      model: brain,
      system: KIRBY_SYSTEM_PROMPT,
      prompt: prompt,
    });

    // 3. Create the training module
    const title = `Training Byte: ${sourceIntel.threat_name}`;
    const byte = await db.createTrainingModule({
      title,
      type: 'training_byte',
      phase: 'awareness',
      zt_module: 'threat_defense',
      access_tier: 'free',
      duration_min: 5,
      content_url: null,
      body_md: text.trim(),
      created_by: 'Kirby'
    });

    // 4. Update status and notify
    await db.advanceModuleStatus(byte.id, 'published');
    await db.updateTask(task.id, { status: 'complete', metadata: { byte_id: byte.id, source_id: sourceIntel.source_id } });
    
    console.log(JSON.stringify({ ts, runtime: 'kirby', event: 'BYTE_PUBLISHED', byte_id: byte.id }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    console.error(JSON.stringify({ ts, runtime: 'kirby', event: 'PRODUCTION_ERROR', error: e.message }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollKirbyTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Kirby'
        AND task_type   = 'production'
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      if (task.content_type === 'training_byte') {
        await produceDailyTrainingByte(task);
      }
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'kirby', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollKirbyTasks, ensureKirbyToken };
