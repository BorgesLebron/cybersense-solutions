'use strict';

// Guarded one-shot helper for Edition 123 recovery.
//
// Dry run:
//   node recover_edition_123.js
//
// Execute:
//   node recover_edition_123.js --execute
//
// This stages the briefing to approved for HITL review. It does not publish,
// send email, or call confirm-distribution.

require('dotenv').config();
const db = require('./db/queries');

const EXECUTE = process.argv.includes('--execute');

const edition = {
  date: '2026-05-13',
  number: 123,
  subject: 'Edition 123 - Resolver Trust, Workspace Boundaries, and Human Firewall Training',
  file_path: 'newsletter/2026/May/05132026_edition123.html',
  description: 'CoreDNS transport risks, Jupyter workspace boundary exposure, AI coding tool trust bypass, developer extension compromise pressure, AI-driven remediation load, and NIST FISSEA human firewall training.',
};

const threatIds = [
  '60a62dc4-6d24-42be-8cb7-e23e9eac3e2e',
  '8055cc18-b6dd-416a-96f3-ec4f5e428d12',
  'a4cdadd6-1e0f-4b0e-81ca-b5dad78c74b6',
];

const innovationItems = [
  {
    id: 'bed0378f-ffe1-40b4-a78e-37b3537a5e9b',
    source_url: 'https://www.bleepingcomputer.com/news/security/glassworm-malware-returns-with-new-wave-of-malicious-vscode-extensions/',
    content: 'Developer workstations are becoming a direct security boundary. Malicious extension campaigns such as GlassWorm show how source code, cloud credentials, and deployment access can be exposed through tools that developers install to improve productivity. Tactical Action: require extension allowlists for IDEs, review publisher reputation before installation, and monitor developer endpoints for unexpected credential or repository access.',
  },
  {
    id: '4bafde50-f964-46a0-b90f-e4b6c09b03af',
    source_url: 'https://www.ox.security/',
    content: 'AI-assisted development increases delivery speed, but it can also increase the rate at which vulnerable code reaches review queues. The operational signal is not simply more alerts; it is more critical findings that need prioritization before release. Tactical Action: connect code generation workflows to SCA, SAST, secrets scanning, and remediation SLAs so AI-driven output does not outrun security review.',
  },
];

const growth = {
  type: 'growth',
  category: 'security-awareness-training',
  headline: 'NIST FISSEA Spring Forum focuses on increasing cybersecurity awareness as the human firewall',
  summary: 'NIST scheduled the May 12, 2026 FISSEA Spring Forum around the theme of increasing cybersecurity awareness and training, emphasizing human behavior as a core part of security program effectiveness.',
  tags: ['NIST', 'FISSEA', 'security-awareness', 'human-firewall', 'training'],
  priority: 'normal',
  source_url: 'https://www.nist.gov/news-events/events/2026/05/fissea-spring-forum-may-12-2026',
  content: 'Growth focus: awareness programs need more than annual reminders. The FISSEA theme reinforces that human behavior is a security control when training is timely, practical, and connected to real workflows. Tactical Action: map awareness topics to current operational risks, keep training short enough to apply immediately, and measure whether users report anomalies faster after training.',
};

const training = {
  title: 'AI Coding Tools: Verify Workspace Trust Before Running Project Automation',
  type: 'training_byte',
  phase: 'library',
  zt_module: 'identity-verification',
  access_tier: 'freemium',
  duration_min: 3,
  content_url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-40068',
};

function cveDescription(row) {
  return row.raw_data?.cve?.descriptions?.find(d => d.lang === 'en')?.value || row.threat_name;
}

async function loadThreats() {
  const { rows } = await db.pool.query(
    `SELECT id, cve_id, threat_name, severity, cvss_score, category, source_url, raw_data, tags, priority
     FROM threat_records
     WHERE id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], id)`,
    [threatIds]
  );
  if (rows.length !== threatIds.length) throw new Error(`Expected ${threatIds.length} threat rows, found ${rows.length}`);
  return rows;
}

