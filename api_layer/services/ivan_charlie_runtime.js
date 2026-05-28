'use strict';

// services/ivan_charlie_runtime.js
// Ivan/Charlie acquisition runtime. Polls agent_tasks for queued Ivan/Charlie
// work, queries innovation and growth feeds, deduplicates against intel_items,
// and submits qualifying items to POST /api/pipeline/intel-items.
//
// Token strategy: mirrors ruth_runtime.js - self-provisions a fresh JWT at
// startup, stores the hash in agent_tokens. Requires AGENT_JWT_SECRET and
// API_BASE_URL in env.
//
// Run within the main server process - polled by the scheduler cron.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const POLL_WINDOW_HOURS = 12;
const RECENCY_HOURS = 720;

// Daily intake targets per Hector directive 2026-05-25:
// Innovation: 6–10 per day (double growth), Growth: 3–5 per day.
// Each cycle submits all new qualifying items up to the MAX cap.
// The daily minimum is enforced by runAcquisitionDeliveryCheck in scheduler.js.
const DAILY_MIN_INNOVATION = 6;
const DAILY_MAX_INNOVATION = 10;
const DAILY_MIN_GROWTH     = 3;
const DAILY_MAX_GROWTH     = 5;

// Tier 1-2: Standards bodies, frontier R&D (Ivan's domain — emerging tech, AI, PQC, hardware)
// Tier 3-4: Professional development, workforce strategy (Charlie's domain — certs, training, executive alignment)
// Source taxonomy per scoutsGuide-Innovation&Growth.md
const FEEDS = [
  // ── Innovation (Tier-1) ────────────────────────────────────────────────────
  {
    type: 'innovation',
    category: 'ai-security-standards',
    url: 'https://www.nist.gov/blogs/cybersecurity-insights/rss.xml',
    tags: ['nist', 'standards', 'innovation', 'tier-1'],
  },
  {
    type: 'innovation',
    category: 'frontier-research',
    url: 'https://www.technologyreview.com/feed/',
    tags: ['mit-tech-review', 'ai', 'quantum', 'innovation', 'tier-1'],
  },
  {
    type: 'innovation',
    category: 'academic-research',
    url: 'https://news.mit.edu/rss/research',
    tags: ['mit-news', 'academic', 'ai', 'innovation', 'tier-1'],
  },
  {
    type: 'innovation',
    category: 'academic-research',
    url: 'https://ethz.ch/en/news-and-events/eth-news.rss',
    tags: ['eth-zurich', 'academic', 'cryptography', 'innovation', 'tier-1'],
  },
  {
    type: 'innovation',
    category: 'quantum-computing',
    url: 'https://quantumzeitgeist.com/feed/',
    tags: ['quantum-zeitgeist', 'quantum', 'pqc', 'innovation', 'tier-1'],
  },
  // ── Innovation (Tier-2) ────────────────────────────────────────────────────
  {
    type: 'innovation',
    category: 'enterprise-security-research',
    url: 'https://feeds.arstechnica.com/arstechnica/security',
    tags: ['ars-technica', 'research', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'threat-research',
    url: 'https://krebsonsecurity.com/feed/',
    tags: ['krebs', 'threat-research', 'innovation', 'tier-1'],
  },
  {
    type: 'innovation',
    category: 'security-news',
    url: 'https://www.darkreading.com/rss.xml',
    tags: ['dark-reading', 'security-news', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'vulnerability-research',
    url: 'https://www.bleepingcomputer.com/feed/',
    tags: ['bleeping-computer', 'vulnerabilities', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'attack-intelligence',
    url: 'https://thehackernews.com/feeds/posts/default',
    tags: ['hacker-news', 'attack-intel', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'cloud-security',
    url: 'https://cloudblog.withgoogle.com/rss/',
    tags: ['google-cloud', 'cloud', 'ai-security', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'ai-hardware',
    url: 'https://nvidianews.nvidia.com/rss/all.rss',
    tags: ['nvidia', 'ai-hardware', 'gpu', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'threat-intelligence',
    url: 'https://research.checkpoint.com/feed/',
    tags: ['checkpoint', 'threat-intel', 'malware', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'threat-intelligence',
    // Note: talosintelligence.com/reputation is the IP lookup tool — using the blog feed instead.
    url: 'https://blog.talosintelligence.com/feeds/posts/default',
    tags: ['talos', 'cisco', 'threat-intel', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'cloud-security',
    url: 'https://www.zscaler.com/blogs.rss',
    tags: ['zscaler', 'zero-trust', 'cloud-security', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'ics-ot-security',
    url: 'https://www.industrialdefender.com/ics-cybersecurity-blog/feed/',
    tags: ['industrial-defender', 'ics', 'ot', 'critical-infrastructure', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'appsec-research',
    url: 'https://www.aikido.dev/blog/rss.xml',
    tags: ['aikido', 'appsec', 'devsec', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'security-news',
    url: 'https://www.securityweek.com/feed/',
    tags: ['securityweek', 'security-news', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'security-news',
    url: 'https://www.csoonline.com/feed/',
    tags: ['cso', 'security-news', 'innovation', 'tier-2'],
  },
  {
    type: 'innovation',
    category: 'security-news',
    url: 'https://www.helpnetsecurity.com/feed/',
    tags: ['help-net-security', 'security-news', 'innovation', 'tier-2'],
  },
  // ── Growth (Tier-3) — career development, certifications, courses, webinars ──
  // SecurityWeek / CSO Online / HelpNetSecurity removed: they publish security news
  // (CVEs, patches, breaches), not career development content. Those feeds belong
  // in innovation sources, not Charlie's growth lane.
  {
    type: 'growth',
    category: 'certification-training',
    url: 'https://blog.isc2.org/blog/rss.xml',
    tags: ['isc2', 'certification', 'professional-development', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'online-learning',
    // Class Central "The Report" — covers online learning, certifications, career development
    url: 'https://www.classcentral.com/report/feed/',
    tags: ['class-central', 'online-learning', 'mooc', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'open-learning',
    // MIT Open Learning news — covers OCW, MicroMasters, professional programs
    url: 'https://openlearning.mit.edu/news-insights/rss.xml',
    tags: ['mit-open-learning', 'ocw', 'academic', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'certification-training',
    // Cisco NetAcad blog — certifications, CCNA/CCNP, networking career content
    url: 'https://blog.netacad.com/feed/',
    tags: ['cisco', 'netacad', 'networking', 'certification', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'ai-training',
    // NVIDIA Developer blog — Deep Learning Institute, AI certifications, training programs
    url: 'https://developer.nvidia.com/blog/feed/',
    tags: ['nvidia', 'dli', 'ai-training', 'certification', 'growth', 'tier-3'],
  },
  // ── Growth additions per Hector directive 2026-05-26 ─────────────────────────
  {
    type: 'growth',
    category: 'online-learning',
    // Open Culture — curates free courses, lectures, textbooks, and MOOC roundups across disciplines
    url: 'https://www.openculture.com/feed',
    tags: ['open-culture', 'free-courses', 'online-learning', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'online-learning',
    // DigitalDefynd — 96,000+ curated programs blog covering certs, online degrees, career paths
    url: 'https://digitaldefynd.com/feed/',
    tags: ['digitaldefynd', 'online-learning', 'programs', 'certifications', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'online-learning',
    // LearnVern — 150+ free courses and webinars; blog covers workforce upskilling trends
    url: 'https://www.learnvern.com/blog/feed/',
    tags: ['learnvern', 'free-courses', 'webinars', 'online-learning', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'open-learning',
    // OpenLearn — The Open University's free learning platform; publishes new course and learning guides
    url: 'https://www.open.edu/openlearn/rss.xml',
    tags: ['openlearn', 'open-university', 'free-courses', 'academic', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'developer-training',
    // The Odin Project — full-stack developer roadmap blog covering curriculum updates and learning paths
    url: 'https://www.theodinproject.com/blog.rss',
    tags: ['odin-project', 'web-development', 'developer-roadmap', 'free-training', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'web-security-training',
    // PortSwigger Research — Web Security Academy learning content, new labs, and technique write-ups
    url: 'https://portswigger.net/research/rss',
    tags: ['portswigger', 'web-security-academy', 'appsec-training', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'cryptography-training',
    // CryptoHack — interactive cryptography learning platform blog; challenge releases and technique guides
    url: 'https://blog.cryptohack.org/feed.xml',
    tags: ['cryptohack', 'cryptography', 'security-training', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'security-training',
    // pwn.college — binary exploitation and CTF training; blog covers new challenges and skill modules
    url: 'https://pwn.college/blog/feed.xml',
    tags: ['pwn-college', 'ctf', 'exploitation', 'security-training', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'certification-training',
    // Red Hat Training blog — RHCSA/RHCE certification news, course updates, enterprise Linux career content
    url: 'https://www.redhat.com/en/rss/blog',
    tags: ['redhat', 'linux', 'rhcsa', 'certification', 'enterprise-training', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'certification-training',
    // Microsoft Learn community blog — learning paths, cert prep, Azure/M365 career content
    url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89692/rss/board?board.id=MicrosoftLearnBlog',
    tags: ['microsoft-learn', 'azure', 'certification', 'career-development', 'growth', 'tier-3'],
  },
  // ── Policy & Guidelines (Tier-2) ─────────────────────────────────────────────
  // Regulatory updates, compliance standards, and cybersecurity policy feeds.
  // Per Hector directive 2026-05-28. Sources without RSS are listed below as static refs.
  {
    type: 'policy',
    category: 'healthcare-compliance',
    url: 'https://www.hipaajournal.com/feed/',
    tags: ['hipaa', 'healthcare-compliance', 'phi', 'policy', 'tier-2'],
  },
  {
    type: 'policy',
    category: 'cyber-law-enforcement',
    url: 'https://www.fbi.gov/feeds/fbi-stories-and-news.rss',
    tags: ['fbi', 'cyber', 'law-enforcement', 'policy', 'tier-2'],
  },
  {
    type: 'policy',
    category: 'consumer-protection',
    // FTC news feed — enforcement actions, rulemaking, privacy and data security guidance
    url: 'https://www.ftc.gov/news-events/news/rss.xml',
    tags: ['ftc', 'consumer-protection', 'gramm-leach-bliley', 'privacy', 'policy', 'tier-2'],
  },
  {
    type: 'policy',
    category: 'cyber-best-practices',
    // CISA alerts and advisories — best practices, ICS, critical infrastructure guidance
    url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml',
    tags: ['cisa', 'advisories', 'best-practices', 'critical-infrastructure', 'policy', 'tier-2'],
  },
  {
    type: 'policy',
    category: 'federal-legislation',
    // GovInfo RSS — new federal register and congressional publications
    url: 'https://www.govinfo.gov/rss/bills.xml',
    tags: ['congress', 'legislation', 'federal', 'policy', 'tier-2'],
  },
  {
    type: 'policy',
    category: 'nist-standards',
    // NIST cybersecurity publications and SP 800-series updates
    url: 'https://www.nist.gov/blogs/cybersecurity-insights/rss.xml',
    tags: ['nist', 'standards', 'frameworks', 'policy', 'tier-1'],
  },
  // ── Static regulatory reference pages — no RSS feed available ────────────────
  // These are reference or manual pages; Charlie cannot ingest them via feed polling.
  // Use as citation context in Barbara's normalization prompt when relevant.
  //
  // https://www.sans.org/information-security-policy        — SANS policy templates
  // https://www.pcisecuritystandards.org/standards/         — PCI DSS standards
  // https://ncua.gov/regulation-supervision                 — NCUA credit union regs
  // https://grants.nih.gov/policy-and-compliance            — NIH grants policy
  // https://www.justice.gov/jm/jm-9-48000-computer-fraud   — DOJ CFAA manual
  // https://www.nacdl.org/Landing/ComputerFraudandAbuseAct — NACDL CFAA resource
  // https://www.ncbi.nlm.nih.gov/books/NBK500019/          — NCBI health IT security
  //
  // ── Static catalog resources — no RSS feed available ─────────────────────────
  // These are course directory/catalog pages. Charlie cannot ingest them via RSS.
  // Integration path: add a dedicated scraper or periodic manual intake task.
  //
  // https://www.mindluster.com/            — 300,000 online courses catalog
  // https://training.fema.gov/is/crslist.aspx — FEMA IS course list (risk mgmt, leadership)
  // https://ocw.mit.edu/search/            — MIT OCW catalog (MIT news already ingested via open learning feed)
  // https://pll.harvard.edu/catalog/free   — Harvard free course catalog
  // https://www.redhat.com/en/services/training/all-courses-exams — Red Hat exam list (static)
  // https://skillsbuild.org/               — IBM SkillsBuild (no public RSS)
  // https://cloud.google.com/learn/training — Google Cloud training catalog
  // https://quantum.cern/introduction-quantum-computing — CERN quantum intro (single static page)
  // https://qosf.org/                      — Quantum Open Source Foundation (no active feed)
  // https://monitsharma.github.io/Learn-Quantum-Computing-For-Free/ — GitHub resource page
  // https://oyc.yale.edu/courses           — Yale Open Courses (static catalog)
  // https://www.hacksplaining.com/lessons  — Hacksplaining (static lesson set, no RSS)
];

// Token management

let _ivanCharlieToken = null;

async function ensureIvanCharlieToken() {
  if (_ivanCharlieToken) {
    try {
      jwt.verify(_ivanCharlieToken, process.env.AGENT_JWT_SECRET);
      return _ivanCharlieToken;
    } catch (_) {
      // Token expired or invalid - re-provision below
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Ivan/Charlie', agent_team: 'acquisition' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Ivan/Charlie', hash);
  _ivanCharlieToken = token;
  return token;
}

// Internal API caller

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureIvanCharlieToken();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Agent ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE()}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json.error?.message || json.error || json.message || JSON.stringify(json)}`);
  }
  return json;
}

async function feedText(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

// Feed normalization

function cutoffDate() {
  return new Date(Date.now() - RECENCY_HOURS * 60 * 60 * 1000);
}

function isRecent(value) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= cutoffDate();
}

function xmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseFeedItems(xml) {
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const atomItems = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  return [...rssItems, ...atomItems];
}

function normalizeFeedItem(block, feed) {
  const published = xmlValue(block, 'pubDate') || xmlValue(block, 'published') || xmlValue(block, 'updated') || xmlValue(block, 'dc:date') || xmlValue(block, 'date');
  if (!isRecent(published)) return null;

  const title = decodeXml(xmlValue(block, 'title'));
  const summary = decodeXml(xmlValue(block, 'description') || xmlValue(block, 'summary') || title);
  const link = decodeXml(xmlValue(block, 'link')) || feed.url;

  if (!title || summary.length < 20) return null;

  return {
    type: feed.type,
    category: feed.category,
    headline: title.slice(0, 220),
    summary: summary.slice(0, 1200),
    tags: feed.tags,
    priority: feed.type === 'growth' ? 'normal' : 'high',
    source_url: link,
    published_at: published,
  };
}

// topicFilter: 'innovation' | 'policy' | 'growth' | null (null = all types)
async function collectIntelItems(topicFilter = null) {
  const feeds = topicFilter ? FEEDS.filter(f => f.type === topicFilter) : FEEDS;

  const results = await Promise.allSettled(feeds.map(async feed => {
    const xml = await feedText(feed.url);
    return parseFeedItems(xml).map(block => normalizeFeedItem(block, feed)).filter(Boolean);
  }));

  const items = [];
  const errors = [];
  for (const result of results) {
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push(result.reason.message);
  }

  if (!items.length && errors.length) {
    throw new Error(`All ${topicFilter || 'innovation/growth/policy'} feeds failed or produced no recent items: ${errors.join('; ')}`);
  }

  return { items, feedErrors: errors };
}

async function existingHeadlines(headlines) {
  if (!headlines.length) return new Set();
  const rows = await db.pool.query(
    'SELECT headline FROM intel_items WHERE headline = ANY($1)',
    [headlines]
  ).then(r => r.rows);
  return new Set(rows.map(r => r.headline));
}

async function filterNewItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = `${item.type}|${item.headline}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const existing = await existingHeadlines(unique.map(i => i.headline));
  return unique.filter(item => !existing.has(item.headline));
}

const DAILY_MAX_POLICY = 8;

// Submit all new qualifying items up to per-type daily caps.
// topicFilter restricts which types are selected; null = all types.
function selectRequiredItems(items, topicFilter = null) {
  const filter = type => !topicFilter || topicFilter === type;
  return [
    ...(filter('innovation') ? items.filter(item => item.type === 'innovation').slice(0, DAILY_MAX_INNOVATION) : []),
    ...(filter('growth')     ? items.filter(item => item.type === 'growth').slice(0, DAILY_MAX_GROWTH) : []),
    ...(filter('policy')     ? items.filter(item => item.type === 'policy').slice(0, DAILY_MAX_POLICY) : []),
  ];
}

// Cycle execution
// opts.topicFilter: 'innovation' | 'policy' | 'growth' | null (null = all types)

async function executeIvanCharlieIngest(task, opts = {}) {
  const ts          = new Date().toISOString();
  const topicFilter = opts.topicFilter || null;
  const topicLabel  = topicFilter || 'all';

  console.log(JSON.stringify({
    ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_START',
    task_id: task.id, topic: topicLabel,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  await db.logPipelineEvent({
    content_type: 'system',
    content_id:   task.id,
    from_status:  'queued',
    to_status:    'in_progress',
    agent_name:   'Ivan/Charlie',
    notes:        `Ingest cycle started — topic: ${topicLabel}`,
  });

  try {
    const { items: allItems, feedErrors } = await collectIntelItems(topicFilter);
    const newItems  = await filterNewItems(allItems);
    const selected  = selectRequiredItems(newItems, topicFilter);
    const innovationCount = selected.filter(item => item.type === 'innovation').length;
    const growthCount     = selected.filter(item => item.type === 'growth').length;
    const policyCount     = selected.filter(item => item.type === 'policy').length;

    if (selected.length === 0) {
      await db.logPipelineEvent({
        content_type: 'system',
        content_id:   task.id,
        from_status:  'in_progress',
        to_status:    'no_new_items',
        agent_name:   'Ivan/Charlie',
        notes:        `All ${allItems.length} feed items already ingested — deduplication complete, no submission needed`,
      });
      await db.updateTask(task.id, { status: 'complete' });
      console.log(JSON.stringify({ ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_DEDUPED', task_id: task.id, allItems: allItems.length }));
      return;
    }

    const submitted = [];
    for (const item of selected) {
      const { source_url, published_at, ...payload } = item;
      const result = await apiCall('/api/pipeline/intel-items', 'POST', {
        ...payload,
        summary: `${payload.summary}\n\nSource: ${source_url}\nPublished: ${published_at}`,
      });
      submitted.push({ type: item.type, id: result.id });
      await db.logPipelineEvent({
        content_type: 'system',
        content_id:   result.id,
        from_status:  'in_progress',
        to_status:    'ingested',
        agent_name:   'Ivan/Charlie',
        notes: `type: ${item.type} | ${item.headline.slice(0, 100)}`,
      });
    }

    await db.updateTask(task.id, { status: 'complete' });

    // Warn (non-fatal) when this cycle is below minimums — daily totals are
    // validated at 06:05 CT by runAcquisitionDeliveryCheck in scheduler.js.
    // Skip the minimum check for targeted topic runs — they are supplemental.
    if (!topicFilter && (innovationCount < DAILY_MIN_INNOVATION || growthCount < DAILY_MIN_GROWTH)) {
      console.warn(JSON.stringify({
        ts, runtime: 'ivan_charlie', event: 'CYCLE_BELOW_DAILY_MIN',
        task_id: task.id,
        innovation_this_cycle: innovationCount, innovation_min: DAILY_MIN_INNOVATION,
        growth_this_cycle: growthCount, growth_min: DAILY_MIN_GROWTH,
        note: 'Below minimum for this cycle — daily totals checked by delivery check at 06:05 CT',
      }));
    }

    if (feedErrors.length > 0) {
      console.warn(JSON.stringify({ ts, runtime: 'ivan_charlie', event: 'FEED_ERRORS', feedErrors }));
    }

    console.log(JSON.stringify({
      ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_COMPLETE',
      task_id: task.id, submitted, topic: topicLabel,
      innovation_this_cycle: innovationCount,
      growth_this_cycle: growthCount,
      policy_this_cycle: policyCount,
    }));
  } catch (e) {
    await db.logPipelineEvent({
      content_type: 'system',
      content_id:   task.id,
      from_status:  'in_progress',
      to_status:    'failed',
      agent_name:   'Ivan/Charlie',
      notes:        e.message.slice(0, 300),
    });
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'IVAN_CHARLIE_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Ivan/Charlie runtime error: ${e.message}. Innovation and growth acquisition requires manual intervention.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'ivan_charlie', event: 'RUNTIME_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

// Poll loop

async function pollIvanCharlieTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Ivan/Charlie'
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeIvanCharlieIngest(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'ivan_charlie', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = {
  pollIvanCharlieTasks,
  ensureIvanCharlieToken,
  executeIvanCharlieIngest,
  DAILY_MIN_INNOVATION,
  DAILY_MIN_GROWTH,
};
