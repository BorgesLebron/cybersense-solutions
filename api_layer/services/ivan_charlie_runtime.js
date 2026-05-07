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
const RECENCY_HOURS = 168;

const FEEDS = [
  {
    type: 'innovation',
    category: 'cybersecurity-innovation',
    url: 'https://www.nist.gov/blogs/cybersecurity-insights/rss.xml',
    tags: ['nist', 'innovation'],
  },
  {
    type: 'innovation',
    category: 'security-research',
    url: 'https://www.cisa.gov/news-events/cybersecurity-advisories.xml',
    tags: ['cisa', 'security-research'],
  },
  {
    type: 'growth',
    category: 'cybersecurity-market',
    url: 'https://www.securityweek.com/category/cybersecurity-business/feed/',
    tags: ['securityweek', 'growth'],
  },
  {
    type: 'growth',
    category: 'channel-growth',
    url: 'https://www.crn.com/news/security/rss.xml',
    tags: ['crn', 'growth'],
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
  const published = xmlValue(block, 'pubDate') || xmlValue(block, 'published') || xmlValue(block, 'updated');
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
    priority: feed.type === 'growth' ? 'medium' : 'high',
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

  return items;
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

function selectRequiredItems(items) {
  const innovation = items.find(item => item.type === 'innovation');
  const growth = items.find(item => item.type === 'growth');
  return [innovation, growth].filter(Boolean);
}

// Cycle execution

async function executeIvanCharlieIngest(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_START',
    task_id: task.id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const selected = selectRequiredItems(await filterNewItems(await collectIntelItems()));
    const types = new Set(selected.map(item => item.type));
    if (!types.has('innovation') || !types.has('growth')) {
      throw new Error(`Incomplete innovation/growth ingest: innovation=${types.has('innovation')}, growth=${types.has('growth')}`);
    }

    const submitted = [];
    for (const item of selected) {
      const { source_url, published_at, ...payload } = item;
      const result = await apiCall('/api/pipeline/intel-items', 'POST', {
        ...payload,
        summary: `${payload.summary}\n\nSource: ${source_url}\nPublished: ${published_at}`,
      });
      submitted.push({ type: item.type, id: result.id });
    }

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'ivan_charlie', event: 'INTEL_INGEST_COMPLETE',
      task_id: task.id, submitted,
    }));
  } catch (e) {
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
        AND created_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY created_at ASC
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

module.exports = { pollIvanCharlieTasks, ensureIvanCharlieToken, executeIvanCharlieIngest };
