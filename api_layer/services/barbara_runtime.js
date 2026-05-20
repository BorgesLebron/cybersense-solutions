'use strict';

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');

const BARBARA_SYSTEM_PROMPT = `You are Barbara, Data Normalization Analyst for CyberSense Intelligence Operations. You receive raw intel items ingested from external sources and return a single structured JSON record suitable for editorial production. No prose. No markdown fences. JSON only.

OUTPUT SCHEMA:
{
  "category":        "threat" | "innovation" | "growth",
  "source_tier":     1 | 2 | 3 | null,
  "source":          "<clean publisher name or domain>",
  "confidence_score": <integer 0-100>,
  "summary":         "<2-3 factual sentences, no marketing language>",
  "threat_category": "<classification string or null>",
  "cve_ids":         ["CVE-XXXX-XXXXX"],
  "entity_names":    ["<vendor, product, or affected system>"],
  "quality_flag":    true | false
}

CATEGORY RULES:
- threat: vulnerabilities, exploits, malware, breaches, advisories, CVEs
- innovation: AI/ML advances, emerging technology, research findings, product launches
- growth: career development, certifications, training, professional events

SOURCE TIER:
- 1: NVD, CISA, US-CERT, vendor security advisories (Microsoft, Cisco, Palo Alto, Google, Apple), SecurityWeek, CRN
- 2: BankInfoSecurity, SecurityAffairs, The Hacker News, Bleeping Computer, AFCEA, Unit 42, Check Point Research, reputable industry publications
- 3: General news outlets, unknown publishers, uncorroborated reports
- null: Source cannot be determined

CONFIDENCE SCORE:
- 90-100: Tier 1 source, specific technical detail, CVE or official citation present
- 70-89:  Tier 2 source, sufficient technical content, clear attribution
- 50-69:  Tier 3 source or thin technical content
- 0-49:   Insufficient — set quality_flag to true

THREAT CATEGORY (threats only, null for all others):
One of: vulnerability | ransomware | phishing | APT | data_breach | supply_chain | DDoS | malware | social_engineering | insider_threat | cryptographic | other

QUALITY FLAG — set to true if any of:
- confidence_score < 50
- category cannot be determined from the content
- content is promotional, duplicative, or non-editorial
- summary cannot be written due to insufficient information

SUMMARY WRITING STANDARDS — applied to every summary field:
- Lead with the most important fact. Give the verdict first — the reader skims.
- Punchy and direct. Brief a colleague over coffee, not a press release audience.
- Scope tight: one threat or development, one consequence, one "so what?" for defenders. Do not try to cover everything.
- Answer the defender's question: what does this mean for their organization? Frame the risk operationally.
- No idioms, clichés, or filler. Every word must carry information.
- Three sentences maximum: fact → impact → urgency or action context.`;

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const BATCH_LIMIT     = 10;
const POLL_WINDOW_HRS = 72; // wider window — Barbara drains a backlog, not a 12h cycle

// ── Token management ──────────────────────────────────────────────────────────

let _barbaraToken = null;

async function ensureBarbaraToken() {
  if (_barbaraToken) {
    try {
      jwt.verify(_barbaraToken, process.env.AGENT_JWT_SECRET);
      return _barbaraToken;
    } catch (_) {}
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Barbara', agent_team: 'normalization' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Barbara', hash);
  _barbaraToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureBarbaraToken();
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
    throw new Error(`${method} ${path} → ${res.status}: ${json.error || json.message || JSON.stringify(json)}`);
  }
  return json;
}

// ── LLM enrichment ───────────────────────────────────────────────────────────

async function runBarbaraLLM(rawInput) {
  const client = new Anthropic();
  const userContent = [
    `Title: ${rawInput.title || '(none)'}`,
    rawInput.source_url ? `Source URL: ${rawInput.source_url}` : null,
    rawInput.tags?.length ? `Tags: ${rawInput.tags.join(', ')}` : null,
    rawInput.summary ? `Content: ${String(rawInput.summary).slice(0, 800)}` : null,
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     BARBARA_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userContent }],
  });

  const text    = (msg.content[0]?.text || '').trim();
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// ── Quality flag log ──────────────────────────────────────────────────────────

