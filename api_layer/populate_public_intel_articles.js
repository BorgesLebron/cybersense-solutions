'use strict';

// One-shot public Intel article population for Gwen-owned public surfaces.
//
// Dry run:
//   node populate_public_intel_articles.js
//
// Execute:
//   node populate_public_intel_articles.js --execute
//
// Verify:
//   node populate_public_intel_articles.js --counts

require('dotenv').config();
const db = require('./db/queries');

const EXECUTE = process.argv.includes('--execute');
const COUNTS = process.argv.includes('--counts');

const sourceItems = [
  {
    type: 'innovation',
    category: 'small-business-cybersecurity',
    headline: 'NIST small-business cybersecurity resources emphasize operable resilience for lean teams',
    summary: 'NIST highlighted new and upcoming small-business cybersecurity resources during 2026 National Small Business Week, including work for non-employer firms and community engagement around practical cybersecurity adoption.',
    tags: ['NIST', 'small-business', 'CSF-2.0', 'resilience'],
    priority: 'normal',
    source_url: 'https://www.nist.gov/blogs/cybersecurity-insights/stronger-cybersecurity-stronger-business-nist-celebrates-2026-national',
    content: 'Innovation focus: cybersecurity guidance has to be small enough to operate. Translating CSF 2.0 controls into inventories, backup habits, account hygiene, vendor questions, and recovery priorities helps smaller organizations reduce ecosystem risk.',
  },
  {
    type: 'growth',
    category: 'workforce-development',
    headline: 'NICE webinar highlights human skills as a cybersecurity career differentiator',
    summary: 'NIST lists a May 13, 2026 NICE webinar on the human element of a cyber career, reinforcing that communication, decision-making, and human-centered judgment remain important as technical security work changes.',
    tags: ['NICE', 'workforce', 'career-development', 'human-skills'],
    priority: 'normal',
    source_url: 'https://www.nist.gov/news-events/upcoming-events/org/2747326',
    content: 'Growth focus: as AI and automation reshape security work, human skills become more valuable, not less. Professionals who can explain risk, coordinate response, and guide behavior change help technical controls become operational outcomes.',
  },
  {
    type: 'growth',
    category: 'AI Security',
    headline: 'Your AI Agents Already Have Too Much Access. Now What?',
    summary: 'Enterprise AI agents are over-permissioned and operating outside governance frameworks. Conventional IAM falls short; identity-first security approaches are needed to discover, map, and control agent access at scale.',
    tags: ['ai-security', 'identity-management', 'agent-governance', 'enterprise-risk', 'access-control'],
    priority: 'high',
    source_url: 'https://www.cybersense.solutions/intelligence.html',
    content: 'Growth focus: agentic AI adoption changes identity work. Practitioners need to map agent permissions, define ownership, and set review cycles before AI agents become unmanaged privileged users.',
  },
];

const policySources = [
  {
    framework: 'NIST Cybersecurity Framework',
    version: '2.0',
    effective_date: '2024-02-26',
    change_summary: 'NIST CSF 2.0 expands cybersecurity governance expectations and gives organizations a practical way to connect risk decisions, oversight, and operational controls.',
  },
];

