'use strict';

// One-shot recovery/backlog seeder for Ivan/Charlie innovation and growth radar.
//
// Dry run:
//   node seed_innovation_growth_radar.js
//
// Execute:
//   node seed_innovation_growth_radar.js --execute
//
// Verify:
//   node seed_innovation_growth_radar.js --counts

require('dotenv').config();
const db = require('./db/queries');

const EXECUTE = process.argv.includes('--execute');
const COUNTS = process.argv.includes('--counts');

const items = [
  {
    type: 'innovation',
    category: 'digital-identity',
    headline: 'NIST verifiable credential issuance work moves identity modernization from format to process',
    summary: 'NIST explains that mobile documents and W3C Verifiable Credentials require trusted issuance workflows, proofing, wallet behavior, relying-party validation, and revocation handling before organizations can depend on them operationally.',
    tags: ['NIST', 'verifiable-credentials', 'digital-identity', 'mDL'],
    priority: 'high',
    source_url: 'https://www.nist.gov/blogs/cybersecurity-insights/dmv-wallet-understanding-verifiable-digital-credential-issuance',
    content: 'Innovation focus: digital credential modernization is not solved by picking a credential format. Security teams need issuance assurance, revocation paths, relying-party validation, and exception handling before digital identity can become a resilient control.',
  },
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
    type: 'innovation',
    category: 'ai-security-platforms',
    headline: 'Frontier AI model access pushes security platforms toward adaptive vulnerability response',
    summary: 'CRN reported CrowdStrike partner messaging around frontier AI model access, with emphasis on helping partners adapt as AI-powered vulnerability discovery changes the speed of exposure management.',
    tags: ['AI', 'vulnerability-management', 'security-platforms', 'partners'],
    priority: 'high',
    source_url: 'https://www.crn.com/news/security/2026/crowdstrike-providing-massive-benefit-to-partners-with-access-to-frontier-ai-models-cto',
    content: 'Innovation focus: AI-powered vulnerability discovery makes static security programs brittle. Platform teams need tooling that can absorb model changes, reprioritize exposure quickly, and connect discovery to remediation without adding manual triage delay.',
  },
  {
    type: 'innovation',
    category: 'ai-risk-awareness',
    headline: 'NIST FISSEA agenda frames black-box AI trust as a human security behavior problem',
    summary: 'The 2026 FISSEA Spring Forum includes sessions on trust as an attack surface in black-box AI systems and protocol-based defense for AI-driven social engineering and synthetic media.',
    tags: ['NIST', 'FISSEA', 'AI-awareness', 'human-risk'],
    priority: 'high',
    source_url: 'https://www.nist.gov/news-events/events/2026/05/fissea-spring-forum-may-12-2026',
    content: 'Innovation focus: AI security awareness needs to move beyond tool novelty. Training should address automation bias, reduced scrutiny, synthetic media, and protocol-based verification when users rely on opaque AI systems.',
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
    category: 'channel-growth',
    headline: 'AI vulnerability surge increases partner demand for adaptable security platform skills',
    summary: 'CRN reported partner views that AI-accelerated vulnerability discovery is pushing customers toward security platforms and service providers that can consolidate tooling while keeping pace with fast-changing exposure risk.',
    tags: ['CRN', 'partners', 'AI', 'platform-security', 'growth'],
    priority: 'normal',
    source_url: 'https://www.crn.com/news/security/2026/crowdstrike-partners-ai-vulnerability-surge-means-it-s-time-to-pick-a-platform-in-security',
    content: 'Growth focus: security professionals and service providers can position around platform integration, exposure management, and practical remediation workflows. The market signal is demand for teams that reduce complexity while adapting to AI-driven risk velocity.',
  },
];

async function existingByHeadline(headline) {
  return db.pool.query(
    'SELECT * FROM intel_items WHERE headline=$1 ORDER BY ingested_at DESC LIMIT 1',
    [headline]
  ).then(r => r.rows[0] || null);
}

async function upsertItem(item) {
  const existing = await existingByHeadline(item.headline);
  const intelItem = existing || await db.createIntelItem({
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

  return { id: intelItem.id, type: item.type, headline: item.headline, existing: !!existing };
}

async function main() {
  if (COUNTS) {
    const { rows } = await db.pool.query(`
      SELECT source_type,
             count(*)::int AS total,
             count(*) FILTER (
               WHERE ready_for_awareness
                 AND NOT EXISTS (
                   SELECT 1
                   FROM briefings b
                   WHERE r.source_id = ANY(b.innovation_item_ids)
                      OR r.source_id = b.growth_item_id
                 )
             )::int AS unused_awareness,
             count(*) FILTER (WHERE ready_for_intel)::int AS ready_intel
      FROM intel_repository r
      WHERE source_type IN ('innovation', 'growth')
      GROUP BY source_type
      ORDER BY source_type
    `);
    const radarSample = await db.getIntelRadarItems({ limit: 3 });
    console.log(JSON.stringify({
      counts: rows,
      radar_sample: radarSample.map(item => ({
        type: item.type,
        headline: item.headline,
        ready_for_awareness: item.ready_for_awareness,
        ready_for_intel: item.ready_for_intel,
        has_article: item.has_article,
        used_in_briefing: item.used_in_briefing,
      })),
    }, null, 2));
    return;
  }

  if (!EXECUTE) {
    console.log(JSON.stringify({ dry_run: true, count: items.length, items }, null, 2));
    return;
  }

  const seeded = [];
  for (const item of items) seeded.push(await upsertItem(item));
  console.log(JSON.stringify({ seeded }, null, 2));
}

main()
  .catch(e => {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
