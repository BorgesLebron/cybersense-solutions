'use strict';

// One-shot TASK-004 trigger. Run from api_layer/:
//   node trigger_ruth.js [edition_date]
// Default edition_date: tomorrow CT (2026-05-08).
// Creates the daily_cycle task and fires DAILY_CYCLE_START notification.
// Ruth's runtime picks it up on its next 2-min poll.

require('dotenv').config();
const db = require('./db/queries');
const { notifyAgents } = require('./services/agents');

async function main() {
  const editionDate = process.argv[2] || (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  })();

  console.log(`[TASK-004] Triggering Ruth daily cycle — edition_date: ${editionDate}`);

  const existing = await db.getBriefingByDate(editionDate);
  if (existing) {
    console.log(`[TASK-004] Briefing for ${editionDate} already exists (id: ${existing.id}). Pass date explicitly to override or use force flag on the admin endpoint.`);
    process.exit(0);
  }

  const sla = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const task = await db.createTask({
    agent_name: 'Ruth',
    task_type: 'daily_cycle',
    content_type: 'briefing',
    content_id: '00000000-0000-0000-0000-000000000000',
    sla_deadline: sla,
  });

  console.log(`[TASK-004] Task created — id: ${task.id}`);

  await notifyAgents(['Ruth'], {
    type: 'DAILY_CYCLE_START',
    edition_date: editionDate,
    sla_deadline: sla.toISOString(),
    composition_required: { threat: 3, innovation: 2, growth: 1, training_byte: 1 },
    kirby_deadline: '05:00 CT',
    ivan_charlie_deadline: '05:30 CT',
    triggered_by: 'manual_task004',
    message: `Begin daily cycle for ${editionDate}. Source, select, and structure 7 items per SOP OA-AWR-001. Deliver package to Peter by ${sla.toISOString()}.`,
  });

  console.log(`[TASK-004] DAILY_CYCLE_START notification sent to Ruth.`);
  console.log(`[TASK-004] Watch logs for: COMPOSITION_RESULT, BRIEFING_SUBMITTED`);
  console.log(`[TASK-004] Task ID: ${task.id}`);

  await db.pool.end();
}

main().catch(e => {
  console.error('[TASK-004] Error:', e.message);
  process.exit(1);
});