async function logQualityFlag(contentType, sourceId, enriched) {
  try {
    await db.logPipelineEvent({
      content_type: contentType,
      content_id:   sourceId,
      from_status:  'raw',
      to_status:    'quality_flagged',
      agent_name:   'Barbara',
      notes: JSON.stringify({
        confidence_score: enriched.confidence_score,
        source:           enriched.source,
        category:         enriched.category,
        summary:          (enriched.summary || '').slice(0, 200),
        reason:           'confidence_score < 50 or content failed quality threshold',
      }),
    });
  } catch (e) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'barbara',
      event: 'QUALITY_FLAG_LOG_ERROR', source_id: sourceId, error: e.message,
    }));
  }
}

// ── Normalization: threat records ─────────────────────────────────────────────

async function normalizeThreat(threat) {
  const cvss        = parseFloat(threat.cvss_score) || 0;
  const isKev       = threat.category === 'known_exploited_vulnerability';
  const isImmediate = threat.priority === 'immediate';
  const hasCve      = !!threat.cve_id;

  let enriched = null;
  try {
    enriched = await runBarbaraLLM({
      title:      threat.threat_name,
      source_url: threat.source_url,
      tags:       threat.tags,
      summary:    threat.raw_data ? JSON.stringify(threat.raw_data).slice(0, 800) : null,
    });
  } catch (e) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'barbara',
      event: 'LLM_FALLBACK', source_id: threat.id, error: e.message,
    }));
  }

  return {
    source_type: 'threat',
    source_id:   threat.id,
    normalized_data: {
      title:            threat.threat_name,
      cve_id:           threat.cve_id || null,
      category:         threat.category,
      severity:         threat.severity,
      cvss_score:       cvss,
      source_url:       threat.source_url || null,
      priority:         threat.priority,
      tags:             threat.tags || [],
      ingested_at:      threat.ingested_at,
      ...(enriched && {
        summary:          enriched.summary,
        threat_category:  enriched.threat_category,
        cve_ids:          enriched.cve_ids,
        entity_names:     enriched.entity_names,
        source:           enriched.source,
        confidence_score: enriched.confidence_score,
      }),
    },
    correlation_tags:    buildThreatCorrelationTags(threat, cvss, isKev, isImmediate),
    ready_for_intel:     isKev || isImmediate || (hasCve && cvss >= 9.0),
    ready_for_awareness: true,
    source_tier:         enriched?.source_tier ?? null,
    quality_flag:        enriched?.quality_flag ?? false,
  };
}

function buildThreatCorrelationTags(threat, cvss, isKev, isImmediate) {
  const tags = new Set(threat.tags || []);
  if (isKev)           tags.add('kev-advisory');
  if (cvss >= 9.0)     tags.add('critical-cvss');
  if (isImmediate)     tags.add('immediate-priority');
  if (threat.cve_id)   tags.add('has-cve');
  return [...tags];
}

// ── Normalization: intel items (innovation/growth/policy) ─────────────────────

const SOURCE_TIER_MAP = { securityweek: 1, crn: 2 };

function inferSourceTier(tags = []) {
  for (const tag of tags) {
    if (SOURCE_TIER_MAP[tag] != null) return SOURCE_TIER_MAP[tag];
  }
  return null;
}

async function normalizeIntelItem(item) {
  const isHighPriority = item.priority === 'high';

  let enriched = null;
  try {
    enriched = await runBarbaraLLM({
      title:      item.headline,
      source_url: item.source_url || null,
      tags:       item.tags,
      summary:    item.summary ? String(item.summary).slice(0, 800) : null,
    });
  } catch (e) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'barbara',
      event: 'LLM_FALLBACK', source_id: item.id, error: e.message,
    }));
  }

  return {
    source_type: item.type,
    source_id:   item.id,
    normalized_data: {
      title:       item.headline,
      category:    item.category,
      type:        item.type,
      summary:     item.summary || null,
      priority:    item.priority,
      tags:        item.tags || [],
      ingested_at: item.ingested_at,
      ...(enriched && {
        summary:          enriched.summary,
        entity_names:     enriched.entity_names,
        source:           enriched.source,
        confidence_score: enriched.confidence_score,
      }),
    },
    correlation_tags: [...new Set([...(item.tags || []), item.type])],
    ready_for_intel:     isHighPriority,
    ready_for_awareness: true,
    source_tier:         enriched?.source_tier ?? inferSourceTier(item.tags),
    quality_flag:        enriched?.quality_flag ?? false,
  };
}