async function stageInnovationRepository() {
  const ids = innovationItems.map(item => item.id);
  const { rows } = await db.pool.query(
    `SELECT id, type, category, headline, summary, tags, priority
     FROM intel_items
     WHERE id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], id)`,
    [ids]
  );
  if (rows.length !== ids.length) throw new Error(`Expected ${ids.length} innovation rows, found ${rows.length}`);

  for (const row of rows) {
    const source = innovationItems.find(item => item.id === row.id);
    await db.processIntoRepository({
      source_type: row.type,
      source_id: row.id,
      normalized_data: {
        title: row.headline,
        summary: row.summary,
        content: source.content,
        source_url: source.source_url,
        category: row.category,
      },
      correlation_tags: row.tags || [],
      processed_by: 'Barbara',
      ready_for_intel: true,
      ready_for_awareness: true,
    });
  }

  return rows;
}

async function createGrowthItem() {
  const existing = await db.pool.query(
    `SELECT i.*
     FROM intel_items i
     WHERE i.type = $1 AND i.headline = $2
     ORDER BY ingested_at DESC
     LIMIT 1`,
    [growth.type, growth.headline]
  ).then(r => r.rows[0] || null);

  const item = existing || await db.createIntelItem({
    type: growth.type,
    category: growth.category,
    headline: growth.headline,
    summary: growth.summary,
    tags: growth.tags,
    priority: growth.priority,
    ingested_by: 'Ivan/Charlie',
  });

  await db.processIntoRepository({
    source_type: growth.type,
    source_id: item.id,
    normalized_data: {
      title: growth.headline,
      summary: growth.summary,
      content: growth.content,
      source_url: growth.source_url,
      category: growth.category,
    },
    correlation_tags: growth.tags,
    processed_by: 'Barbara',
    ready_for_intel: true,
    ready_for_awareness: true,
  });

  return item;
}

async function createTrainingByte() {
  const existing = await db.pool.query(
    `SELECT *
     FROM training_modules
     WHERE type = $1 AND title = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [training.type, training.title]
  ).then(r => r.rows[0] || null);

  if (existing) {
    if (existing.pipeline_status !== 'published') await db.advanceModuleStatus(existing.id, 'published');
    return existing;
  }

  const module = await db.createTrainingModule({ ...training, created_by: 'Kirby' });
  return db.advanceModuleStatus(module.id, 'published');
}

function buildBody({ threats, innovations, growthItem, trainingModule }) {
  const threatSection = threats.map((t, idx) => [
    `### Threat ${idx + 1}: ${t.cve_id} - ${t.threat_name}`,
    cveDescription(t),
    `Severity: ${t.severity}; CVSS: ${t.cvss_score || 'n/a'}`,
    `Source: ${t.source_url}`,
  ].join('\n')).join('\n\n');

  const innovationSection = innovations.map((item, idx) => {
    const source = innovationItems.find(i => i.id === item.id);
    return [
      `### Innovation ${idx + 1}: ${item.headline}`,
      item.summary,
      source.content,
      `Source: ${source.source_url}`,
    ].join('\n');
  }).join('\n\n');

  return [
    `# ${edition.subject}`,
    threatSection,
    `### Training Byte: ${trainingModule.title}`,
    'Before running an AI coding assistant or project automation in a repository, verify that the workspace is expected, trusted, and free of unexpected hooks or configuration files. If a cloned project asks for trust, pause and inspect the repository before granting it.',
    `Source: ${training.content_url}`,
    `### Growth: ${growthItem.headline}`,
    growth.summary,
    growth.content,
    `Source: ${growth.source_url}`,
    innovationSection,
  ].join('\n\n---\n\n');
}

async function logTransition(contentId, fromStatus, toStatus, agentName, notes) {
  await db.logPipelineEvent({
    content_type: 'briefing',
    content_id: contentId,
    from_status: fromStatus,
    to_status: toStatus,
    agent_name: agentName,
    notes,
  });
}