const articles = [
  {
    title: 'NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control',
    section: 'policy',
    access_tier: 'freemium',
    policy_framework: 'NIST Cybersecurity Framework',
    policy_version: '2.0',
    body_md: `# NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control

NIST CSF 2.0 matters because it moves cybersecurity governance out of the annual policy binder and into daily operating decisions. The framework's governance focus gives boards, executives, and security teams a shared language for ownership, risk appetite, accountability, and oversight.

That shift is practical. Many organizations already have tools, alerts, and control libraries. What they often lack is a repeatable way to decide who owns a risk, how exceptions are approved, and how cybersecurity decisions connect to business outcomes. CSF 2.0 helps close that gap by treating governance as part of the control system.

For small and midsize organizations, the useful starting point is not a large compliance project. Start with five questions: who owns cybersecurity risk, which assets matter most, which third parties can affect operations, what recovery outcomes are acceptable, and how leadership will review progress.

The workforce angle is equally important. Employees cannot support a governance model they never see. Awareness programs should explain why reporting, access reviews, vendor discipline, and recovery drills are governance behaviors, not administrative chores.

The strongest CSF 2.0 adoption will be visible in decisions. Risk owners will be named. Exceptions will have expiration dates. Metrics will be tied to resilience outcomes. Leaders will know which controls are working and which gaps need funding.

In that model, governance is not paperwork. It is how cybersecurity becomes a managed business function.`,
  },
  {
    title: 'Small-Business Cybersecurity Has to Be Operable Before It Can Be Mature',
    section: 'innovation',
    access_tier: 'freemium',
    source_headlines: [
      'NIST small-business cybersecurity resources emphasize operable resilience for lean teams',
    ],
    body_md: `# Small-Business Cybersecurity Has to Be Operable Before It Can Be Mature

Small-business cybersecurity fails when guidance assumes enterprise staffing. A lean team does not need a smaller version of a large security program. It needs a program that can be operated consistently with limited time, limited tooling, and competing business priorities.

NIST's small-business cybersecurity work points in the right direction: translate resilience into actions that can survive the workweek. That means inventorying critical accounts, protecting payment and customer systems, backing up essential data, setting vendor expectations, and knowing who makes decisions during an incident.

The innovation is not a new control category. It is operational fit. A control that is too complex to run will decay. A simpler control that is reviewed, owned, and practiced can reduce real risk.

Security leaders serving small organizations should package recommendations as routines. Monthly access reviews, quarterly restore tests, documented vendor contacts, and a short incident call tree are easier to maintain than broad policy language with no operating owner.

This also changes awareness training. Employees need to know what to do when something feels wrong, who to contact, and which workflows deserve extra verification. The goal is not to turn every employee into an analyst. The goal is to create enough shared discipline that small mistakes do not become business interruptions.

Maturity still matters, but operability comes first. Cybersecurity works when the organization can actually run it.`,
  },
  {
    title: 'Human Skills Are Becoming the Security Career Multiplier',
    section: 'growth',
    access_tier: 'freemium',
    source_headlines: [
      'NICE webinar highlights human skills as a cybersecurity career differentiator',
      'Your AI Agents Already Have Too Much Access. Now What?',
    ],
    body_md: `# Human Skills Are Becoming the Security Career Multiplier

Automation is changing security work, but it is not removing the need for human judgment. It is raising the value of professionals who can explain risk, coordinate decisions, and turn technical findings into action.

The signal is visible across workforce guidance and AI security discussions. As security tools produce more analysis and AI agents take on more tasks, organizations still need people who can ask whether the output makes sense, who owns the decision, and what the business should do next.

That makes communication, prioritization, and governance career multipliers. A practitioner who can translate identity risk, vendor exposure, or agent permissions into a clear operating decision is more valuable than someone who only forwards alerts.

For early-career professionals, the practical move is to pair technical depth with decision fluency. Learn how access reviews work. Practice writing short risk summaries. Understand change windows, asset ownership, and recovery priorities. Ask how a recommendation will be implemented, not just whether it is technically correct.

For managers, the lesson is similar. Teams need space to practice briefings, handoffs, tabletop language, and exception handling. These are not soft extras. They are the behaviors that make controls usable under pressure.

Security careers will keep rewarding technical skill. The advantage now goes to people who can make that skill operational.`,
  },
];

function slugFor(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
}

