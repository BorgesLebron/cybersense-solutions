'use strict';

require('dotenv').config();
const db = require('./db/queries');

const EXECUTE = process.argv.includes('--execute');

const edition = {
  date: '2026-05-11',
  number: 121,
  subject: 'Edition 121 - Trust Surfaces Under Pressure',
  file_path: 'newsletter/2026/May/05112026_edition121.html',
  description: 'Canvas/Instructure extortion pressure, PAN-OS captive portal exploitation, Oracle monthly critical patch cadence, Cloudflare growth learning, Linux Copy Fail, and quantum infrastructure advances.',
};

const threats = [
  {
    cve_id: 'SH-CANVAS-20260507',
    threat_name: 'ShinyHunters defaces Canvas login pages after Instructure breach claim',
    severity: 'high',
    cvss_score: 0,
    category: 'identity-and-edtech-extortion',
    source_url: 'https://techcrunch.com/2026/05/07/hackers-deface-school-login-pages-after-claiming-another-instructure-hack/',
    raw_data: {
      title: 'Hackers deface school login pages after claiming another Instructure hack',
      source_url: 'https://techcrunch.com/2026/05/07/hackers-deface-school-login-pages-after-claiming-another-instructure-hack/',
      summary: 'ShinyHunters reportedly defaced Canvas login pages at several schools after a prior Instructure breach claim, using visible login-page changes to increase extortion pressure.',
      content: 'Threat focus: familiar login surfaces can become part of the attack and extortion channel. Users should avoid repeated login attempts during anomalies, verify service status through trusted channels, and report unexpected portal changes. Administrators should monitor login-page integrity and prepare out-of-band communications before an incident.',
    },
    tags: ['ShinyHunters', 'Canvas', 'Instructure', 'login-page-defacement', 'education'],
    priority: 'high',
  },
  {
    cve_id: 'CVE-2026-0300',
    threat_name: 'PAN-OS Captive Portal zero-day exploitation for unauthenticated remote code execution',
    severity: 'critical',
    cvss_score: 9.8,
    category: 'edge-device-rce',
    source_url: 'https://unit42.paloaltonetworks.com/captive-portal-zero-day/',
    raw_data: {
      title: 'Threat Brief: Exploitation of PAN-OS Captive Portal Zero-Day for Unauthenticated Remote Code Execution',
      source_url: 'https://unit42.paloaltonetworks.com/captive-portal-zero-day/',
      summary: 'Unit 42 reported limited exploitation of CVE-2026-0300 against PAN-OS User-ID Authentication Portal services, with shellcode injection, tunneling tools, Active Directory enumeration, and log destruction.',
      content: 'Threat focus: exposed authentication portals on perimeter firewalls create an immediate path from internet exposure to privileged infrastructure access. Scope exposed User-ID Authentication Portal services, restrict access to trusted internal zones, disable unneeded portal exposure, apply vendor guidance, and validate telemetry for post-exploitation tunneling and cleanup activity.',
    },
    tags: ['CVE-2026-0300', 'PAN-OS', 'Captive Portal', 'RCE', 'EarthWorm', 'ReverseSocks5'],
    priority: 'immediate',
  },
  {
    cve_id: 'ORA-CSPU-202605',
    threat_name: 'Oracle monthly CSPU cadence requires patch management realignment',
    severity: 'medium',
    cvss_score: 0,
    category: 'enterprise-patch-management',
    source_url: 'https://cipherssecurity.com/oracle-cspu-monthly-patch-management-automation-guide/',
    raw_data: {
      title: 'Oracle CSPU Monthly Patch Management Automation Guide',
      source_url: 'https://cipherssecurity.com/oracle-cspu-monthly-patch-management-automation-guide/',
      summary: 'Oracle is moving critical security patch delivery toward a monthly CSPU cadence, requiring customer-managed environments to plan, test, and deploy high-priority fixes more frequently.',
      content: 'Threat focus: patch windows that were designed around quarterly Oracle CPUs may leave critical vulnerabilities exposed longer than necessary. Security and platform teams should update patch calendars, automate inventory validation, rehearse dependency testing, and define escalation criteria for monthly critical fixes.',
    },
    tags: ['Oracle', 'CSPU', 'patch-management', 'vulnerability-response'],
    priority: 'normal',
  },
];

