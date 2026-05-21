'use strict';

// services/jason_runtime.js
// Jason's Intel Article developmental editor runtime. Polls article dev_edit
// tasks, applies an LLM structural edit, updates the article body, and advances
// the article to dev_edit so Rob can perform EIC review.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { generateText } = require('ai');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 24;
const DEFAULT_BRAIN_MODEL = 'gemini-2.5-flash';

function getJasonBrain() {
  const apiKey = process.env.JASON_BRAIN_API_KEY ||
    process.env.INTEL_EDITORIAL_BRAIN_API_KEY ||
    process.env.EDITORIAL_BRAIN_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    throw new Error('MISSING_JASON_BRAIN_API_KEY: Jason cannot perform Intel developmental editing without an LLM brain.');
  }

  const googleAI = createGoogleGenerativeAI({ apiKey });
  return googleAI(process.env.JASON_BRAIN_MODEL || process.env.INTEL_EDITORIAL_BRAIN_MODEL || process.env.EDITORIAL_BRAIN_MODEL || DEFAULT_BRAIN_MODEL);
}

const JASON_SYSTEM_PROMPT = `
You are Jason, the Developmental Editor for CyberSense.Solutions Intel Articles.

Your job is to transform James's draft into a coherent practitioner-grade intelligence article for security professionals, technologists, policy-aware operators, and institutional leaders.

Editorial priorities:
- Preserve source discipline and do not introduce unsupported claims.
- Strengthen structure, transitions, sequencing, and analytical flow.
- Calibrate technical density for practitioners without drifting into vendor hype.
- Explain why the issue matters operationally, not just what happened.
- Keep tone disciplined, neutral, and unsensational.
- Prefer "threat actors", "cybercriminals", or "actors" over "attacker".

Required article structure:
- Title
- Executive Summary
- What Happened
- Why It Matters
- Operational Implications
- Recommended Actions
- Closing Assessment

Output only the revised article in Markdown. Do not include meta-commentary, edit notes, or internal workflow references.
`.trim();

function buildJasonPrompt(article) {
  return `
Article ID: ${article.id}
Current title: ${article.title}
Section: ${article.section}
Access tier: ${article.access_tier}

James draft:
${article.body_md}
`.trim();
}

function validateIntelArticleDraft(text) {
  const issues = [];
  const body = (text || '').trim();
  if (body.length < 700) issues.push('LLM article draft too short for Intel developmental edit');

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

let _jasonToken = null;

async function ensureJasonToken() {
  if (_jasonToken) {
    try {
      jwt.verify(_jasonToken, process.env.AGENT_JWT_SECRET);
      return _jasonToken;
    } catch (_) {
      // Token expired or invalid.
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Jason', agent_team: 'intel' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Jason', hash);
  _jasonToken = token;
  return token;
}

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureJasonToken();
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

async function updateArticleBody(id, body_md) {
  return db.pool.query(
    `UPDATE articles
     SET body_md=$2,
         read_time_min=GREATEST(1, ROUND(array_length(regexp_split_to_array(trim($2),E'\\\\s+'),1)/200.0))
     WHERE id=$1
     RETURNING *`,
    [id, body_md]
  ).then(r => r.rows[0] || null);
}

async function applyJasonEdit(article) {
  const issues = [];
  if (!article.body_md || article.body_md.trim().length < 100) issues.push('body_md too short or empty');
  if (!article.title || article.title.trim().length === 0) issues.push('title missing');
  if (!article.section) issues.push('section missing');
  if (issues.length > 0) return { issues };

  const { text } = await generateText({
    model: getJasonBrain(),
    system: JASON_SYSTEM_PROMPT,
    prompt: buildJasonPrompt(article),
  });

  const body_md = (text || '').trim();
  const llmIssues = validateIntelArticleDraft(body_md);
  if (llmIssues.length > 0) return { issues: llmIssues };

  return { issues: [], body_md };
}

async function executeJasonDevEdit(task) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'jason', event: 'DEV_EDIT_START', task_id: task.id, content_id: task.content_id }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const article = await db.getArticleById(task.content_id);
    if (!article) throw new Error(`Article ${task.content_id} not found`);

    if (article.pipeline_status !== 'draft') {
      await db.updateTask(task.id, { status: 'complete' });
      console.log(JSON.stringify({ ts, runtime: 'jason', event: 'SKIP_WRONG_STATUS', article_id: article.id, pipeline_status: article.pipeline_status }));
      return;
    }

    const { issues, body_md } = await applyJasonEdit(article);
    if (issues.length > 0) {
      const error_message = `Intel developmental edit blocked: ${issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'JASON_DEV_EDIT_BLOCKED',
        article_id: article.id,
        title: article.title,
        task_id: task.id,
        issues,
        message: `Jason cannot complete Intel developmental edit for "${article.title}" - ${error_message}.`,
      });
      return;
    }

    await updateArticleBody(article.id, body_md);
    await apiCall(`/api/pipeline/articles/${article.id}/status`, 'PATCH', {
      to_status: 'dev_edit',
      agent_name: 'Jason',
      notes: 'Intel developmental edit complete. LLM structural edit applied and article passed Jason review.',
    });

    await db.updateTask(task.id, { status: 'complete' });
    console.log(JSON.stringify({ ts, runtime: 'jason', event: 'DEV_EDIT_COMPLETE', article_id: article.id, task_id: task.id }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'JASON_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Jason runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({ ts, runtime: 'jason', event: 'RUNTIME_ERROR', task_id: task.id, error: e.message }));
  }
}

async function pollJasonTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Jason'
        AND task_type = 'dev_edit'
        AND content_type = 'article'
        AND status IN ('queued', 'escalated')
        AND started_at > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeJasonDevEdit(task);
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), runtime: 'jason', event: 'POLL_ERROR', error: e.message }));
  }
}

module.exports = {
  pollJasonTasks,
  ensureJasonToken,
  applyJasonEdit,
  buildJasonPrompt,
  validateIntelArticleDraft,
  JASON_SYSTEM_PROMPT,
};
