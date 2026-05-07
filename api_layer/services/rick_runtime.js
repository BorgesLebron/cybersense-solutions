'use strict';

// services/rick_runtime.js
// Rick's acquisition runtime. Polls agent_tasks for queued Rick work, queries
// Tier 1 threat feeds, deduplicates against threat_records, and submits
// qualifying records to POST /api/pipeline/threat-records.
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
const RECENCY_HOURS = 48;
const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const NVD_CVE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const US_CERT_URL = 'https://www.cisa.gov/uscert/ncas/current-activity.xml';

// Token management

let _rickToken = null;

async function ensureRickToken() {
  if (_rickToken) {
    try {
      jwt.verify(_rickToken, process.env.AGENT_JWT_SECRET);
      return _rickToken;
    } catch (_) {
      // Token expired or invalid - re-provision below
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Rick', agent_team: 'acquisition' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Rick', hash);
  _rickToken = token;
  return token;
}

// Internal API caller

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureRickToken();
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

async function feedJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
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

function severityFromCvss(score) {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function highestCvss(metrics = {}) {
  const groups = [
    metrics.cvssMetricV40,
    metrics.cvssMetricV31,
    metrics.cvssMetricV30,
    metrics.cvssMetricV2,
  ].filter(Array.isArray);

  return groups
    .flatMap(group => group.map(m => Number(m.cvssData?.baseScore)).filter(n => !Number.isNaN(n)))
    .sort((a, b) => b - a)[0] || null;
}

function cveDescription(cve = {}) {
  const desc = (cve.descriptions || []).find(d => d.lang === 'en') || cve.descriptions?.[0];
  return desc?.value || cve.id || 'CVE advisory';
}

function cveUrl(cveId) {
  return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}`;
}

function normalizeNvdRecord(item) {
  const cve = item.cve || {};
  const score = highestCvss(cve.metrics);
  if (!cve.id || score == null || score < 7 || !isRecent(cve.published)) return null;

  const description = cveDescription(cve);
  return {
    cve_id: cve.id,
    threat_name: description.slice(0, 180),
    severity: severityFromCvss(score),
    cvss_score: score,
    category: 'vulnerability',
    source_url: cveUrl(cve.id),
    raw_data: item,
    tags: ['nvd', 'cve', severityFromCvss(score)],
    priority: score >= 9 ? 'immediate' : 'high',
  };
}

function normalizeKevRecord(item) {
  if (!item?.cveID || !isRecent(item.dateAdded)) return null;

  return {
    cve_id: item.cveID,
    threat_name: item.vulnerabilityName || `${item.cveID} known exploited vulnerability`,
    severity: 'critical',
    cvss_score: 10,
    category: 'known_exploited_vulnerability',
    source_url: cveUrl(item.cveID),
    raw_data: item,
    tags: ['cisa-kev', 'known-exploited', item.vendorProject, item.product].filter(Boolean),
    priority: 'immediate',
  };
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

function normalizeUsCertRecords(xml) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return blocks.map(block => {
    const pubDate = xmlValue(block, 'pubDate');
    if (!isRecent(pubDate)) return null;

    const title = decodeXml(xmlValue(block, 'title'));
    const link = decodeXml(xmlValue(block, 'link'));
    const description = decodeXml(xmlValue(block, 'description'));
    const cve = `${title} ${description}`.match(/CVE-\d{4}-\d{4,}/i)?.[0]?.toUpperCase() || null;

    return {
      cve_id: cve,
      threat_name: title.slice(0, 180),
      severity: 'high',
      cvss_score: 7,
      category: 'us-cert-current-activity',
      source_url: link || US_CERT_URL,
      raw_data: { title, link, description, pubDate },
      tags: ['us-cert', 'current-activity'].concat(cve ? ['cve'] : []),
      priority: 'high',
    };
  }).filter(Boolean);
}

async function collectThreatRecords() {
  const end = new Date();
  const start = cutoffDate();
  const nvdUrl = `${NVD_CVE_URL}?pubStartDate=${encodeURIComponent(start.toISOString())}&pubEndDate=${encodeURIComponent(end.toISOString())}`;

  const [kev, nvd, uscert] = await Promise.all([
    feedJson(CISA_KEV_URL),
    feedJson(nvdUrl),
    feedText(US_CERT_URL),
  ]);

  return [
    ...(kev.vulnerabilities || []).map(normalizeKevRecord),
    ...(nvd.vulnerabilities || []).map(normalizeNvdRecord),
    ...normalizeUsCertRecords(uscert),
  ].filter(Boolean);
}

async function existingCves(cves) {
  if (!cves.length) return new Set();
  const rows = await db.pool.query(
    'SELECT cve_id FROM threat_records WHERE cve_id = ANY($1)',
    [cves]
  ).then(r => r.rows);
  return new Set(rows.map(r => r.cve_id).filter(Boolean));
}

async function filterNewRecords(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = record.cve_id || `${record.threat_name}|${record.source_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }

  const existing = await existingCves(unique.map(r => r.cve_id).filter(Boolean));
  return unique.filter(record => !record.cve_id || !existing.has(record.cve_id));
}

// Cycle execution

async function executeRickThreatIngest(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'rick', event: 'THREAT_INGEST_START',
    task_id: task.id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const records = await filterNewRecords(await collectThreatRecords());
    const submitted = [];

    for (const record of records) {
      try {
        const result = await apiCall('/api/pipeline/threat-records', 'POST', record);
        submitted.push({ cve_id: record.cve_id, id: result.id });
      } catch (e) {
        if (!String(e.message).includes('409')) throw e;
      }
    }

    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'rick', event: 'THREAT_INGEST_COMPLETE',
      task_id: task.id, qualifying_records: records.length, submitted: submitted.length,
    }));
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'RICK_RUNTIME_ERROR',
      task_id: task.id,
      error: e.message,
      message: `Rick runtime error: ${e.message}. Threat acquisition requires manual intervention.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'rick', event: 'RUNTIME_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

// Poll loop

async function pollRickTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Rick'
        AND status      = 'queued'
        AND created_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY created_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeRickThreatIngest(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'rick', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollRickTasks, ensureRickToken, executeRickThreatIngest };