// ── Task execution ────────────────────────────────────────────────────────────

async function executeNormalizeTask(task) {
  const ts = new Date().toISOString();

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    let payload;

    if (task.task_type === 'normalize_threat') {
      const rows = await db.pool.query(
        'SELECT * FROM threat_records WHERE id=$1', [task.content_id]
      ).then(r => r.rows);

      if (!rows.length) {
        console.warn(JSON.stringify({
          ts, runtime: 'barbara', event: 'SOURCE_NOT_FOUND',
          task_id: task.id, task_type: task.task_type, content_id: task.content_id,
        }));
        await db.updateTask(task.id, { status: 'failed', error_message: 'Threat record not found' });
        return;
      }
      payload = await normalizeThreat(rows[0]);

    } else if (task.task_type === 'normalize_intel') {
      const rows = await db.pool.query(
        'SELECT * FROM intel_items WHERE id=$1', [task.content_id]
      ).then(r => r.rows);

      if (!rows.length) {
        console.warn(JSON.stringify({
          ts, runtime: 'barbara', event: 'SOURCE_NOT_FOUND',
          task_id: task.id, task_type: task.task_type, content_id: task.content_id,
        }));
        await db.updateTask(task.id, { status: 'failed', error_message: 'Intel item not found' });
        return;
      }
      payload = await normalizeIntelItem(rows[0]);

    } else {
      await db.updateTask(task.id, { status: 'failed', error_message: `Unknown task type: ${task.task_type}` });
      return;
    }

    if (payload.quality_flag) {
      await logQualityFlag(payload.source_type, payload.source_id, payload.normalized_data);
      await db.updateTask(task.id, { status: 'complete' });
      console.log(JSON.stringify({
        ts, runtime: 'barbara', event: 'QUALITY_FLAGGED',
        task_id: task.id, task_type: task.task_type,
        source_type: payload.source_type, source_id: payload.source_id,
      }));
      return;
    }

    const result = await apiCall('/api/pipeline/repository/process', 'POST', payload);
    try {
      await db.logPipelineEvent({
        content_type: 'intel_repository',
        content_id:   result.id,
        from_status:  'normalized',
        to_status:    'enrichment_complete',
        agent_name:   'Barbara',
        notes: JSON.stringify({
          confidence_score: payload.normalized_data?.confidence_score ?? null,
          source:           payload.normalized_data?.source ?? null,
          category:         payload.normalized_data?.category ?? null,
          ready_for_intel:  payload.ready_for_intel,
        }),
      });
    } catch (e) {
      console.warn(JSON.stringify({
        ts, runtime: 'barbara', event: 'ENRICH_LOG_ERROR', error: e.message,
      }));
    }
    await db.updateTask(task.id, { status: 'complete' });

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'NORMALIZED',
      task_id: task.id, task_type: task.task_type,
      source_type: payload.source_type, source_id: payload.source_id,
      ready_for_intel: payload.ready_for_intel, ready_for_awareness: payload.ready_for_awareness,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    console.error(JSON.stringify({
      ts, runtime: 'barbara', event: 'TASK_ERROR',
      task_id: task.id, task_type: task.task_type, error: e.message,
    }));
    throw e;
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollBarbaraTasks() {
  const ts = new Date().toISOString();
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name  = 'Barbara'
        AND task_type   IN ('normalize_threat', 'normalize_intel')
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HRS} hours'
      ORDER BY started_at ASC
      LIMIT $1
    `, [BATCH_LIMIT]).then(r => r.rows);

    if (!tasks.length) return;

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_START', queued: tasks.length,
    }));

    let processed = 0;
    let errors = 0;

    for (const task of tasks) {
      try {
        await executeNormalizeTask(task);
        processed++;
      } catch (_) {
        errors++;
      }
    }

    console.log(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_COMPLETE', processed, errors, total: tasks.length,
    }));

    if (errors > 0) {
      await notifyAgents(['Barret'], {
        type: 'BARBARA_BATCH_ERRORS',
        processed, errors, total: tasks.length,
        message: `Barbara normalization batch: ${errors} of ${tasks.length} tasks failed. ${processed} normalized successfully.`,
      });
    }

  } catch (e) {
    console.error(JSON.stringify({
      ts, runtime: 'barbara', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollBarbaraTasks, ensureBarbaraToken };
