'use strict';

// TASK-004 one-shot: runs Ruth's daily cycle for 2026-05-08 via direct DB calls.
// Bypasses the new Date() clock issue in ruth_runtime (runtime computes today's CT
// date, which is still 2026-05-07, and Edition 119 blocks it). This script is
// faithful to executeRuthDailyCycle — same logic, same log events, explicit date.
//
// Run from api_layer/:  node run_ruth_now.js

require('dotenv').config();
const db           = require('./db/queries');
const { notifyAgents } = require('./services/agents');

const EDITION_DATE = '2026-05-08';
const RUTH_TASK_ID = '3cc05093-531d-4c0d-a232-a320821f1a54';

async function main() {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'CYCLE_START', edition_date: EDITION_DATE, task_id: RUTH_TASK_ID }));

  // Idempotency
  const existing = await db.getBriefingByDate(EDITION_DATE);
  if (existing) {
    console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'ALREADY_EXISTS', edition_date: EDITION_DATE, briefing_id: existing.id }));
    await db.pool.end();
    return;
  }

  await db.updateTask(RUTH_TASK_ID, { status: 'in_progress' });

  // ── Composition: threats, innovations, growth ────────────────────────────────
  const queue = await db.getRepositoryQueue({ pipeline: 'awareness', limit: 60 });
  const items = queue || [];

  const threats     = items.filter(i => i.source_type === 'threat').slice(0, 3);
  const innovations = items.filter(i => i.source_type === 'innovation').slice(0, 2);
  const growthItem  = items.find(i => i.source_type === 'growth') || null;

  // Training byte — direct query, not routed through intel_repository
  const trainingByteRow = await db.pool.query(`
    SELECT id, title FROM training_modules
    WHERE type = 'training_byte' AND pipeline_status = 'published'
      AND id NOT IN (
        SELECT training_byte_id
        FROM briefings
        WHERE training_byte_id IS NOT NULL
        ORDER BY edition_date DESC
        LIMIT 5
      )
    ORDER BY created_at DESC LIMIT 1
  `).then(r => r.rows[0] || null);

  // ── COMPOSITION_RESULT ───────────────────────────────────────────────────────
  const missing = [];
  if (threats.length    < 3) missing.push(`threats (need 3, found ${threats.length})`);
  if (innovations.length < 2) missing.push(`innovations (need 2, found ${innovations.length})`);
  if (!growthItem)            missing.push('growth item (0 found)');
  if (!trainingByteRow)       missing.push('training_byte (none published)');

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    runtime: 'ruth', event: 'COMPOSITION_RESULT',
    edition_date: EDITION_DATE,
    threats_found:        threats.length,
    innovations_found:    innovations.length,
    growth_found:         !!growthItem,
    training_byte_found:  !!trainingByteRow,
    threats:       threats.map(t => ({ source_id: t.source_id, title: t.title, source_type: t.source_type })),
    innovations:   innovations.map(i => ({ source_id: i.source_id, title: i.title, source_type: i.source_type })),
    growth:        growthItem  ? { source_id: growthItem.source_id, title: growthItem.title } : null,
    training_byte: trainingByteRow ? { id: trainingByteRow.id, title: trainingByteRow.title } : null,
    missing:       missing.length > 0 ? missing : null,
  }));

  if (missing.length > 0) {
    const error_message = `Incomplete repository: ${missing.join('; ')}`;
    await db.updateTask(RUTH_TASK_ID, { status: 'failed', error_message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'RUTH_COMPOSITION_INCOMPLETE',
      edition_date: EDITION_DATE,
      task_id: RUTH_TASK_ID,
      missing,
      message: `Ruth cannot compose briefing for ${EDITION_DATE} — ${error_message}.`,
    });
    console.warn(JSON.stringify({ ts: new Date().toISOString(), runtime: 'ruth', event: 'COMPOSITION_INCOMPLETE', edition_date: EDITION_DATE, missing }));
    await db.pool.end();
    return;
  }

  // ── Build briefing content ───────────────────────────────────────────────────
  const topThreat    = threats[0];
  const subject_line = topThreat?.title ||
    `Daily Digital Awareness Briefing — ${new Date(EDITION_DATE + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const threatSection = threats
    .map(t => `### ${t.title || 'Threat Advisory'}\n_Source ID: ${t.source_id}_`)
    .join('\n\n');

  const intelSection = [
    ...innovations.map(i => `### Innovation: ${i.title || 'Innovation Item'}`),
    `### Growth: ${growthItem?.title || 'Growth Item'}`,
  ].join('\n\n');

  const body_md = `${threatSection}\n\n---\n\n${intelSection}`;

  // ── Submit briefing ──────────────────────────────────────────────────────────
  const briefing = await db.createBriefing({
    edition_date:        EDITION_DATE,
    subject_line,
    body_md,
    threat_item_ids:     threats.map(t => t.source_id),
    innovation_item_ids: innovations.map(i => i.source_id),
    growth_item_id:      growthItem.source_id,
    training_byte_id:    trainingByteRow.id,
  });

  await db.logPipelineEvent({
    content_type: 'briefing',
    content_id:   briefing.id,
    from_status:  null,
    to_status:    'draft',
    agent_name:   'Ruth',
    notes:        `Daily briefing draft for ${EDITION_DATE}`,
  });

  // Dispatch to Peter (mirrors POST /api/pipeline/briefings exactly)
  const sla = new Date();
  sla.setHours(6, 15, 0, 0);
  if (sla < new Date()) sla.setDate(sla.getDate() + 1); // if past 06:15, set for tomorrow

  const peterTask = await db.createTask({
    agent_name:   'Peter',
    task_type:    'dev_edit_briefing',
    content_type: 'briefing',
    content_id:   briefing.id,
    sla_deadline: sla,
  });

  await notifyAgents(['Peter'], {
    type:        'BRIEFING_READY_FOR_DEV_EDIT',
    briefing_id: briefing.id,
    edition_date: EDITION_DATE,
    task_id:     peterTask.id,
    sla_deadline: sla.toISOString(),
    message:     `Briefing for ${EDITION_DATE} is ready for developmental editing. SLA: 06:30 CT.`,
  });

  await db.updateTask(RUTH_TASK_ID, { status: 'complete' });

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    runtime: 'ruth', event: 'BRIEFING_SUBMITTED',
    edition_date:  EDITION_DATE,
    briefing_id:   briefing.id,
    edition_number: briefing.edition_number,
    subject_line,
    task_id:       RUTH_TASK_ID,
    peter_task_id: peterTask.id,
  }));

  await db.pool.end();
}

main().catch(e => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), runtime: 'ruth', event: 'CYCLE_ERROR', error: e.message }));
  process.exit(1);
});
