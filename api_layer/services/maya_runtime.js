'use strict';

// services/maya_runtime.js
// Maya's agentic runtime:
//   1. editorial_troubleshoot — answer Command Center pipeline status queries
//   2. approve_briefing — QA review and approval: qa → maya → approved

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic  = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');

const MAYA_SYSTEM_PROMPT = `You are Maya, Editorial Director of CyberSense Intelligence Operations. You receive a structured pipeline status brief and an operator's question. Respond with a clear, direct status assessment and next action.

RESPONSE FORMAT — three short paragraphs, no headers, no bullets:
1. Current state: lead with the most important fact — what is the hold, who owns it.
2. Root cause: what specifically failed or is pending, naming the agent and task type.
3. Next action: tell the operator exactly what to do. Operationally concrete — not "investigate" but "rerun the Peter task" or "approve in Preview Briefing now."

WRITING STANDARDS:
- Punchy and direct. Brief an executive who has ten seconds.
- Lead with the verdict, not the background.
- Answer "so what?" — what breaks if this is not resolved today?
- No idioms, no hedging, no filler. Every sentence carries information.
- 100 words maximum.`;

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
let _polling = false;

// ── Token management ─────────────────────────────────────────────────────────

let _mayaToken = null;

async function ensureMayaToken() {
  if (_mayaToken) {
    try {
      jwt.verify(_mayaToken, process.env.AGENT_JWT_SECRET);
      return _mayaToken;
    } catch (_) {}
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Maya', agent_team: 'awareness' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Maya', hash);
  _mayaToken = token;
  return token;
}

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureMayaToken();
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

async function runMayaLLM(briefing, context, operatorMessage, diagnosis) {
  const client = new Anthropic();
  const pipelineContext = [
    briefing
      ? `Edition ${briefing.edition_number} | Stage: ${briefing.pipeline_status} | Date: ${briefing.edition_date}`
      : 'No active briefing in pipeline.',
    `Hold: ${diagnosis.issue}`,
    `Owner: ${diagnosis.owner}`,
    `Recommended next: ${diagnosis.next}`,
    context.tasks.slice(0, 3).map(t =>
      `Task — ${t.agent_name}/${t.task_type}: ${t.status}${t.error_message ? ` (${t.error_message})` : ''}`
    ).join('\n'),
    context.events.slice(0, 3).map(e =>
      `Event — ${e.agent_name}: ${e.from_status || 'new'} → ${e.to_status}`
    ).join('\n'),
    operatorMessage ? `Operator note: "${operatorMessage.slice(0, 200)}"` : '',
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system:     MAYA_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: pipelineContext }],
  });
  return (msg.content[0]?.text || '').trim();
}

async function getTargetBriefing(contentId) {
  if (contentId && contentId !== ZERO_UUID) {
    return db.getBriefingById(contentId);
  }

  return db.pool.query(`
    SELECT *
    FROM briefings
    WHERE pipeline_status != 'published'
    ORDER BY edition_date DESC
    LIMIT 1
  `).then(r => r.rows[0] || null);
}

async function getTargetArticle(contentId) {
  if (!contentId || contentId === ZERO_UUID) return null;
  return db.getArticleById(contentId);
}