async function main() {
  const existingDate = await db.getBriefingByDate(edition.date);
  if (existingDate) throw new Error(`Briefing already exists for ${edition.date}: ${existingDate.id}`);

  const existingNumber = await db.pool.query('SELECT id FROM briefings WHERE edition_number=$1', [edition.number]).then(r => r.rows[0] || null);
  if (existingNumber) throw new Error(`Edition ${edition.number} already exists: ${existingNumber.id}`);

  const threats = await loadThreats();

  const innovationRows = await db.pool.query(
    `SELECT id, type, category, headline, summary, tags, priority
     FROM intel_items
     WHERE id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], id)`,
    [innovationItems.map(item => item.id)]
  ).then(r => r.rows);
  if (innovationRows.length !== innovationItems.length) {
    throw new Error(`Expected ${innovationItems.length} innovation rows, found ${innovationRows.length}`);
  }

  const existingGrowth = await db.pool.query(
    `SELECT *
     FROM intel_items
     WHERE type = $1 AND headline = $2
     ORDER BY ingested_at DESC
     LIMIT 1`,
    [growth.type, growth.headline]
  ).then(r => r.rows[0] || null);

  const existingTraining = await db.pool.query(
    `SELECT *
     FROM training_modules
     WHERE type = $1 AND title = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [training.type, training.title]
  ).then(r => r.rows[0] || null);

  const preview = {
    execute: EXECUTE,
    edition,
    threats: threats.map(t => ({ id: t.id, cve_id: t.cve_id, title: t.threat_name, source_url: t.source_url })),
    innovations: innovationRows.map(i => ({ id: i.id, title: i.headline })),
    growth: existingGrowth
      ? { id: existingGrowth.id, title: existingGrowth.headline, existing: true }
      : { title: growth.headline, existing: false },
    training: existingTraining
      ? { id: existingTraining.id, title: existingTraining.title, existing: true }
      : { title: training.title, existing: false },
  };

  if (!EXECUTE) {
    console.log(JSON.stringify({ dry_run: true, preview }, null, 2));
    return;
  }

  const innovations = await stageInnovationRepository();
  const growthItem = await createGrowthItem();
  const trainingModule = await createTrainingByte();

  const briefing = await db.createBriefing({
    edition_date: edition.date,
    edition_number: edition.number,
    subject_line: edition.subject,
    body_md: buildBody({ threats, innovations, growthItem, trainingModule }),
    threat_item_ids: threatIds,
    innovation_item_ids: innovations.map(i => i.id),
    growth_item_id: growthItem.id,
    training_byte_id: trainingModule.id,
    file_path: edition.file_path,
    description: edition.description,
  });

  await logTransition(briefing.id, null, 'draft', 'Ruth', 'Edition 123 recovery draft created after Ruth daily cycle failed due to missing innovation/growth repository items');
  await db.advanceBriefingStatus(briefing.id, 'dev_edit');
  await logTransition(briefing.id, 'draft', 'dev_edit', 'Peter', 'Recovery developmental edit accepted');
  await db.advanceBriefingStatus(briefing.id, 'eic_review');
  await logTransition(briefing.id, 'dev_edit', 'eic_review', 'Ed', 'Recovery EIC review accepted');
  await db.advanceBriefingStatus(briefing.id, 'qa');
  await logTransition(briefing.id, 'eic_review', 'qa', 'Jeff', 'Recovery QA pass');
  await db.advanceBriefingStatus(briefing.id, 'maya');
  await logTransition(briefing.id, 'qa', 'maya', 'Maya', 'Recovery editorial approval');
  const approved = await db.advanceBriefingStatus(briefing.id, 'approved');
  await logTransition(briefing.id, 'maya', 'approved', 'Maya', 'Edition 123 staged for Hector HITL approval');

  console.log(JSON.stringify({ created: true, briefing: approved }, null, 2));
}

main()
  .catch(e => {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
