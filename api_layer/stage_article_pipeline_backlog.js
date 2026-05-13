'use strict';

// One-shot draft article backlog for the intel article pipeline.
//
// Dry run:
//   node stage_article_pipeline_backlog.js
//
// Execute:
//   node stage_article_pipeline_backlog.js --execute
//
// Verify:
//   node stage_article_pipeline_backlog.js --counts

require('dotenv').config();
const db = require('./db/queries');

const EXECUTE = process.argv.includes('--execute');
const COUNTS = process.argv.includes('--counts');

const drafts = [
  {
    title: 'Verifiable Credentials Need Operational Trust, Not Just Wallet Support',
    section: 'innovation',
    access_tier: 'monthly',
    source_headlines: [
      'NIST verifiable credential issuance work moves identity modernization from format to process',
      'NIST FISSEA agenda frames black-box AI trust as a human security behavior problem',
    ],
    body_md: `# Verifiable Credentials Need Operational Trust, Not Just Wallet Support

Digital identity modernization is moving quickly, but the useful security question is no longer whether a credential can be carried in a wallet. The harder question is whether the whole operating chain can be trusted under pressure.

NIST's verifiable credential work is a reminder that issuance, proofing, wallet behavior, relying-party validation, and revocation all matter. A mobile document or wallet credential can reduce friction, but only if the organization receiving it knows how to validate it and what to do when the credential is expired, revoked, delegated, or presented in an unusual context.

That makes verifiable credentials an operational control, not just an identity format. Security leaders should evaluate wallet-based identity the same way they would evaluate any other dependency in an access workflow: what assurance is required, how exceptions are handled, how failed validation is surfaced, and how users are trained to avoid automation bias.

The awareness angle matters because opaque systems change behavior. If employees see a wallet prompt, identity badge, or AI-generated validation result, they may reduce scrutiny even when the situation is abnormal. Training should focus on verification protocols, escalation language, and the difference between a credential being technically present and the transaction being trustworthy.

For small and midsize teams, the practical move is to start with policy and process before tooling. Define which credentials are accepted, which workflows require step-up checks, who owns revocation checks, and how service desks document exceptions. Then test the process with realistic scenarios involving device loss, account takeover, expired credentials, delegated authority, and synthetic-media-assisted social engineering.

The advantage is clear: wallet-based identity can make customer and workforce interactions faster. The risk is also clear: a faster trust decision can become a faster wrong decision unless validation and human escalation are built into the workflow.`,
  },
  {
    title: 'AI-Driven Vulnerability Discovery Raises the Bar for Platform Skills',
    section: 'growth',
    access_tier: 'monthly',
    source_headlines: [
      'Frontier AI model access pushes security platforms toward adaptive vulnerability response',
      'AI vulnerability surge increases partner demand for adaptable security platform skills',
    ],
    body_md: `# AI-Driven Vulnerability Discovery Raises the Bar for Platform Skills

AI is changing vulnerability management less by replacing security teams and more by increasing the tempo of discovery. As models become better at finding, explaining, and chaining weaknesses, organizations will face more exposure signals than traditional triage workflows were designed to handle.

That creates a growth opportunity for security providers, internal platform teams, and practitioners who can connect discovery to action. The market signal is not simply demand for another scanner. It is demand for people who can reduce complexity, prioritize exposure, and move remediation through the business without creating a permanent emergency posture.

Platform skill now matters because vulnerability data only becomes useful when it is correlated with asset context, exploitability, identity exposure, business criticality, and change windows. Teams that can integrate these signals will be better positioned than teams that only produce larger finding lists.

The partner angle is especially important. Customers under pressure from AI-accelerated vulnerability discovery will look for service providers who can help consolidate tooling, explain risk in business language, and build repeatable remediation patterns. This favors advisors who understand both technical exposure and operational adoption.

For cybersecurity professionals, the career implication is direct: learn the platform layer, not just the alert layer. Useful skills include exposure management, asset graph interpretation, cloud control mapping, remediation orchestration, and executive risk translation. Human judgment remains central because prioritization depends on context that automated discovery does not fully understand.

The next phase of vulnerability response will reward teams that can absorb faster discovery without losing discipline. The winning operating model is not more noise. It is a shorter path from validated exposure to accountable remediation.`,
  },
];

function slugFor(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
}

async function getSources(sourceHeadlines) {
  const { rows } = await db.pool.query(
    'SELECT id, headline FROM intel_items WHERE headline = ANY($1::text[])',
    [sourceHeadlines]
  );
  return rows;
}

async function existingArticle(title) {
  const slug = slugFor(title);
  const { rows } = await db.pool.query(
    'SELECT id, title, slug, pipeline_status FROM articles WHERE slug=$1 ORDER BY created_at DESC LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

async function stageDraft(draft) {
  const existing = await existingArticle(draft.title);
  if (existing) return { ...existing, existing: true };

  const sources = await getSources(draft.source_headlines);
  if (sources.length !== draft.source_headlines.length) {
    const found = new Set(sources.map(s => s.headline));
    const missing = draft.source_headlines.filter(headline => !found.has(headline));
    throw new Error(`Missing source item(s) for ${draft.title}: ${missing.join('; ')}`);
  }

  const article = await db.createArticle({
    title: draft.title,
    section: draft.section,
    body_md: draft.body_md,
    access_tier: draft.access_tier,
    source_ids: sources.map(s => s.id),
    created_by: 'James',
  });

  await db.logPipelineEvent({
    content_type: 'article',
    content_id: article.id,
    from_status: null,
    to_status: 'draft',
    agent_name: 'James',
    notes: 'Backlog article draft staged from ready intel repository items',
  });

  const task = await db.createTask({
    agent_name: 'Jason',
    task_type: 'dev_edit',
    content_type: 'article',
    content_id: article.id,
    sla_deadline: null,
  });

  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    pipeline_status: article.pipeline_status,
    queued_task_id: task.id,
    existing: false,
  };
}

async function main() {
  if (COUNTS) {
    const { rows: articles } = await db.pool.query(`
      SELECT id, title, section, pipeline_status, created_at
      FROM articles
      WHERE pipeline_status::text != 'published'
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const { rows: tasks } = await db.pool.query(`
      SELECT agent_name, task_type, content_type, status, count(*)::int AS count
      FROM agent_tasks
      WHERE content_type='article'
      GROUP BY agent_name, task_type, content_type, status
      ORDER BY agent_name, task_type, status
    `);
    console.log(JSON.stringify({ articles, tasks }, null, 2));
    return;
  }

  if (!EXECUTE) {
    console.log(JSON.stringify({
      dry_run: true,
      count: drafts.length,
      drafts: drafts.map(d => ({
        title: d.title,
        section: d.section,
        access_tier: d.access_tier,
        source_headlines: d.source_headlines,
      })),
    }, null, 2));
    return;
  }

  const staged = [];
  for (const draft of drafts) staged.push(await stageDraft(draft));
  console.log(JSON.stringify({ staged }, null, 2));
}

main()
  .catch(e => {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