const innovation = [
  {
    type: 'innovation',
    category: 'linux-kernel-security',
    headline: 'Copy Fail shows AI-assisted vulnerability discovery compressing Linux risk timelines',
    summary: 'Unit 42 analyzed CVE-2026-31431, a reliable Linux local privilege escalation affecting mainstream distributions, Kubernetes nodes, CI/CD hosts, and multi-tenant environments.',
    tags: ['CVE-2026-31431', 'Linux', 'Kubernetes', 'AI-assisted-discovery'],
    priority: 'high',
    source_url: 'https://unit42.paloaltonetworks.com/cve-2026-31431-copy-fail/',
    content: 'Innovation focus: defenders must account for faster vulnerability discovery and weaponization. Patch prioritization, container-host isolation, and CI/CD hardening need to assume that reliable local privilege escalation paths will move quickly from disclosure to operational pressure.',
  },
  {
    type: 'innovation',
    category: 'quantum-infrastructure',
    headline: 'Quantum networking, cloud access, and application validation move toward practical infrastructure',
    summary: 'AFCEA reported advances in quantum networking, quantum cloud availability, hybrid application tooling, and verification processes for quantum applications.',
    tags: ['quantum', 'cloud', 'application-development', 'infrastructure'],
    priority: 'normal',
    source_url: 'https://www.afcea.org/signal-media/emerging-edge/industry-advances-quantum-networking-cloud-and-application-development',
    content: 'Innovation focus: quantum readiness is becoming an infrastructure and application discipline, not only a hardware milestone. Teams should watch for repeatable validation methods, hybrid classical-quantum workflow tooling, and practical use cases in finance, defense, logistics, and security.',
  },
];

const growth = {
  type: 'growth',
  category: 'professional-development',
  headline: 'Cloudflare learning event supports security practitioner growth',
  summary: 'A Cloudflare registration event was selected as the growth item for Edition 121, supporting continued practitioner development around security and infrastructure topics.',
  tags: ['Cloudflare', 'professional-development', 'security-learning'],
  priority: 'normal',
  source_url: 'https://cloudflare.registration.goldcast.io/events/f58f0a83-30f2-4a54-a109-9d4f6c321f54',
  content: 'Growth focus: structured vendor learning helps practitioners keep pace with fast-moving infrastructure and security changes. This event is positioned as a practical learning opportunity alongside the week’s trusted-surface and patch-cadence themes.',
};

const training = {
  title: 'ShinyHunters Breach of Canvas Instructure',
  type: 'training_byte',
  phase: 'library',
  zt_module: 'identity-verification',
  access_tier: 'freemium',
  duration_min: 3,
  content_url: 'https://techcrunch.com/2026/05/07/hackers-deface-school-login-pages-after-claiming-another-instructure-hack/',
};

function briefingBody(rows) {
  const threatText = rows.threats.map((t, i) => `### Threat ${i + 1}: ${t.threat_name}\n${t.raw_data.content}\nSource: ${t.source_url}`).join('\n\n');
  const innovationText = rows.innovations.map((item, i) => `### Innovation ${i + 1}: ${item.headline}\n${item.summary}\n${item.content}\nSource: ${item.source_url}`).join('\n\n');
  return `${threatText}\n\n---\n\n### Training Byte: ${training.title}\nWhen a familiar Canvas or school login page changes unexpectedly, users should stop, verify through a trusted channel, and report the anomaly before submitting credentials.\n\n---\n\n### Growth: ${rows.growth.headline}\n${rows.growth.summary}\n${rows.growth.content}\nSource: ${rows.growth.source_url}\n\n---\n\n${innovationText}`;
}

