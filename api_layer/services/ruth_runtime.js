'use strict';

const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/queries');
const { notifyAgents } = require('./agents');
const { postAgentStatusToActiveMeeting } = require('./meetings');

const ACQUISITIONS_SYSTEM_PROMPT = `You are the lead writer for CyberSense: Daily Digital Awareness Brief, a daily professional intelligence newsletter for security-aware workforces. Write the complete, publication-ready newsletter — not an outline.

OUTPUT FORMAT — use these exact ## section headings in this order:

## Opening Brief
2–3 paragraphs (150–200 words). Identify the unifying theme across today's content. Do not name individual threats — write at the pattern level. Professional, direct tone.

## Situational Awareness
Three threat entries. Each entry:
- A plain-text title on its own line (no markdown formatting — no **, no ##, no bold markers)
- Exactly 2 paragraphs: (1) what the threat is and why it matters, (2) organizational impact
- Do NOT include recommended actions, defensive guidance, or remediation steps — those belong in the Intel Brief articles, not the newsletter
- Separate entries with ---

## Training Byte
Insert the Training Byte content verbatim from the provided source. Do not rewrite, summarize, or reformat it. Preserve the #### heading exactly as given.

## Career Development
One entry. Format exactly as follows — three lines, nothing more:
Line 1: Short title (the name of the course, certification, webinar, or training program — under 10 words)
Line 2: 1–2 sentence description of what it covers and why it matters for security professionals
Line 3: Link: [url from source]

## Modernization and AI Insight
Two entries separated by ---. Each entry:
- A plain-text article title on its own line (the actual development being covered — not a section label)
- 2–3 paragraphs reporting on the specific event, release, or research finding
- Write about actual events from the provided sources. Do not write newsletter commentary or meta-analysis.

## Final Thought
One closing paragraph (50–80 words). Synthesize the day's theme into a forward-looking perspective. Do not append any footer, metadata, or publication boilerplate.

RULES:
- Do not include "Correct Answer" in the Knowledge Check — the answer appears in the next edition.
- The SUBJECT line must be a thematic 5–7 word headline capturing the edition theme — NOT a restatement of any individual threat title.
- Do not append CyberSense footer text or date lines after Final Thought.`;

const API_BASE = () =>
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const COMPOSITION = { threats: 3, innovations: 2, growth: 1 };
const POLL_WINDOW_HOURS = 12;

function nextCtDate(daysAhead = 1) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// ── Token management ─────────────────────────────────────────────────────────

let _ruthToken = null;

