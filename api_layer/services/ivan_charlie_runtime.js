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
  // ── Innovation (Tier-1 / Tier-2) ──────────────────────────────────────────
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
  // ── Growth (Tier-3 / Tier-4) ──────────────────────────────────────────────
  {
    type: 'growth',
    category: 'workforce-security',
    url: 'https://www.securityweek.com/category/cybersecurity-business/feed/',
    tags: ['securityweek', 'workforce', 'growth', 'tier-4'],
  },
  {
    type: 'growth',
    category: 'professional-development',
    url: 'https://www.csoonline.com/feed/',
    tags: ['cso', 'professional-development', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'security-careers',
    url: 'https://www.helpnetsecurity.com/feed/',
    tags: ['help-net-security', 'careers', 'growth', 'tier-3'],
  },
  {
    type: 'growth',
    category: 'certification-training',
    url: 'https://blog.isc2.org/blog/rss.xml',
    tags: ['isc2', 'certification', 'professional-development', 'growth', 'tier-3'],
  },
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

async function collectIntelItems() {
  const results = await Promise.allSettled(FEEDS.map(async feed => {
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
    throw new Error(`All innovation/growth feeds failed or produced no recent items: ${errors.join('; ')}`);
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

// Submit all new qualifying items up to per-type daily caps.
function selectRequiredItems(items) {
  return [
    ...items.filter(item => item.type === 'innovation').slice(0, DAILY_MAX_INNOVATION),
    ...items.filter(item => item.type === 'growth').slice(0, DAILY_MAX_GROWTH),
  ];
}

// Cycle execution

async function executeIvanCharlieIngest(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_START',
    task_id: task.id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  await db.logPipelineEvent({
    content_type: 'system',
    content_id:   task.id,
    from_status:  'queued',
    to_status:    'in_progress',
    agent_name:   'Ivan/Charlie',
    notes:        'Ingest cycle started — scanning innovation and growth feeds',
  });

  try {
    const { items: allItems, feedErrors } = await collectIntelItems();
    const newItems  = await filterNewItems(allItems);
    const selected  = selectRequiredItems(newItems);
    const innovationCount = selected.filter(item => item.type === 'innovation').length;
    const growthCount     = selected.filter(item => item.type === 'growth').length;

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
    if (innovationCount < DAILY_MIN_INNOVATION || growthCount < DAILY_MIN_GROWTH) {
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
      task_id: task.id, submitted,
      innovation_this_cycle: innovationCount,
      growth_this_cycle: growthCount,
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
