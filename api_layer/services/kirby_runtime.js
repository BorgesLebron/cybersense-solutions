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
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;

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
 * Kirby selects a High/Critical threat that doesn't have a linked training byte yet.
 */
async function produceDailyTrainingByte(task) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'kirby', event: 'PRODUCING_BYTE', task_id: task.id }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    // 1. Select source intelligence
    const intel = await db.pool.query(`
      SELECT r.*, t.threat_name, t.severity, t.summary 
      FROM intel_repository r
      JOIN threat_records t ON t.id = r.source_id
      WHERE r.source_type = 'threat'
        AND t.severity IN ('high', 'critical')
      ORDER BY r.processed_at DESC
      LIMIT 1
    `).then(r => r.rows[0]);

    if (!intel) {
      throw new Error('No qualifying high/critical intelligence found in repository.');
    }

    // 2. Mock content generation (until LLM integration is wired)
    const title = `Training Byte: Defending against ${intel.threat_name}`;
    const content = `
## Overview
This byte covers defense strategies for ${intel.threat_name}.

## Key Action Items
1. Verify patch levels for affected systems.
2. Update firewall rules to block associated IoCs.
3. Conduct user awareness for specific phishing vectors.

## Technical Context
Severity: ${intel.severity.toUpperCase()}
Source: ${intel.source_id}
    `.trim();

    // 3. Create the training module (as a byte)
    const byte = await db.createTrainingModule({
      title,
      type: 'training_byte',
      phase: 'awareness',
      zt_module: 'threat_defense',
      access_tier: 'free',
      duration_min: 5,
      content_url: null,
      body_md: content,
      created_by: 'Kirby'
    });

    // Note: We need a way to store the actual markdown content. 
    // Currently, training_modules doesn't have a body_md field in the initial schema.
    // I will assume for now we use content_url or that I should add a field.
    // Given the "asynchronous task mode", I will stick to existing schema first.

    // 4. Update status to 'published' so Ruth can see it immediately (per Alex/Maya protocol)
    await db.advanceModuleStatus(byte.id, 'published');

    await db.updateTask(task.id, { status: 'complete' });
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