async function ensureRuthToken() {
  if (_ruthToken) {
    try {
      jwt.verify(_ruthToken, process.env.AGENT_JWT_SECRET);
      return _ruthToken;
    } catch (_) {
      // Token expired or invalid — re-provision below
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Ruth', agent_team: 'awareness' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Ruth', hash);
  _ruthToken = token;
  return token;
}

// ── Internal API caller ───────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const token = await ensureRuthToken();
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

// ── Repository query ──────────────────────────────────────────────────────────

async function selectCompositionItems() {
  const queue = await apiCall('/api/pipeline/repository/queue?pipeline=awareness&limit=60');
  const items = queue.data || [];

  const threats    = items.filter(i => i.source_type === 'threat').slice(0, COMPOSITION.threats);
  const innovations = items.filter(i => i.source_type === 'innovation').slice(0, COMPOSITION.innovations);
  const growthItem  = items.find(i => i.source_type === 'growth') || null;

  // Training byte: Kirby delivers these as training_modules type='training_byte'.
  // Query directly — not routed through intel_repository.
  // Deduplication: hard 30-day lookback — never reuse a byte used in the last 30 days
  // regardless of pool size. Pool-size-relative exclusion caused strict 4-edition
  // rotation when the pool was small.
  const trainingByte = await db.pool.query(`
    SELECT id, title, body_md
    FROM training_modules
    WHERE type = 'training_byte'
      AND pipeline_status = 'published'
      AND id NOT IN (
        SELECT training_byte_id
        FROM briefings
        WHERE training_byte_id IS NOT NULL
          AND edition_date >= CURRENT_DATE - INTERVAL '30 days'
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).then(r => r.rows[0] || null);

  const missing = [];
  if (threats.length    < COMPOSITION.threats)     missing.push(`threats (need ${COMPOSITION.threats}, found ${threats.length})`);
  if (innovations.length < COMPOSITION.innovations) missing.push(`innovations (need ${COMPOSITION.innovations}, found ${innovations.length})`);
  if (!growthItem)   missing.push('growth item (0 found)');
  if (!trainingByte) missing.push('training_byte (no published candidate available — Kirby runtime may need to publish new bytes)');

  return { threats, innovations, growthItem, trainingByte, missing };
}

// ── LLM acquisitions outline ──────────────────────────────────────────────────

function formatTopicSelection(threats, innovations, growthItem, trainingByte, editionDate) {
  const nd = item => (item && item.normalized_data) || {};
  const lines = [
    `Edition Date: ${editionDate}`,
    '',
    'SITUATIONAL AWARENESS — THREAT INTELLIGENCE:',
    ...threats.map((t, i) => {
      const d = nd(t);
      return [
        `${i + 1}. ${t.title || 'Threat Advisory'}`,
        `   CVE: ${d.cve_id || 'N/A'} | CVSS: ${d.cvss_score || 'N/A'} | Category: ${d.category || 'threat'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
      ].filter(Boolean).join('\n');
    }),
    '',
    'MODERNIZATION AND AI INSIGHT:',
    ...innovations.map((item, i) => {
      const d = nd(item);
      return [
        `${i + 1}. ${item.title || 'Innovation Item'}`,
        `   Category: ${d.category || 'innovation'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
        d.summary   ? `   Summary: ${String(d.summary).slice(0, 250)}` : null,
      ].filter(Boolean).join('\n');
    }),
    '',
    'CAREER DEVELOPMENT / PROFESSIONAL GROWTH:',
    growthItem ? (() => {
      const d = nd(growthItem);
      return [
        `1. ${growthItem.title || 'Growth Item'}`,
        d.source_url ? `   Source: ${d.source_url}` : null,
        d.summary   ? `   Summary: ${String(d.summary).slice(0, 250)}` : null,
      ].filter(Boolean).join('\n');
    })() : '(none available)',
    '',
    'TRAINING BYTE — USE THIS CONTENT VERBATIM (do not rewrite or summarize):',
    trainingByte
      ? `#### ${trainingByte.title.replace(/^Training Byte:\s*/i, '')}\n\n${trainingByte.body_md}`
      : '(no published byte available — write one aligned to the day\'s SA threats)',
    '',
    '---',
    'After your outline, append one line: SUBJECT: <concise email subject line for this edition, under 60 characters>',
  ];
  return lines.join('\n');
}

async function buildAcquisitionsOutline(threats, innovations, growthItem, trainingByte, editionDate) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: ACQUISITIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formatTopicSelection(threats, innovations, growthItem, trainingByte, editionDate) }],
  });

  const text = (message.content[0]?.text || '').trim();
  const subjectMatch  = text.match(/^SUBJECT:\s*(.+)$/m);
  // Prefer explicit SUBJECT line; fall back to H1 thematic title (after colon) before
  // using the first threat title, which would duplicate the first SA item heading.
  const h1ThemeMatch  = text.match(/^#\s+[^:\n]+:\s*(.+)$/m);
  const subjectLine = subjectMatch
    ? subjectMatch[1].trim().slice(0, 120)
    : h1ThemeMatch
      ? h1ThemeMatch[1].trim().slice(0, 120)
      : (threats[0]?.title || `Daily Awareness Brief — ${editionDate}`);
  const body_md = text.replace(/^SUBJECT:.*$/m, '').trimEnd();

  return { subjectLine, body_md };
}

// ── Briefing content builder (scaffold fallback) ──────────────────────────────

function buildContent(threats, innovations, growthItem) {
  const topThreat = threats[0];
  const subjectLine = topThreat?.title ||
    `Daily Awareness Briefing — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const threatSection = threats
    .map(t => `### ${t.title || 'Threat Advisory'}\n_Source ID: ${t.source_id}_`)
    .join('\n\n');

  const intelSection = [
    ...innovations.map(i => `### Innovation: ${i.title || 'Innovation Item'}`),
    `### Growth: ${growthItem?.title || 'Growth Item'}`,
  ].join('\n\n');

  const body_md = `${threatSection}\n\n---\n\n${intelSection}`;

  return { subjectLine, body_md };
}

// ── Cycle execution ───────────────────────────────────────────────────────────

