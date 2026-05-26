'use strict';

// services/james_runtime.js
// James's Intel Article acquisition/runtime. Converts ready-for-intel repository
// items into draft articles, then lets Jason -> Rob -> Jeff -> Maya continue.

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const POLL_WINDOW_HOURS = 24;
const JAMES_MODEL = process.env.JAMES_BRAIN_MODEL || 'claude-sonnet-4-6';

function getJamesClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const JAMES_SYSTEM_PROMPT = `
You are James, the Acquisitions Writer for CyberSense.Solutions Intel Articles.

Your job is to turn one normalized repository item into a disciplined practitioner-grade intelligence article. Write in the same editorial family as "Verifiable Credentials Need Operational Trust, Not Just Wallet Support": sober, operational, evidence-aware, and useful to security professionals and institutional leaders.

Editorial priorities:
- Use only the provided repository facts and source context.
- Do not invent sources, quotes, dates, vendors, incidents, metrics, or regulatory claims.
- Explain operational trust, implementation risk, workforce impact, governance, or platform implications where relevant.
- Avoid hype, fear framing, and generic summaries.
- Prefer "threat actors", "cybercriminals", or "actors" over "attacker".

Required article structure:
- Title
- Executive Summary
- What Happened
- Why It Matters
- Operational Implications
- Recommended Actions
- Closing Assessment

Output only the draft article in Markdown. Do not include meta-commentary, source notes, or internal workflow references.
`.trim();

function buildJamesPrompt(item) {
  return `
Repository ID: ${item.repository_id}
Source ID: ${item.source_id}
Source type: ${item.source_type}
Suggested section: ${item.section}
Working title: ${item.title}
Category: ${item.category || 'N/A'}
Priority: ${item.priority || 'N/A'}
Tags: ${(item.tags || []).join(', ') || 'none'}
Source URL: ${item.source_url || 'N/A'}

Source summary:
${item.summary || 'No source summary provided.'}

Normalized data:
${JSON.stringify(item.normalized_data || {}, null, 2)}
`.trim();
}

