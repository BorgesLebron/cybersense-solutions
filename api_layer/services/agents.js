'use strict';

// ── services/agents.js ────────────────────────────────────────────────────────
// Internal agent communication bus. In production this would be backed by
// a message queue (SQS, Redis Streams, or similar). Here we use HTTP callbacks
// to agent webhook endpoints, with graceful degradation to DB task records.

const db = require('../db/queries');

const AGENT_WEBHOOK_BASE = process.env.AGENT_WEBHOOK_BASE || 'http://localhost:4000/agents';

const AWARENESS_PIPELINE_AGENTS = ['Ruth', 'Peter', 'Ed', 'Jeff', 'Maya'];
const INTEL_PIPELINE_AGENTS = ['James', 'Jason', 'Rob', 'Jeff', 'Maya'];
const MANAGEMENT_AGENTS = ['Henry', 'Valerie', 'Victor', 'Barret', 'Alex', 'Maya'];

async function notifyAgents(agentNames, payload) {
  const notifications = agentNames.map(async (name) => {
    try {
      const url = `${AGENT_WEBHOOK_BASE}/${name.toLowerCase()}/notify`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CS-Internal': process.env.INTERNAL_SECRET },
        body: JSON.stringify({ ...payload, ts: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Agent ${name} webhook returned ${res.status}`);
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'AGENT_NOTIFY_FAILED', agent: name, error: e.message }));
      // Fallback: create a DB task so the agent can poll; seed retry_after for the retry sweep
      const retry_after = new Date(Date.now() + 5 * 60 * 1000);
      await db.createTask({ agent_name: name, task_type: 'notification', content_type: 'system', content_id: payload.record_id || payload.content_id || '00000000-0000-0000-0000-000000000000', sla_deadline: null, retry_after }).catch(() => {});
    }
  });
  await Promise.allSettled(notifications);
}

async function triggerEscalationCheck(pipeline, agent_name, content_id, to_status) {
  if (to_status !== 'draft') return;

  // Count rejections back to draft in the last 24h for this pipeline
  const pipelineAgents = pipeline === 'awareness' ? AWARENESS_PIPELINE_AGENTS : INTEL_PIPELINE_AGENTS;
  const count = await db.countAgentRejections24h(pipelineAgents);
  const rejections = parseInt(count?.count || 0);

  if (rejections >= 3) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'REJECTION_THRESHOLD_BREACHED', pipeline, count: rejections }));

    await db.createEscalation({ from_agent: agent_name, to_agent: 'Victor', reason: `${rejections} rejections in the ${pipeline} pipeline in the last 24 hours`, content_id, severity: 'medium' });

    await notifyAgents(['Victor', 'Maya'], {
      type: 'REJECTION_PATTERN',
      pipeline,
      rejection_count: rejections,
      content_id,
      triggered_by: agent_name,
    });
  }
}

async function triggerAwarenessSLAAlert(stage, content_id, expected_at, actual_at) {
  const delta_min = Math.round((new Date(actual_at) - new Date(expected_at)) / 60000);
  if (delta_min <= 0) return;

  console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'AWARENESS_SLA_BREACH', stage, content_id, delta_min }));

  await notifyAgents(['Barret', 'Henry'], {
    type: 'SLA_BREACH',
    pipeline: 'awareness',
    stage,
    content_id,
    delta_min,
    expected_at,
    actual_at,
  });

  if (delta_min > 20 || stage === 'maya') {
    await db.createEscalation({ from_agent: 'Laura', to_agent: 'Henry', reason: `Awareness pipeline SLA breach at ${stage} — ${delta_min} min late. 0700 publication at risk.`, content_id, severity: 'high' });
  }
}

async function broadcastFleetDirective(directive, from_agent, reason) {
  if (from_agent !== 'Henry') throw new Error('Fleet-wide directives may only be issued by Henry');

  await db.logAuditEvent({ actor: from_agent, action: 'fleet_directive', target_agent: 'ALL', reason, affected_content_id: null });

  const allAgents = [
    'Rick', 'Ivan/Charlie', 'Barbara', 'Laura', 'Jim', 'Jeff',
    'James', 'Jason', 'Rob', 'Ruth', 'Peter', 'Ed',
    'Kirby', 'Mario', 'Matt', 'Mary', 'William', 'Joe',
    'Oliver', 'Lucy', 'Riley', 'Ethan',
    'Valerie', 'Victor', 'Barret', 'Alex', 'Maya',
  ];

  await notifyAgents(allAgents, { type: 'FLEET_DIRECTIVE', directive, from_agent, reason });
}

async function checkAwarenessPipelineHealth() {
  const today = new Date().toISOString().split('T')[0];
  const briefing = await db.getBriefingByDate(today);

  if (!briefing) {
    const hour = new Date().getHours();
    if (hour >= 6) {
      await notifyAgents(['Barret', 'Henry'], {
        type: 'MISSING_BRIEFING_DRAFT',
        date: today,
        current_time: new Date().toISOString(),
        message: 'No briefing draft found for today. Ruth may have missed 0500 start.',
      });
    }
    return { status: 'missing', date: today };
  }

  return { status: briefing.pipeline_status, date: today, briefing_id: briefing.id };
}

module.exports = {
  notifyAgents,
  triggerEscalationCheck,
  triggerAwarenessSLAAlert,
  broadcastFleetDirective,
  checkAwarenessPipelineHealth,
};