async function seed() {
  const existing = await db.getBriefingByDate(edition.date);
  if (existing) throw new Error(`Briefing already exists for ${edition.date}: ${existing.id}`);

  const existingNumber = await db.pool.query('SELECT id FROM briefings WHERE edition_number=$1', [edition.number]).then(r => r.rows[0]);
  if (existingNumber) throw new Error(`Edition ${edition.number} already exists: ${existingNumber.id}`);

  const createdThreats = [];
  for (const item of threats) {
    let threat = await db.pool.query(
      `SELECT * FROM threat_records WHERE cve_id = $1 OR source_url = $2 ORDER BY ingested_at DESC LIMIT 1`,
      [item.cve_id, item.source_url]
    ).then(r => r.rows[0] || null);
    if (!threat) {
      threat = await db.createThreatRecord({ ...item, ingested_by: 'Rick' });
    }
    await db.processIntoRepository({
      source_type: 'threat',
      source_id: threat.id,
      normalized_data: item.raw_data,
      correlation_tags: item.tags,
      processed_by: 'Barbara',
      ready_for_intel: true,
      ready_for_awareness: true,
    });
    createdThreats.push(threat);
  }

  const createdInnovations = [];
  for (const item of innovation) {
    const intel = await db.createIntelItem({
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
      source_id: intel.id,
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
    createdInnovations.push(intel);
  }

  const growthItem = await db.createIntelItem({
    type: growth.type,
    category: growth.category,
    headline: growth.headline,
    summary: growth.summary,
    tags: growth.tags,
    priority: growth.priority,
    ingested_by: 'Ivan/Charlie',
  });
  await db.processIntoRepository({
    source_type: 'growth',
    source_id: growthItem.id,
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

  const trainingModule = await db.createTrainingModule({
    title: training.title,
    type: training.type,
    phase: training.phase,
    zt_module: training.zt_module,
    access_tier: training.access_tier,
    duration_min: training.duration_min,
    content_url: training.content_url,
    created_by: 'Kirby',
  });
  await db.advanceModuleStatus(trainingModule.id, 'published');

  const briefing = await db.createBriefing({
    edition_date: edition.date,
    edition_number: edition.number,
    subject_line: edition.subject,
    body_md: briefingBody({ threats: createdThreats, innovations: innovation, growth }),
    threat_item_ids: createdThreats.map(t => t.id),
    innovation_item_ids: createdInnovations.map(i => i.id),
    growth_item_id: growthItem.id,
    training_byte_id: trainingModule.id,
    file_path: edition.file_path,
    description: edition.description,
  });

  const transitions = [
    [null, 'draft', 'Ruth', 'Emergency Edition 121 draft created from Hector-selected topics'],
    ['draft', 'dev_edit', 'Peter', 'Emergency developmental edit accepted for HITL recovery'],
    ['dev_edit', 'eic_review', 'Ed', 'Emergency EIC review accepted for HITL recovery'],
    ['eic_review', 'qa', 'Jeff', 'Emergency QA pass for HITL recovery'],
    ['qa', 'maya', 'Maya', 'Emergency editorial approval for HITL recovery'],
    ['maya', 'approved', 'Maya', 'Edition 121 staged for Hector HITL approval'],
  ];

  for (const [from_status, to_status, agent_name, notes] of transitions) {
    if (from_status !== null) await db.advanceBriefingStatus(briefing.id, to_status);
    await db.logPipelineEvent({ content_type: 'briefing', content_id: briefing.id, from_status, to_status, agent_name, notes });
  }

  return {
    briefing_id: briefing.id,
    edition_number: edition.number,
    edition_date: edition.date,
    file_path: edition.file_path,
    public_url: `https://cybersense.solutions/${edition.file_path}`,
    threat_ids: createdThreats.map(t => t.id),
    innovation_ids: createdInnovations.map(i => i.id),
    growth_id: growthItem.id,
    training_byte_id: trainingModule.id,
  };
}

async function main() {
  if (!EXECUTE) {
    console.log(JSON.stringify({ dry_run: true, edition, threats, innovation, growth, training }, null, 2));
    return;
  }

  const result = await seed();
  console.log(JSON.stringify({ created: true, ...result }, null, 2));
}

main()
  .catch(e => {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
