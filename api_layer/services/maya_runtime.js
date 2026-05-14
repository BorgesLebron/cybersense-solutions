'use strict';

// services/maya_runtime.js
// Maya's first agentic slice: answer Command Center troubleshooting requests
// by inspecting editorial pipeline state and writing back to agent_messages.

const db = require('../db/queries');

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
let _polling = false;

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
  const reply = buildReply(briefing, context, latestUserMessage);

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

async function pollMayaTasks() {
  if (_polling) return;
  _polling = true;
  try {
    const tasks = await db.pool.query(`
      SELECT *
      FROM agent_tasks
      WHERE agent_name = 'Maya'
        AND task_type = 'editorial_troubleshoot'
        AND status IN ('queued', 'escalated')
        AND (retry_after IS NULL OR retry_after <= now())
      ORDER BY started_at ASC
      LIMIT 5
    `).then(r => r.rows);

    for (const task of tasks) {
      try {
        await executeTroubleshootTask(task);
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
  buildReply,
  summarizeHold,
};