function extractArticleTitle(body_md, fallback) {
  const match = String(body_md || '').match(/^#\s+(.+)$/m);
  return (match?.[1] || fallback || 'CyberSense Intel Article').trim().slice(0, 140);
}

function validateJamesDraft(text) {
  const issues = [];
  const body = (text || '').trim();
  if (body.length < 700) issues.push('LLM article draft too short for Intel acquisition');

  ['Executive Summary', 'What Happened', 'Why It Matters', 'Operational Implications', 'Recommended Actions']
    .forEach(section => {
      if (!body.toLowerCase().includes(section.toLowerCase())) {
        issues.push(`LLM article draft missing ${section} section`);
      }
    });

  if (/^(sure|certainly|here is|below is)\b/i.test(body)) {
    issues.push('LLM article draft contains conversational preamble');
  }

  return issues;
}

let _jamesToken = null;

async function ensureJamesToken() {
  if (_jamesToken) {
    try {
      jwt.verify(_jamesToken, process.env.AGENT_JWT_SECRET);
      return _jamesToken;
    } catch (_) {
      // Token expired or invalid.
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'James', agent_team: 'intel' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('James', hash);
  _jamesToken = token;
  return token;
}

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureJamesToken();
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
    const detail = json.error?.message || json.error?.code || json.message || JSON.stringify(json);
    throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}

function normalizeCandidate(row) {
  const normalized = row.normalized_data || {};
  const source = row.source_data || {};
  const sourceType = row.source_type === 'policy' ? 'innovation' : row.source_type;

  return {
    repository_id: row.repository_id,
    source_id: row.source_id,
    source_type: row.source_type,
    section: sourceType === 'threat' ? 'threat' : sourceType,
    title: row.title || normalized.title || source.headline || source.threat_name || 'CyberSense Intel Article',
    category: row.category || normalized.category || source.category || row.source_type,
    summary: row.summary || normalized.summary || source.summary || source.raw_data || '',
    source_url: row.source_url || normalized.source_url || source.source_url || null,
    tags: Array.isArray(row.tags) ? row.tags : (Array.isArray(normalized.tags) ? normalized.tags : []),
    priority: row.priority || normalized.priority || source.priority || null,
    normalized_data: normalized,
  };
}

async function getNextIntelArticleCandidate() {
  const row = await db.pool.query(`
    SELECT r.id AS repository_id,
           r.source_id,
           r.source_type,
           r.normalized_data,
           r.correlation_tags,
           r.processed_at,
           CASE r.source_type
             WHEN 'threat' THEN t.threat_name
             ELSE i.headline
           END AS title,
           CASE r.source_type
             WHEN 'threat' THEN t.category
             ELSE i.category
           END AS category,
           CASE r.source_type
             WHEN 'threat' THEN t.raw_data::text
             ELSE i.summary
           END AS summary,
           CASE r.source_type
             WHEN 'threat' THEN t.source_url
             ELSE NULL
           END AS source_url,
           CASE r.source_type
             WHEN 'threat' THEN t.tags
             ELSE i.tags
           END AS tags,
           CASE r.source_type
             WHEN 'threat' THEN t.priority::text
             ELSE i.priority::text
           END AS priority,
           jsonb_build_object(
             'headline', i.headline,
             'summary', i.summary,
             'category', i.category,
             'priority', i.priority,
             'threat_name', t.threat_name,
             'raw_data', t.raw_data,
             'source_url', t.source_url
           ) AS source_data
    FROM intel_repository r
    LEFT JOIN intel_items i ON i.id = r.source_id AND r.source_type IN ('innovation','growth','policy')
    LEFT JOIN threat_records t ON t.id = r.source_id AND r.source_type = 'threat'
    WHERE r.ready_for_intel = true
      AND r.source_type IN ('innovation','growth','policy','threat')
      AND COALESCE(i.article_id, t.article_id) IS NULL
    ORDER BY CASE r.source_type
      WHEN 'threat'     THEN 1
      WHEN 'innovation' THEN 1
      WHEN 'growth'     THEN 1
      WHEN 'policy'     THEN 2
      ELSE 3
    END, r.processed_at ASC
    LIMIT 1
  `).then(r => r.rows[0] || null);

  return row ? normalizeCandidate(row) : null;
}

async function applyJamesDraft(item) {
  const msg = await getJamesClient().messages.create({
    model:      JAMES_MODEL,
    max_tokens: 2048,
    system:     JAMES_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: buildJamesPrompt(item) }],
  });
  const text = (msg.content[0]?.text || '').trim();

  const body_md = (text || '').trim();
  const issues = validateJamesDraft(body_md);
  if (issues.length > 0) return { issues };

  return {
    issues: [],
    title: extractArticleTitle(body_md, item.title),
    section: item.section,
    access_tier: 'monthly',
    body_md,
    source_ids: [item.source_id],
  };
}

async function executeJamesDraftArticle(task) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'james', event: 'DRAFT_START', task_id: task.id }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const item = await getNextIntelArticleCandidate();
    if (!item) {
      await db.updateTask(task.id, { status: 'complete' });
      console.log(JSON.stringify({ ts, runtime: 'james', event: 'NO_CANDIDATE', task_id: task.id }));
      return;
    }

    const draft = await applyJamesDraft(item);
    if (draft.issues.length > 0) {
      const error_message = `Intel article draft blocked: ${draft.issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'JAMES_ARTICLE_DRAFT_BLOCKED',
        source_id: item.source_id,
        source_type: item.source_type,
        task_id: task.id,
        issues: draft.issues,
        message: `James cannot draft Intel article from "${item.title}" - ${error_message}.`,
      });
      return;
    }

    const article = await apiCall('/api/pipeline/articles', 'POST', draft);
    await db.updateTask(task.id, { status: 'complete' });
    console.log(JSON.stringify({ ts, runtime: 'james', event: 'DRAFT_COMPLETE', article_id: article.id, source_id: item.source_id, task_id: task.id }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'JAMES_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `James runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({ ts, runtime: 'james', event: 'RUNTIME_ERROR', task_id: task.id, error: e.message }));
  }
}

async function pollJamesTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'James'
        AND task_type = 'draft_article'
        AND content_type = 'system'
        AND status IN ('queued', 'escalated')
        AND started_at > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeJamesDraftArticle(task);
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), runtime: 'james', event: 'POLL_ERROR', error: e.message }));
  }
}

module.exports = {
  pollJamesTasks,
  ensureJamesToken,
  getNextIntelArticleCandidate,
  applyJamesDraft,
  buildJamesPrompt,
  validateJamesDraft,
  JAMES_SYSTEM_PROMPT,
  ZERO_UUID,
};