async function executeRuthDailyCycle(task) {
  const ts          = new Date().toISOString();
  const editionDate = nextCtDate();

  console.log(JSON.stringify({
    ts, runtime: 'ruth', event: 'CYCLE_START',
    edition_date: editionDate, task_id: task.id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    // Idempotency — skip if briefing already exists for today
    const existing = await db.getBriefingByDate(editionDate);
    if (existing) {
      console.log(JSON.stringify({
        ts, runtime: 'ruth', event: 'ALREADY_EXISTS',
        edition_date: editionDate, briefing_id: existing.id,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    // Select composition items from intel_repository
    const { threats, innovations, growthItem, trainingByte, missing } = await selectCompositionItems();

    console.log(JSON.stringify({
      ts, runtime: 'ruth', event: 'COMPOSITION_RESULT',
      edition_date: editionDate,
      threats_found: threats.length,
      innovations_found: innovations.length,
      growth_found: !!growthItem,
      training_byte_found: !!trainingByte,
      missing: missing.length > 0 ? missing : null,
    }));

    // Re-queue whenever the training byte is the only missing item — supports
    // both the scheduled 04:00 CT production path and manual daytime testing.
    if (!trainingByte && missing.length === 1 && missing[0].startsWith('training_byte')) {
      await db.updateTask(task.id, { status: 'queued' });
      console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'AWAITING_TRAINING_BYTE', edition_date: editionDate, retry_after: 'next poll' }));
      return;
    }

    if (missing.length > 0) {
      const error_message = `Incomplete repository: ${missing.join('; ')}`;
      await db.updateTask(task.id, { status: 'failed', error_message });
      await notifyAgents(['Barret', 'Henry'], {
        type: 'RUTH_COMPOSITION_INCOMPLETE',
        edition_date: editionDate,
        task_id: task.id,
        missing,
        message: `Ruth cannot compose briefing for ${editionDate} — ${error_message}. 0700 CT delivery at risk.`,
      });
      console.warn(JSON.stringify({
        ts, runtime: 'ruth', event: 'COMPOSITION_INCOMPLETE',
        edition_date: editionDate, missing,
      }));
      return;
    }

    let subjectLine, body_md;
    try {
      ({ subjectLine, body_md } = await buildAcquisitionsOutline(threats, innovations, growthItem, trainingByte, editionDate));
      console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'LLM_OUTLINE_GENERATED', edition_date: editionDate }));
    } catch (llmErr) {
      console.warn(JSON.stringify({ ts, runtime: 'ruth', event: 'LLM_FALLBACK', edition_date: editionDate, error: llmErr.message }));
      ({ subjectLine, body_md } = buildContent(threats, innovations, growthItem));
    }

    const result = await apiCall('/api/pipeline/briefings', 'POST', {
      edition_date:       editionDate,
      subject_line:       subjectLine,
      body_md,
      threat_item_ids:    threats.map(t => t.source_id),
      innovation_item_ids: innovations.map(i => i.source_id),
      growth_item_id:     growthItem.source_id,
      training_byte_id:   trainingByte.id,
    });

    await db.updateTask(task.id, { status: 'complete' });

    // Post to meeting (Gemma task) — non-critical, must not fail the cycle
    try {
      await postAgentStatusToActiveMeeting('Ruth', 'awareness', {
        event: 'BRIEFING_SUBMITTED',
        edition_date: editionDate,
        briefing_id: result.id,
        threats: threats.length,
        innovations: innovations.length,
        growth: !!growthItem,
        training_byte: !!trainingByte
      });
    } catch (meetingErr) {
      console.warn(JSON.stringify({ ts, runtime: 'ruth', event: 'MEETING_POST_FAILED', error: meetingErr.message }));
    }

    console.log(JSON.stringify({
      ts, runtime: 'ruth', event: 'BRIEFING_SUBMITTED',
      edition_date: editionDate, briefing_id: result.id, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'RUTH_CYCLE_ERROR',
      edition_date: editionDate,
      task_id: task.id,
      error: e.message,
      message: `Ruth runtime error for ${editionDate}: ${e.message}. Manual intervention required.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'ruth', event: 'CYCLE_ERROR',
      edition_date: editionDate, error: e.message,
    }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollRuthTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Ruth'
        AND task_type   = 'daily_cycle'
        AND status      = 'queued'
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeRuthDailyCycle(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'ruth', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

// ── Manual pipeline ───────────────────────────────────────────────────────────

const MANUAL_ACQUISITIONS_SYSTEM_PROMPT = `You are the lead writer for CyberSense: Daily Digital Awareness Brief, a daily professional intelligence newsletter for security-aware workforces. Write the complete, publication-ready newsletter — not an outline.

OUTPUT FORMAT — use these exact ## section headings in this order:

## Opening Brief
2–3 paragraphs (150–200 words). Identify the unifying theme across today's content. Do not name individual threats — write at the pattern level. Professional, direct tone.

## Situational Awareness
Three threat entries. Each entry:
- A plain-text title on its own line (no markdown formatting — no **, no ##, no bold markers)
- Exactly 2 paragraphs: (1) what the threat is and why it matters, (2) organizational impact
- Do NOT include recommended actions, defensive guidance, or remediation steps
- Separate entries with ---

## Training Byte
Write exactly the following placeholder on its own line and nothing else for this section:
[TRAINING BYTE PLACEHOLDER]

## Career Development
One entry. Format exactly as follows — three lines, nothing more:
Line 1: Short title (the name of the course, certification, webinar, or training program — under 10 words)
Line 2: 1–2 sentence description of what it covers and why it matters for security professionals
Line 3: Link: [url from source]

## Modernization and AI Insight
Two entries separated by ---. Each entry:
- A plain-text article title on its own line (the actual development being covered — not a section label)
- 2–3 paragraphs reporting on the specific event, release, or research finding
- Write about actual events from the provided sources. Do not write newsletter commentary or meta-analysis.

## Final Thought
One closing paragraph (50–80 words). Synthesize the day's theme into a forward-looking perspective. Do not append any footer, metadata, or publication boilerplate.

RULES:
- Do not include "Correct Answer" in the Knowledge Check — that section belongs in the Training Byte (handled separately).
- The SUBJECT line must be a thematic 5–7 word headline capturing the edition theme — NOT a restatement of any individual threat title.
- Do not append CyberSense footer text or date lines after Final Thought.`;

const MANUAL_INTEGRATION_SYSTEM_PROMPT = `You are Ruth, lead writer for CyberSense Daily Awareness Brief. A complete newsletter draft has been written with a [TRAINING BYTE PLACEHOLDER] in the Training Byte section. Your task is to replace that placeholder with the provided Training Byte content.

RULES:
- Replace [TRAINING BYTE PLACEHOLDER] with the provided Training Byte content exactly as given
- Do not modify any other section of the draft
- Preserve all formatting, headings, and structure exactly
- Return the complete updated draft only — no preamble or commentary`;

async function fetchArticleContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CyberSense-NewsBot/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return `[Content unavailable — HTTP ${res.status}]`;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);
  } catch (e) {
    return `[Fetch failed: ${e.message}]`;
  }
}

function extractTitle(url, content) {
  const candidate = content.slice(0, 300).split(/[|\n]/).find(s => s.trim().length > 15 && s.trim().length < 120);
  if (candidate) return candidate.trim();
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url.slice(0, 60); }
}

function formatManualTopicSelection(threatItems, innovationItems, growthItem, editionDate) {
  const lines = [
    `Edition Date: ${editionDate}`,
    '',
    'SITUATIONAL AWARENESS — THREAT INTELLIGENCE:',
    ...threatItems.map((t, i) => [
      `${i + 1}. ${t.title}`,
      `   Source: ${t.url}`,
      `   Content: ${t.content}`,
    ].join('\n')),
    '',
    'MODERNIZATION AND AI INSIGHT:',
    ...innovationItems.map((t, i) => [
      `${i + 1}. ${t.title}`,
      `   Source: ${t.url}`,
      `   Content: ${t.content}`,
    ].join('\n')),
    '',
    'CAREER DEVELOPMENT / PROFESSIONAL GROWTH:',
    `1. ${growthItem.title}`,
    `   Source: ${growthItem.url}`,
    `   Content: ${growthItem.content}`,
    '',
    'TRAINING BYTE — Write [TRAINING BYTE PLACEHOLDER] exactly as shown. Do not write any training content here.',
    '',
    '---',
    'After your draft, append one line: SUBJECT: <concise email subject line for this edition, under 60 characters>',
  ];
  return lines.join('\n');
}

async function buildManualAcquisitionsOutline(threatItems, innovationItems, growthItem, editionDate) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    system: MANUAL_ACQUISITIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formatManualTopicSelection(threatItems, innovationItems, growthItem, editionDate) }],
  });

  const text = (message.content[0]?.text || '').trim();
  const subjectMatch = text.match(/^SUBJECT:\s*(.+)$/m);
  const subjectLine = subjectMatch
    ? subjectMatch[1].trim().slice(0, 120)
    : `Daily Awareness Brief — ${editionDate}`;
  const body_md = text.replace(/^SUBJECT:.*$/m, '').trimEnd();
  return { subjectLine, body_md };
}

async function executeRuthManualInitial({ threats: threatUrls, growth: growthUrl, innovations: innovationUrls, edition_date }) {
  const ts = new Date().toISOString();
  const editionDate = edition_date || nextCtDate();

  console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'MANUAL_INITIAL_START', edition_date: editionDate }));

  const existing = await db.getBriefingByDate(editionDate);
  if (existing) throw new Error(`Briefing already exists for ${editionDate} — delete it first or choose a different date`);

  const [threatContents, innovationContents, growthContent] = await Promise.all([
    Promise.all(threatUrls.map(url => fetchArticleContent(url))),
    Promise.all(innovationUrls.map(url => fetchArticleContent(url))),
    fetchArticleContent(growthUrl),
  ]);

  const threatItems = threatUrls.map((url, i) => ({
    url, content: threatContents[i], title: extractTitle(url, threatContents[i]),
  }));
  const innovationItems = innovationUrls.map((url, i) => ({
    url, content: innovationContents[i], title: extractTitle(url, innovationContents[i]),
  }));
  const growthItem = { url: growthUrl, content: growthContent, title: extractTitle(growthUrl, growthContent) };

  const { subjectLine, body_md } = await buildManualAcquisitionsOutline(threatItems, innovationItems, growthItem, editionDate);

  const NIL = '00000000-0000-0000-0000-000000000000';
  const result = await db.createBriefing({
    edition_date: editionDate,
    subject_line: subjectLine,
    body_md,
    threat_item_ids: [NIL, NIL, NIL],
    innovation_item_ids: [NIL, NIL],
    growth_item_id: NIL,
    training_byte_id: null,
  });

  console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'MANUAL_INITIAL_COMPLETE', edition_date: editionDate, briefing_id: result.id }));

  return {
    briefing_id: result.id,
    edition_date: editionDate,
    kirby_threat_url: threatItems[0].url,
    kirby_threat_title: threatItems[0].title,
    kirby_threat_content: threatItems[0].content,
  };
}

async function buildRuthIntegration(body_md, trainingByte) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: MANUAL_INTEGRATION_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `DRAFT:\n${body_md}\n\n---\n\nTRAINING BYTE TO INSERT:\n#### ${trainingByte.title.replace(/^Training Byte:\s*/i, '')}\n\n${trainingByte.body_md}`,
    }],
  });
  return (message.content[0]?.text || '').trim();
}

async function executeRuthIntegration(briefingId) {
  const ts = new Date().toISOString();

  const briefing = await db.getBriefingById(briefingId);
  if (!briefing) throw new Error(`Briefing ${briefingId} not found`);
  if (!briefing.training_byte_id) throw new Error('No training byte linked — trigger Kirby first');

  const trainingByte = await db.pool.query(
    'SELECT * FROM training_modules WHERE id=$1',
    [briefing.training_byte_id]
  ).then(r => r.rows[0] || null);
  if (!trainingByte) throw new Error('Training byte record not found');

  console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'MANUAL_INTEGRATION_START', briefing_id: briefingId }));

  const integrated_body_md = await buildRuthIntegration(briefing.body_md, trainingByte);

  if (integrated_body_md.includes('[TRAINING BYTE PLACEHOLDER]')) {
    throw new Error('LLM did not replace placeholder — retry integration');
  }

  await db.updateBriefingEditorial(briefingId, { body_md: integrated_body_md });

  console.log(JSON.stringify({ ts, runtime: 'ruth', event: 'MANUAL_INTEGRATION_COMPLETE', briefing_id: briefingId }));

  return { success: true, briefing_id: briefingId };
}

module.exports = { pollRuthTasks, ensureRuthToken, executeRuthManualInitial, executeRuthIntegration };
