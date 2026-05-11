'use strict';

// Guarded one-shot helper for Edition 121 recovery.
//
// Dry run:
//   node recover_edition_121.js
//
// Execute after Hector/Alan supply final topic IDs:
//   $env:THREAT_IDS="uuid1,uuid2,uuid3"
//   $env:INNOVATION_IDS="uuid1,uuid2"
//   $env:GROWTH_ID="uuid"
//   $env:TRAINING_BYTE_ID="uuid" # required for --execute; should derive from one selected threat
//   $env:FILE_PATH="newsletter/2026/May/05112026_edition121.html"
//   node recover_edition_121.js --execute

require('dotenv').config();
const db = require('./db/queries');

const EDITION_DATE = process.env.EDITION_DATE || '2026-05-11';
const EDITION_NUMBER = Number(process.env.EDITION_NUMBER || 121);
const EXECUTE = process.argv.includes('--execute');

function parseIds(name, expected) {
  const ids = String(process.env[name] || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  if (ids.length !== expected) {
    throw new Error(`${name} must contain exactly ${expected} comma-separated UUIDs`);
  }
  return ids;
}

async function loadRows(ids) {
  const { rows } = await db.pool.query(
    `SELECT r.source_id, r.source_type,
            COALESCE(t.threat_name, i.headline, r.normalized_data->>'title') AS title,
            COALESCE(t.source_url, i.category, r.normalized_data->>'source_url', r.normalized_data->>'category') AS source
     FROM intel_repository r
     LEFT JOIN threat_records t ON t.id = r.source_id AND r.source_type = 'threat'
     LEFT JOIN intel_items i ON i.id = r.source_id AND r.source_type IN ('innovation','growth','policy')
     WHERE r.source_id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], r.source_id)`,
    [ids]
  );
  if (rows.length !== ids.length) throw new Error(`Expected ${ids.length} repository rows, found ${rows.length}`);
  return rows;
}

async function latestTrainingByte() {
  const { rows } = await db.pool.query(
    `SELECT id, title
     FROM training_modules
     WHERE type = 'training_byte'
       AND pipeline_status = 'published'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!rows[0]) throw new Error('No published training_byte is available');
  return rows[0];
}

function buildBody({ threats, innovations, growth, trainingByte }) {
  const threatSection = threats
    .map((item, idx) => `### Threat ${idx + 1}: ${item.title}\nSource: ${item.source || 'Threat repository'}\nRepository ID: ${item.source_id}`)
    .join('\n\n');

  const innovationSection = innovations
    .map((item, idx) => `### Innovation ${idx + 1}: ${item.title}\nSource: ${item.source || 'Innovation repository'}\nRepository ID: ${item.source_id}`)
    .join('\n\n');

  return [
    `# Edition ${EDITION_NUMBER} - Daily Digital Awareness Briefing`,
    threatSection,
    innovationSection,
    `### Growth: ${growth.title}\nSource: ${growth.source || 'Growth repository'}\nRepository ID: ${growth.source_id}`,
    `### Training Byte: ${trainingByte.title}\nTraining module ID: ${trainingByte.id}`,
  ].join('\n\n---\n\n');
}

async function main() {
  const existing = await db.getBriefingByDate(EDITION_DATE);
  if (existing) throw new Error(`Briefing already exists for ${EDITION_DATE}: ${existing.id}`);

  const existingNumber = await db.pool.query('SELECT id FROM briefings WHERE edition_number=$1', [EDITION_NUMBER]).then(r => r.rows[0]);
  if (existingNumber) throw new Error(`Edition ${EDITION_NUMBER} already exists: ${existingNumber.id}`);

  const threatIds = parseIds('THREAT_IDS', 3);
  const innovationIds = parseIds('INNOVATION_IDS', 2);
  const growthId = parseIds('GROWTH_ID', 1)[0];

  const threats = await loadRows(threatIds);
  const innovations = await loadRows(innovationIds);
  const growth = (await loadRows([growthId]))[0];
  if (EXECUTE && !process.env.TRAINING_BYTE_ID) {
    throw new Error('TRAINING_BYTE_ID is required for --execute so the training byte can be tied to the selected threat article');
  }

  const trainingByte = process.env.TRAINING_BYTE_ID
    ? { id: process.env.TRAINING_BYTE_ID, title: process.env.TRAINING_BYTE_TITLE || 'Training Byte' }
    : await latestTrainingByte();

  const subjectLine = process.env.SUBJECT_LINE || threats[0].title;
  const body_md = buildBody({ threats, innovations, growth, trainingByte });

  const preview = {
    execute: EXECUTE,
    edition_date: EDITION_DATE,
    edition_number: EDITION_NUMBER,
    subject_line: subjectLine,
    threats,
    innovations,
    growth,
    training_byte: trainingByte,
    file_path: process.env.FILE_PATH || null,
  };

  if (!EXECUTE) {
    console.log(JSON.stringify({ dry_run: true, preview }, null, 2));
    return;
  }

  const briefing = await db.createBriefing({
    edition_date: EDITION_DATE,
    edition_number: EDITION_NUMBER,
    subject_line: subjectLine,
    body_md,
    threat_item_ids: threatIds,
    innovation_item_ids: innovationIds,
    growth_item_id: growthId,
    training_byte_id: trainingByte.id,
    file_path: process.env.FILE_PATH || null,
    description: process.env.DESCRIPTION || null,
  });

  await db.logPipelineEvent({
    content_type: 'briefing',
    content_id: briefing.id,
    from_status: null,
    to_status: 'draft',
    agent_name: 'Ruth',
    notes: `Emergency recovery draft for Edition ${EDITION_NUMBER} (${EDITION_DATE})`,
  });

  console.log(JSON.stringify({ created: true, briefing }, null, 2));
}

main()
  .catch(e => {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