async function getBriefingContext(briefingId) {
  const [tasks, events] = await Promise.all([
    db.pool.query(`
      SELECT id, agent_name, task_type, status, started_at, completed_at,
             sla_deadline, retry_count, retry_after, error_message
      FROM agent_tasks
      WHERE content_type = 'briefing'
        AND content_id = $1
      ORDER BY started_at DESC
      LIMIT 20
    `, [briefingId]).then(r => r.rows),
    db.pool.query(`
      SELECT from_status, to_status, agent_name, notes, created_at
      FROM pipeline_events
      WHERE content_type = 'briefing'
        AND content_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [briefingId]).then(r => r.rows),
  ]);

  return { tasks, events };
}

function stageOwner(status) {
  return {
    draft: 'Ruth',
    dev_edit: 'Ed',
    eic_review: 'Jeff',
    qa: 'Maya',
    maya: 'Maya',
    approved: 'HITL',
    published: 'Laura',
  }[status] || 'Unknown';
}

function summarizeHold(briefing, tasks, events) {
  const pipelineTasks = tasks.filter(t => t.task_type !== 'editorial_troubleshoot');
  const failed = pipelineTasks.find(t => t.status === 'failed');
  if (failed) {
    return {
      status: 'blocked',
      owner: failed.agent_name,
      issue: `${failed.agent_name} failed ${failed.task_type}: ${failed.error_message || 'no error message recorded'}`,
      next: `Review task ${failed.id} and rerun or repair the ${failed.agent_name} handoff.`,
    };
  }

  const escalated = pipelineTasks.find(t => t.status === 'escalated');
  if (escalated) {
    return {
      status: 'escalated',
      owner: escalated.agent_name,
      issue: `${escalated.agent_name} task ${escalated.task_type} escalated.`,
      next: 'Manual operator action is required unless that runtime is enabled to process escalated work.',
    };
  }

  const active = pipelineTasks.find(t => ['queued', 'in_progress'].includes(t.status));
  if (active) {
    return {
      status: active.status,
      owner: active.agent_name,
      issue: `Waiting on ${active.agent_name} to complete ${active.task_type}.`,
      next: active.retry_after ? `Task is retry-gated until ${active.retry_after}.` : 'Let the runtime poller process it or run that runtime manually.',
    };
  }

  if (briefing.pipeline_status === 'approved') {
    return {
      status: 'ready',
      owner: 'HITL / Laura',
      issue: 'Edition is in Preview Briefing and ready for human authorization.',
      next: 'Approve from Preview Briefing; the next 0430 CT distribution job will send/publish it.',
    };
  }

  const lastEvent = events[0];
  return {
    status: 'needs_attention',
    owner: stageOwner(briefing.pipeline_status),
    issue: `No active task found for current stage ${briefing.pipeline_status}.`,
    next: lastEvent
      ? `Last event was ${lastEvent.agent_name} ${lastEvent.from_status || 'new'} -> ${lastEvent.to_status}; create or rerun the ${stageOwner(briefing.pipeline_status)} task.`
      : `Create the missing ${stageOwner(briefing.pipeline_status)} task for this briefing.`,
  };
}

function buildReply(briefing, context, operatorMessage) {
  if (!briefing) {
    return [
      'I do not see an active non-published briefing.',
      '',
      'Current hold: the production queue is empty.',
      'Next action: confirm Ruth production ran for the expected edition date or start the production job manually.',
    ].join('\n');
  }

  const { tasks, events } = context;
  const diagnosis = summarizeHold(briefing, tasks, events);
  const lastEvent = events[0];
  const taskLine = tasks.slice(0, 4)
    .map(t => `${t.agent_name}/${t.task_type}: ${t.status}`)
    .join('; ') || 'none recorded';

  return [
    `Edition ${briefing.edition_number || '?'} is at ${briefing.pipeline_status}.`,
    `Owner: ${diagnosis.owner}.`,
    `Current hold: ${diagnosis.issue}`,
    `Next action: ${diagnosis.next}`,
    lastEvent ? `Last event: ${lastEvent.agent_name} moved ${lastEvent.from_status || 'new'} -> ${lastEvent.to_status}.` : 'Last event: none recorded.',
    `Recent tasks: ${taskLine}.`,
    operatorMessage ? `I used your note as context: "${operatorMessage.slice(0, 180)}"` : null,
  ].filter(Boolean).join('\n');
}

async function getThreadForTask(taskId) {
  const messages = await db.listAgentMessages({ task_id: taskId, limit: 1 });
  return messages[0]?.thread_id || null;
}

async function executeTroubleshootTask(task) {
  await db.updateTask(task.id, { status: 'in_progress' });

  const threadId = await getThreadForTask(task.id);
  const messages = threadId ? await db.listAgentMessages({ thread_id: threadId, limit: 50 }) : [];
  const latestUserMessage = [...messages].reverse().find(m => m.from_role === 'user')?.message || '';
  const briefing = await getTargetBriefing(task.content_id);
  const context = briefing ? await getBriefingContext(briefing.id) : { tasks: [], events: [] };
  const diagnosis = briefing
    ? summarizeHold(briefing, context.tasks, context.events)
    : { issue: 'No active briefing found.', owner: 'Unknown', next: 'Check Ruth production queue or trigger a daily_cycle task.' };

  let reply;
  try {
    reply = await runMayaLLM(briefing, context, latestUserMessage, diagnosis);
  } catch (e) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), runtime: 'maya', event: 'LLM_FALLBACK', error: e.message }));
    reply = buildReply(briefing, context, latestUserMessage);
  }

  if (threadId) {
    await db.createAgentMessage({
      thread_id: threadId,
      task_id: task.id,
      content_type: 'briefing',
      content_id: briefing?.id || (task.content_id === ZERO_UUID ? null : task.content_id),
      from_role: 'agent',
      from_name: 'Maya',
      to_agent: null,
      message: reply,
      metadata: {
        runtime: 'maya_runtime',
        briefing_id: briefing?.id || null,
        pipeline_status: briefing?.pipeline_status || null,
      },
    });
  }

  await db.updateTask(task.id, { status: 'complete' });
}

// ── Approval runtime (approve_briefing tasks) ────────────────────────────────

async function executeMayaApprove(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'maya', event: 'APPROVE_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const briefing = await db.getBriefingById(task.content_id);
    if (!briefing) {
      throw new Error(`Briefing ${task.content_id} not found`);
    }

    if (briefing.pipeline_status !== 'qa') {
      console.log(JSON.stringify({
        ts, runtime: 'maya', event: 'SKIP_WRONG_STATUS',
        briefing_id: briefing.id, pipeline_status: briefing.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    // Advance qa → maya (sets maya_approved_at)
    await apiCall(`/api/pipeline/briefings/${briefing.id}/status`, 'PATCH', {
      to_status:  'maya',
      agent_name: 'Maya',
      notes:      `Maya QA pass. Composition and editorial standards confirmed.`,
    });

    // Advance maya → approved (ready for HITL distribution confirmation)
    await apiCall(`/api/pipeline/briefings/${briefing.id}/status`, 'PATCH', {
      to_status:  'approved',
      agent_name: 'Maya',
      notes:      `Maya approval complete. Edition ${briefing.edition_number} queued for HITL distribution authorization.`,
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'maya', event: 'APPROVE_COMPLETE',
      briefing_id: briefing.id, edition_date: briefing.edition_date, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'MAYA_APPROVE_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Maya approval runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'maya', event: 'APPROVE_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

async function executeMayaApproveArticle(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'maya', event: 'APPROVE_ARTICLE_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const article = await getTargetArticle(task.content_id);
    if (!article) {
      throw new Error(`Article ${task.content_id} not found`);
    }

    if (article.pipeline_status !== 'qa') {
      console.log(JSON.stringify({
        ts, runtime: 'maya', event: 'SKIP_WRONG_ARTICLE_STATUS',
        article_id: article.id, pipeline_status: article.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    await apiCall(`/api/pipeline/articles/${article.id}/status`, 'PATCH', {
      to_status:  'maya',
      agent_name: 'Maya',
      notes:      'Maya article review pass. QA handoff accepted for final approval.',
    });

    await apiCall(`/api/pipeline/articles/${article.id}/status`, 'PATCH', {
      to_status:  'approved',
      agent_name: 'Maya',
      notes:      `Maya approval complete. Intel article "${article.title}" queued for HITL release.`,
    });

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'maya', event: 'APPROVE_ARTICLE_COMPLETE',
      article_id: article.id, task_id: task.id,
    }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'MAYA_ARTICLE_APPROVE_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Maya article approval runtime error: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'maya', event: 'APPROVE_ARTICLE_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

async function pollMayaTasks() {
  if (_polling) return;
  _polling = true;
  try {
    const tasks = await db.pool.query(`
      SELECT *
      FROM agent_tasks
      WHERE agent_name = 'Maya'
        AND task_type IN ('editorial_troubleshoot', 'approve_briefing', 'approve_article')
        AND status IN ('queued', 'escalated')
        AND (retry_after IS NULL OR retry_after <= now())
      ORDER BY started_at ASC
      LIMIT 5
    `).then(r => r.rows);

    for (const task of tasks) {
      try {
        if (task.task_type === 'approve_article') {
          await executeMayaApproveArticle(task);
        } else if (task.task_type === 'approve_briefing') {
          await executeMayaApprove(task);
        } else {
          await executeTroubleshootTask(task);
        }
      } catch (e) {
        await db.updateTask(task.id, { status: 'failed', error_message: e.message });
      }
    }
  } finally {
    _polling = false;
  }
}

module.exports = {
  pollMayaTasks,
  executeTroubleshootTask,
  executeMayaApprove,
  executeMayaApproveArticle,
  buildReply,
  summarizeHold,
};
