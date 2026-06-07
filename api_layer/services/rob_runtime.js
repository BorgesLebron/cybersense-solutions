'use strict';

// services/rob_runtime.js
// Rob's Intel Article EIC runtime. Polls eic_review_article tasks, performs
// final editorial review, updates the article body, and advances to qa
// so Jeff can QA the article.

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');
const { normalizeArticleBodyMarkdown } = require('./article_markdown');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 24;
const ROB_MODEL = process.env.ROB_BRAIN_MODEL || 'claude-haiku-4-5-20251001';

function getRobClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const ROB_SYSTEM_PROMPT = `
You are Rob, the Editor-in-Chief for CyberSense.Solutions Intel Articles.

Your job is final editorial authority before QA. Review Jason's edited article as a complete intelligence product and produce the final internal article version.

Editorial priorities:
- Enforce credibility, proportional judgment, source discipline, and publication identity.
- Tighten redundancy, weak claims, vague recommendations, and tonal drift.
- Preserve technical precision without overstating certainty.
- Ensure the article serves practitioners with operationally useful analysis.
- Apply reputational and legal risk sensitivity for breaches, named vendors, regulators, and government activity.
- Do not add unsupported facts or invent citations.

Required article structure:
- Executive Summary
- What Happened
- Why It Matters
- Operational Implications
- Recommended Actions
- Closing Assessment

The article title is stored separately. Do not repeat it as a level-one heading in the body. Begin with ## Executive Summary. Use a numbered Markdown list for Recommended Actions. Output only the final article in Markdown. Do not include meta-commentary, edit notes, explanations, or internal workflow references.
`.trim();

function buildRobPrompt(article) {
  return `
Article ID: ${article.id}
Current title: ${article.title}
Section: ${article.section}
Access tier: ${article.access_tier}

Jason-edited draft:
${article.body_md}
`.trim();
}

function validateFinalIntelArticle(text) {
  const issues = [];
  const body = (text || '').trim();
  if (body.length < 700) issues.push('LLM final article too short for Intel EIC approval');

  ['Executive Summary', 'What Happened', 'Why It Matters', 'Operational Implications', 'Recommended Actions']
    .forEach(section => {
      if (!body.toLowerCase().includes(section.toLowerCase())) {
        issues.push(`LLM final article missing ${section} section`);
      }
    });

  if (/^(sure|certainly|here is|below is)\b/i.test(body)) {
    issues.push('LLM final article contains conversational preamble');
  }

  return issues;
}

let _robToken = null;

async function ensureRobToken() {
  if (_robToken) {
    try {
      jwt.verify(_robToken, process.env.AGENT_JWT_SECRET);
      return _robToken;
    } catch (_) {
      // Token expired or invalid.
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Rob', agent_team: 'intel' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Rob', hash);
  _robToken = token;
  return token;
}

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureRobToken();
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

async function applyRobReview(article) {
  const issues = [];
  if (!article.body_md || article.body_md.trim().length < 100) issues.push('body_md too short or empty');
  if (!article.title || article.title.trim().length === 0) issues.push('title missing');
  if (!article.section) issues.push('section missing');
  if (issues.length > 0) return { issues };

  const msg = await getRobClient().messages.create({
    model:      ROB_MODEL,
    max_tokens: 2048,
    system:     ROB_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: buildRobPrompt(article) }],
  });
  const text = (msg.content[0]?.text || '').trim();

  const body_md = normalizeArticleBodyMarkdown((text || '').trim(), article.title);
  const llmIssues = validateFinalIntelArticle(body_md);
  if (llmIssues.length > 0) return { issues: llmIssues };

  return { issues: [], body_md };
}

async function executeRobEICReview(task) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'rob', event: 'EIC_REVIEW_START', task_id: task.id, content_id: task.content_id }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const article = await db.getArticleById(task.content_id);
    if (!article) throw new Error(`Article ${task.content_id} not found`);

    if (article.pipeline_status !== 'dev_edit') {
      await db.updateTask(task.id, { status: 'complete' });
      console.log(JSON.stringify({ ts, runtime: 'rob', event: 'SKIP_WRONG_STATUS', article_id: article.id, pipeline_status: article.pipeline_status }));
      return;
    }

    const { issues, body_md } = await applyRobReview(article);
    if (issues.length > 0) {
      const error_message = `Intel EIC review blocked: ${issues.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'ROB_EIC_REVIEW_BLOCKED',
        article_id: article.id,
        title: article.title,
        task_id: task.id,
        issues,
        message: `Rob cannot complete Intel EIC review for "${article.title}" - ${error_message}.`,
      });
      return;
    }

    await updateArticleBody(article.id, body_md);
    await apiCall(`/api/pipeline/articles/${article.id}/status`, 'PATCH', {
      to_status: 'eic_review',
      agent_name: 'Rob',
      notes: 'Intel EIC review complete. LLM final editorial review applied and article passed Rob review.',
    });

    await db.updateTask(task.id, { status: 'complete' });
    console.log(JSON.stringify({ ts, runtime: 'rob', event: 'EIC_REVIEW_COMPLETE', article_id: article.id, task_id: task.id }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'ROB_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Rob runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({ ts, runtime: 'rob', event: 'RUNTIME_ERROR', task_id: task.id, error: e.message }));
  }
}

async function pollRobTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Rob'
        AND task_type = 'eic_review_article'
        AND content_type = 'article'
        AND status IN ('queued', 'escalated')
        AND started_at > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeRobEICReview(task);
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), runtime: 'rob', event: 'POLL_ERROR', error: e.message }));
  }
}

module.exports = {
  pollRobTasks,
  ensureRobToken,
  executeRobEICReview,
  applyRobReview,
  buildRobPrompt,
  validateFinalIntelArticle,
  ROB_SYSTEM_PROMPT,
};
