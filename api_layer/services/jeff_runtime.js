'use strict';

// services/jeff_runtime.js
// Jeff's QA runtime. Polls agent_tasks for briefing and article QA tasks,
// performs deterministic QA checks, and advances content to the qa stage.
//
// Token strategy: mirrors ruth_runtime.js — self-provisions a fresh JWT at
// startup, stores the hash in agent_tokens. Requires AGENT_JWT_SECRET and
// API_BASE_URL in env.
//
// Run within the main server process — triggered manually or by scheduler.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');
const { validateArticleMarkdown } = require('./article_markdown');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;

// ── Token management ─────────────────────────────────────────────────────────

let _jeffToken = null;

async function ensureJeffToken() {
  if (_jeffToken) {
    try {
      jwt.verify(_jeffToken, process.env.AGENT_JWT_SECRET);
      return _jeffToken;
    } catch (_) {}
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Jeff', agent_team: 'awareness' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Jeff', hash);
  _jeffToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureJeffToken();
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

async function getBriefingForQA(contentId) {
  return db.pool.query(
    `SELECT id, edition_date, subject_line, body_md, pipeline_status,
            threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id
     FROM briefings WHERE id = $1`,
    [contentId]
  ).then(r => r.rows[0] || null);
}

async function getArticleForQA(contentId) {
  return db.pool.query(
    `SELECT id, title, section, body_md, pipeline_status, access_tier
     FROM articles WHERE id = $1`,
    [contentId]
  ).then(r => r.rows[0] || null);
}

// ── QA review ─────────────────────────────────────────────────────────────────

function applyQAReview(briefing) {
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

function applyArticleQAReview(article) {
  const issues = [];

  if (!article.title || article.title.trim().length === 0)
    issues.push('title missing');

  if (!article.body_md || article.body_md.trim().length < 700)
    issues.push('body_md too short for Intel article QA');

  ['Executive Summary', 'What Happened', 'Why It Matters', 'Operational Implications', 'Recommended Actions']
    .forEach(section => {
      if (!String(article.body_md || '').toLowerCase().includes(section.toLowerCase())) {
        issues.push(`missing ${section} section`);
      }
    });

  if (!['threat', 'policy', 'innovation', 'growth', 'training'].includes(article.section))
    issues.push(`invalid section ${article.section || '(empty)'}`);

  issues.push(...validateArticleMarkdown(article.body_md, article.title));

  return { issues };
}

// ── Task execution ────────────────────────────────────────────────────────────

async function executeJeffQA(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'jeff', event: 'QA_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const briefing = await getBriefingForQA(task.content_id);
    if (!briefing) {
      throw new Error(`Briefing ${task.content_id} not found`);
    }

    if (briefing.pipeline_status !== 'eic_review') {
      console.log(JSON.stringify({
        ts, runtime: 'jeff', event: 'SKIP_WRONG_STATUS',
        briefing_id: briefing.id, pipeline_status: briefing.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    const { issues } = applyQAReview(briefing);

    if (issues.length > 0) {
      const error_message = `QA blocked — issues: ${issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'JEFF_QA_BLOCKED',
        briefing_id: briefing.id,
        edition_date: briefing.edition_date,
        task_id: task.id,
        issues,
        message: `Jeff cannot complete QA for ${briefing.edition_date} — ${error_message}.`,
      });
      console.warn(JSON.stringify({
        ts, runtime: 'jeff', event: 'QA_BLOCKED',
        briefing_id: briefing.id, issues,
      }));
      return;
    }

    await apiCall(`/api/pipeline/briefings/${briefing.id}/status`, 'PATCH', {
      to_status:  'qa',
      agent_name: 'Jeff',
      notes:      `QA complete. Composition verified: ${briefing.threat_item_ids.length} threats, ${briefing.innovation_item_ids.length} innovations, 1 growth, 1 training byte. Subject line and body confirmed.`,
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'jeff', event: 'QA_COMPLETE',
      briefing_id: briefing.id, edition_date: briefing.edition_date, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'JEFF_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Jeff runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'jeff', event: 'RUNTIME_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

async function executeJeffArticleQA(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'jeff', event: 'ARTICLE_QA_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const article = await getArticleForQA(task.content_id);
    if (!article) {
      throw new Error(`Article ${task.content_id} not found`);
    }

    if (article.pipeline_status !== 'eic_review') {
      console.log(JSON.stringify({
        ts, runtime: 'jeff', event: 'SKIP_WRONG_ARTICLE_STATUS',
        article_id: article.id, pipeline_status: article.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    const { issues } = applyArticleQAReview(article);

    if (issues.length > 0) {
      const error_message = `Article QA blocked - issues: ${issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'JEFF_ARTICLE_QA_BLOCKED',
        article_id: article.id,
        title: article.title,
        task_id: task.id,
        issues,
        message: `Jeff cannot complete Intel article QA for "${article.title}" - ${error_message}.`,
      });
      console.warn(JSON.stringify({
        ts, runtime: 'jeff', event: 'ARTICLE_QA_BLOCKED',
        article_id: article.id, issues,
      }));
      return;
    }

    await apiCall(`/api/pipeline/articles/${article.id}/status`, 'PATCH', {
      to_status:  'qa',
      agent_name: 'Jeff',
      notes:      'Article QA complete. Required Intel article sections, title, section, and body depth verified.',
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'jeff', event: 'ARTICLE_QA_COMPLETE',
      article_id: article.id, task_id: task.id,
    }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'JEFF_ARTICLE_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Jeff article QA runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'jeff', event: 'ARTICLE_QA_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollJeffTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Jeff'
        AND task_type   IN ('qa_briefing', 'qa_article')
        AND status      IN ('queued', 'escalated')
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 3
    `).then(r => r.rows);

    for (const task of tasks) {
      if (task.task_type === 'qa_article') {
        await executeJeffArticleQA(task);
      } else {
        await executeJeffQA(task);
      }
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'jeff', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollJeffTasks, ensureJeffToken, executeJeffArticleQA, applyArticleQAReview };