function readTimeMin(markdown) {
  const words = String(markdown || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function existingIntelItem(headline) {
  const { rows } = await db.pool.query(
    'SELECT * FROM intel_items WHERE headline=$1 ORDER BY ingested_at DESC LIMIT 1',
    [headline]
  );
  return rows[0] || null;
}

async function ensureIntelItem(item) {
  const existing = await existingIntelItem(item.headline);
  if (existing) return { ...existing, existing: true };

  const intelItem = await db.createIntelItem({
    type: item.type,
    category: item.category,
    headline: item.headline,
    summary: item.summary,
    tags: item.tags,
    priority: item.priority,
    ingested_by: 'Ivan/Charlie',
  });

  await db.processIntoRepository({
    source_type: item.type,
    source_id: intelItem.id,
    normalized_data: {
      title: item.headline,
      summary: item.summary,
      content: item.content,
      source_url: item.source_url,
      category: item.category,
    },
    correlation_tags: item.tags,
    processed_by: 'Barbara',
    ready_for_intel: true,
    ready_for_awareness: true,
  });

  return { ...intelItem, existing: false };
}

async function ensurePolicySource(source) {
  const { rows } = await db.pool.query(
    `SELECT *
     FROM policy_updates
     WHERE framework=$1 AND COALESCE(version,'')=COALESCE($2,'') AND change_summary=$3
     ORDER BY ingested_at DESC
     LIMIT 1`,
    [source.framework, source.version || null, source.change_summary]
  );
  if (rows[0]) return { ...rows[0], existing: true };

  const inserted = await db.pool.query(
    `INSERT INTO policy_updates (id,framework,version,change_summary,effective_date,ingested_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,now())
     RETURNING *`,
    [source.framework, source.version || null, source.change_summary, source.effective_date || null]
  );
  return { ...inserted.rows[0], existing: false };
}

async function getSourcesForArticle(article) {
  if (article.section === 'policy') {
    const source = policySources.find(item =>
      item.framework === article.policy_framework && item.version === article.policy_version
    );
    if (!source) throw new Error(`Missing policy source definition for ${article.title}`);
    const policy = await ensurePolicySource(source);
    return { policyIds: [policy.id], intelItemIds: [] };
  }

  const headlineSet = new Set(article.source_headlines || []);
  const ensured = [];
  for (const item of sourceItems) {
    if (headlineSet.has(item.headline)) ensured.push(await ensureIntelItem(item));
  }

  const found = new Set(ensured.map(item => item.headline));
  const missing = [...headlineSet].filter(headline => !found.has(headline));
  if (missing.length) {
    const existing = await db.pool.query(
      'SELECT id, headline FROM intel_items WHERE headline = ANY($1::text[])',
      [missing]
    ).then(r => r.rows);
    ensured.push(...existing);
  }

  const allFound = new Set(ensured.map(item => item.headline));
  const stillMissing = [...headlineSet].filter(headline => !allFound.has(headline));
  if (stillMissing.length) throw new Error(`Missing source item(s) for ${article.title}: ${stillMissing.join('; ')}`);

  return { policyIds: [], intelItemIds: ensured.map(item => item.id) };
}

async function linkSources(articleId, { policyIds, intelItemIds }) {
  if (policyIds.length) {
    await db.pool.query('UPDATE policy_updates SET article_id=$1 WHERE id = ANY($2::uuid[])', [articleId, policyIds]);
  }
  if (intelItemIds.length) {
    await db.pool.query('UPDATE intel_items SET article_id=$1 WHERE id = ANY($2::uuid[])', [articleId, intelItemIds]);
  }
}

async function ensurePublishedArticle(article) {
  const slug = slugFor(article.title);
  const sources = await getSourcesForArticle(article);
  const existing = await db.pool.query(
    'SELECT id,title,slug,section,pipeline_status,published_at FROM articles WHERE slug=$1 ORDER BY created_at DESC LIMIT 1',
    [slug]
  ).then(r => r.rows[0] || null);

  if (existing) {
    if (existing.pipeline_status !== 'published') {
      await db.pool.query(
        `UPDATE articles
         SET pipeline_status='published', published_at=COALESCE(published_at, now())
         WHERE id=$1`,
        [existing.id]
      );
    }
    await linkSources(existing.id, sources);
    return { ...existing, pipeline_status: 'published', existing: true };
  }

  const inserted = await db.pool.query(
    `INSERT INTO articles
       (id,title,slug,section,body_md,access_tier,pipeline_status,published_at,view_count,read_time_min,created_at)
     VALUES
       (gen_random_uuid(),$1,$2,$3,$4,$5,'published',now(),0,$6,now())
     RETURNING id,title,slug,section,pipeline_status,published_at`,
    [article.title, slug, article.section, article.body_md, article.access_tier, readTimeMin(article.body_md)]
  ).then(r => r.rows[0]);

  await linkSources(inserted.id, sources);
  await db.logPipelineEvent({
    content_type: 'article',
    content_id: inserted.id,
    from_status: null,
    to_status: 'published',
    agent_name: 'Gwen',
    notes: 'GWEN-022 public intelligence article population',
  });

  return { ...inserted, existing: false };
}

async function counts() {
  const sectionCounts = await db.pool.query(`
    SELECT section, count(1)::int AS total
    FROM articles
    WHERE pipeline_status='published'
    GROUP BY section
    ORDER BY section
  `).then(r => r.rows);

  const sourceCounts = await db.pool.query(`
    SELECT type, count(1)::int AS total, count(1) FILTER (WHERE article_id IS NOT NULL)::int AS linked
    FROM intel_items
    GROUP BY type
    ORDER BY type
  `).then(r => r.rows);

  const policyCounts = await db.pool.query(`
    SELECT count(1)::int AS total, count(1) FILTER (WHERE article_id IS NOT NULL)::int AS linked
    FROM policy_updates
  `).then(r => r.rows[0]);

  return { section_counts: sectionCounts, source_counts: sourceCounts, policy_counts: policyCounts };
}

async function execute() {
  const seeded = [];
  for (const article of articles) seeded.push(await ensurePublishedArticle(article));
  return { seeded };
}

async function main() {
  if (COUNTS) {
    console.log(JSON.stringify(await counts(), null, 2));
    return;
  }

  if (!EXECUTE) {
    console.log(JSON.stringify({
      dry_run: true,
      count: articles.length,
      articles: articles.map(article => ({
        title: article.title,
        slug: slugFor(article.title),
        section: article.section,
        access_tier: article.access_tier,
      })),
    }, null, 2));
    return;
  }

  console.log(JSON.stringify(await execute(), null, 2));
}

if (require.main === module) {
  main()
    .catch(e => {
      console.error(JSON.stringify({ error: e.message }, null, 2));
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = {
  articles,
  slugFor,
  readTimeMin,
  ensurePublishedArticle,
  execute,
  counts,
};
