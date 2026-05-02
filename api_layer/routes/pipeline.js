'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { requireAgentToken, validatePipelineTransition, err } = require('../middleware/auth');
const { notifyAgents, triggerEscalationCheck } = require('../services/agents');

const INTEL_AGENTS = ['James', 'Jason', 'Rob', 'Jeff', 'Maya', 'Henry', 'Laura'];
const AWARENESS_AGENTS = ['Ruth', 'Peter', 'Ed', 'Jeff', 'Maya', 'Henry', 'Laura'];
const TRAINING_AGENTS = ['Kirby', 'Mario', 'Matt', 'Jeff', 'Maya', 'Henry', 'Laura', 'Alex'];

// Next-stage task and notification targets for each awareness pipeline transition.
// Keyed on to_status. maya → approved is handled by AUTO-003 (Preview Briefing gate).
const AWARENESS_DISPATCH = {
  eic_review: { agent: 'Ed',   task_type: 'eic_review_briefing', sla_h: 6, sla_m: 45 },
  qa:         { agent: 'Jeff', task_type: 'qa_briefing',         sla_h: 6, sla_m: 55 },
  maya:       { agent: 'Maya', task_type: 'approve_briefing',    sla_h: 7, sla_m: 0  },
};

// POST /api/pipeline/threat-records  (Rick only)
router.post('/threat-records', requireAgentToken(['Rick', 'Henry']), async (req, res, next) => {
  try {
    const { cve_id, threat_name, severity, cvss_score, category, source_url, raw_data, tags, priority } = req.body;

    if (!cve_id || !threat_name || !severity || cvss_score == null || !category || !raw_data || !tags || !priority)
      return res.status(400).json(err('MISSING_FIELDS', 'cve_id, threat_name, severity, cvss_score, category, raw_data, tags, priority are required'));

    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (!validSeverities.includes(severity)) return res.status(400).json(err('INVALID_SEVERITY', `severity must be one of: ${validSeverities.join(', ')}`, 'severity'));

    const score = parseFloat(cvss_score);
    if (isNaN(score) || score < 0 || score > 10) return res.status(400).json(err('INVALID_CVSS', 'cvss_score must be between 0.0 and 10.0', 'cvss_score'));

    if (!Array.isArray(tags)) return res.status(400).json(err('INVALID_TAGS', 'tags must be an array', 'tags'));

    const record = await db.createThreatRecord({ cve_id, threat_name, severity, cvss_score: score, category, source_url, raw_data, tags, priority, ingested_by: req.agent.name });

    const task = await db.createTask({
      agent_name: 'Barbara',
      task_type: 'normalize_threat',
      content_type: 'system',
      content_id: record.id,
      sla_deadline: severity === 'critical' ? new Date(Date.now() + 15 * 60 * 1000) : null,
    });

    await notifyAgents(['Barbara'], {
      type: severity === 'critical' || priority === 'immediate' ? 'CRITICAL_THREAT' : 'THREAT_RECORD_SUBMITTED',
      record_id: record.id,
      cve_id,
      severity,
      priority,
      task_id: task.id,
      message: `Threat record submitted by Rick. ${severity.toUpperCase()} — ${threat_name}${cve_id ? ` (${cve_id})` : ''}.`,
    });

    res.status(201).json({ id: record.id, queued_task_id: task.id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json(err('DUPLICATE_CVE', `CVE ${req.body.cve_id} already exists in the system`, 'cve_id'));
    next(e);
  }
});

// POST /api/pipeline/intel-items  (Ivan/Charlie only)
router.post('/intel-items', requireAgentToken(['Ivan/Charlie', 'Henry']), async (req, res, next) => {
  try {
    const { type, category, headline, summary, tags, priority } = req.body;
    const validTypes = ['innovation', 'growth', 'policy'];

    if (!type || !category || !headline || !summary || !tags || !priority)
      return res.status(400).json(err('MISSING_FIELDS', 'type, category, headline, summary, tags, priority are required'));

    if (!validTypes.includes(type)) return res.status(400).json(err('INVALID_TYPE', `type must be one of: ${validTypes.join(', ')}`, 'type'));
    if (!Array.isArray(tags)) return res.status(400).json(err('INVALID_TAGS', 'tags must be an array', 'tags'));

    const item = await db.createIntelItem({ type, category, headline, summary, tags, priority, ingested_by: req.agent.name });

    const task = await db.createTask({
      agent_name: 'Barbara',
      task_type: 'normalize_intel',
      content_type: 'system',
      content_id: item.id,
      sla_deadline: null,
    });

    res.status(201).json({ id: item.id, queued_task_id: task.id });
  } catch (e) { next(e); }
});

// POST /api/pipeline/repository/process  (Barbara only)
router.post('/repository/process', requireAgentToken(['Barbara', 'Henry']), async (req, res, next) => {
  try {
    const { source_type, source_id, normalized_data, correlation_tags, ready_for_intel, ready_for_awareness } = req.body;

    if (!source_type || !source_id || !normalized_data)
      return res.status(400).json(err('MISSING_FIELDS', 'source_type, source_id, normalized_data are required'));

    const validSourceTypes = ['threat', 'innovation', 'growth', 'policy'];
    if (!validSourceTypes.includes(source_type)) return res.status(400).json(err('INVALID_SOURCE_TYPE', `source_type must be one of: ${validSourceTypes.join(', ')}`));

    const record = await db.processIntoRepository({
      source_type, source_id, normalized_data,
      correlation_tags: correlation_tags || [],
      processed_by: 'Barbara',
      ready_for_intel: ready_for_intel ?? true,
      ready_for_awareness: ready_for_awareness ?? true,
    });

    await notifyAgents(['James', 'Ruth', 'Kirby'], {
      type: 'REPOSITORY_UPDATE',
      record_id: record.id,
      source_type,
      ready_for_intel: record.ready_for_intel,
      ready_for_awareness: record.ready_for_awareness,
    });

    if (source_type === 'threat') {
      await notifyAgents(['Owen'], {
        type: 'BRAND_INTEGRITY_CHECK',
        record_id: record.id,
        threat_record_id: source_id,
        message: `Threat record ${source_id} normalized by Barbara. Check platform stack for CVE intersection. If found: elevate patch SLA to Critical and escalate to Cy immediately.`,
      });
    }

    res.json(record);
  } catch (e) { next(e); }
});

// GET /api/pipeline/repository/queue  (James, Ruth)
router.get('/repository/queue', requireAgentToken(['James', 'Ruth', 'Kirby', 'Henry']), async (req, res, next) => {
  try {
    const { pipeline, limit } = req.query;
    if (!['intel', 'awareness'].includes(pipeline))
      return res.status(400).json(err('INVALID_PIPELINE', 'pipeline must be intel or awareness'));

    const items = await db.getRepositoryQueue({ pipeline, limit: parseInt(limit) || 30 });
    res.json({ data: items, meta: { count: items.length, pipeline } });
  } catch (e) { next(e); }
});

// POST /api/pipeline/articles  (James only)
router.post('/articles', requireAgentToken([...INTEL_AGENTS]), async (req, res, next) => {
  try {
    const { title, section, body_md, access_tier, source_ids } = req.body;
    const validSections = ['threat', 'policy', 'innovation', 'growth', 'training'];
    const validTiers = ['freemium', 'monthly', 'enterprise'];

    if (!title || !section || !body_md || !access_tier)
      return res.status(400).json(err('MISSING_FIELDS', 'title, section, body_md, access_tier are required'));
    if (!validSections.includes(section)) return res.status(400).json(err('INVALID_SECTION', `section must be one of: ${validSections.join(', ')}`));
    if (!validTiers.includes(access_tier)) return res.status(400).json(err('INVALID_TIER', `access_tier must be one of: ${validTiers.join(', ')}`));

    const article = await db.createArticle({ title, section, body_md, access_tier, source_ids: source_ids || [], created_by: req.agent.name });

    await db.logPipelineEvent({ content_type: 'article', content_id: article.id, from_status: null, to_status: 'draft', agent_name: req.agent.name, notes: 'Article created' });
  
    const task = await db.createTask({ agent_name: 'Jason', task_type: 'dev_edit', content_type: 'article', content_id: article.id, sla_deadline: null });

    res.status(201).json({ id: article.id, slug: article.slug, pipeline_status: 'draft', queued_task_id: task.id });
  } catch (e) { next(e); }
});

// PATCH /api/pipeline/articles/:id/status
router.patch('/articles/:id/status', requireAgentToken([...INTEL_AGENTS]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { to_status, agent_name, notes } = req.body;

    if (!to_status || !agent_name) return res.status(400).json(err('MISSING_FIELDS', 'to_status and agent_name are required'));

    const article = await db.getArticleById(id);
    if (!article) return res.status(404).json(err('NOT_FOUND', 'Article not found'));

    const transition = validatePipelineTransition('article', article.pipeline_status, to_status, agent_name, article);
    if (!transition.valid) return res.status(422).json(err('INVALID_TRANSITION', transition.reason));

    const updated = await db.advanceArticleStatus(id, to_status);
    await db.logPipelineEvent({ content_type: 'article', content_id: id, from_status: article.pipeline_status, to_status, agent_name, notes });

    await triggerEscalationCheck('intel', agent_name, id, to_status);

    if (to_status === 'published' && article.threat_records_linked) {
      await db.linkThreatToArticle(article.threat_records_linked, id);
    }

    res.json({ id, from_status: article.pipeline_status, to_status, updated_at: updated.updated_at || new Date().toISOString() });
  } catch (e) { next(e); }
});

// POST /api/pipeline/briefings  (Ruth only)
router.post('/briefings', requireAgentToken(['Ruth', 'Henry']), async (req, res, next) => {
  try {
    const { edition_date, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id } = req.body;

    if (!edition_date || !subject_line || !body_md || !threat_item_ids || !innovation_item_ids || !growth_item_id || !training_byte_id)
      return res.status(400).json(err('MISSING_FIELDS', 'edition_date, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id are required'));

    if (!Array.isArray(threat_item_ids) || threat_item_ids.length !== 3)
      return res.status(422).json(err('INVALID_COMPOSITION', 'Exactly 3 threat items are required per briefing', 'threat_item_ids'));

    if (!Array.isArray(innovation_item_ids) || innovation_item_ids.length !== 2)
      return res.status(422).json(err('INVALID_COMPOSITION', 'Exactly 2 innovation items are required per briefing', 'innovation_item_ids'));

    const existing = await db.getBriefingByDate(edition_date);
    if (existing) return res.status(409).json(err('DUPLICATE_EDITION', `A briefing for ${edition_date} already exists`));

    const briefing = await db.createBriefing({ edition_date, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id });

    await db.logPipelineEvent({ content_type: 'briefing', content_id: briefing.id, from_status: null, to_status: 'draft', agent_name: 'Ruth', notes: `Daily briefing draft for ${edition_date}` });

    const sla = new Date();
    sla.setHours(6, 15, 0, 0);
    const task = await db.createTask({ agent_name: 'Peter', task_type: 'dev_edit_briefing', content_type: 'briefing', content_id: briefing.id, sla_deadline: sla });

    await notifyAgents(['Peter'], {
      type: 'BRIEFING_READY_FOR_DEV_EDIT',
      briefing_id: briefing.id,
      edition_date,
      task_id: task.id,
      sla_deadline: sla.toISOString(),
      message: `Briefing for ${edition_date} is ready for developmental editing. SLA: 06:30 CT.`,
    });

    res.status(201).json({ id: briefing.id, edition_date, pipeline_status: 'draft', draft_completed_at: briefing.draft_completed_at, queued_task_id: task.id });
  } catch (e) { next(e); }
});

// PATCH /api/pipeline/briefings/:id/status
router.patch('/briefings/:id/status', requireAgentToken([...AWARENESS_AGENTS]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { to_status, agent_name, notes } = req.body;

    if (!to_status || !agent_name) return res.status(400).json(err('MISSING_FIELDS', 'to_status and agent_name are required'));

    const briefing = await db.getBriefingById(id);
    if (!briefing) return res.status(404).json(err('NOT_FOUND', 'Briefing not found'));

    const transition = validatePipelineTransition('briefing', briefing.pipeline_status, to_status, agent_name, briefing);
    if (!transition.valid) return res.status(422).json(err('INVALID_TRANSITION', transition.reason));

    const updated = await db.advanceBriefingStatus(id, to_status);
    await db.logPipelineEvent({ content_type: 'briefing', content_id: id, from_status: briefing.pipeline_status, to_status, agent_name, notes });

    await triggerEscalationCheck('awareness', agent_name, id, to_status);

    const SLA_TIMES = { dev_edit: '06:15', eic_review: '06:30', qa: '06:45', maya: '06:50', approved: '07:00', published: '09:00' };
    if (SLA_TIMES[to_status]) {
      const [h, m] = SLA_TIMES[to_status].split(':').map(Number);
      const sla = new Date(); sla.setHours(h, m, 0, 0);
      await db.logHandoffSLA({ from_agent: agent_name, to_agent: 'next', content_id: id, expected_at: sla, actual_at: new Date() });
    }

    // Forward handoff — create next-stage task and notify next agent
    const dispatch = AWARENESS_DISPATCH[to_status];
    if (dispatch) {
      const sla = new Date(); sla.setHours(dispatch.sla_h, dispatch.sla_m, 0, 0);
      const nextTask = await db.createTask({ agent_name: dispatch.agent, task_type: dispatch.task_type, content_type: 'briefing', content_id: id, sla_deadline: sla });
      await notifyAgents([dispatch.agent], {
        type: 'BRIEFING_HANDOFF',
        briefing_id: id,
        edition_date: briefing.edition_date,
        from_agent: agent_name,
        stage: to_status,
        task_id: nextTask.id,
        sla_deadline: sla.toISOString(),
        message: `Briefing for ${briefing.edition_date} handed off to ${dispatch.agent} by ${agent_name}. SLA: ${dispatch.sla_h}:${String(dispatch.sla_m).padStart(2, '0')} CT.`,
      });
    }

    // Rejection — notify Ruth so she can revise and resubmit
    if (to_status === 'draft' && briefing.pipeline_status !== 'draft') {
      await notifyAgents(['Ruth'], {
        type: 'BRIEFING_REJECTED',
        briefing_id: id,
        edition_date: briefing.edition_date,
        rejected_by: agent_name,
        from_stage: briefing.pipeline_status,
        notes,
        message: `Briefing for ${briefing.edition_date} rejected at ${briefing.pipeline_status} by ${agent_name} and returned to draft.${notes ? ` Notes: ${notes}` : ''}`,
      });
    }

    res.json({ id, from_status: briefing.pipeline_status, to_status });
  } catch (e) { next(e); }
});

// PATCH /api/pipeline/training/modules/:id/status  (Training agents)
router.patch('/training/modules/:id/status', requireAgentToken([...TRAINING_AGENTS]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { to_status, agent_name, notes } = req.body;

    if (!to_status || !agent_name) return res.status(400).json(err('MISSING_FIELDS', 'to_status and agent_name are required'));

    const module = await db.getTrainingModule(id);
    if (!module) return res.status(404).json(err('NOT_FOUND', 'Training module not found'));

    const transition = validatePipelineTransition('training', module.pipeline_status, to_status, agent_name, module);
    if (!transition.valid) return res.status(422).json(err('INVALID_TRANSITION', transition.reason));

    const updated = await db.advanceModuleStatus(id, to_status);
    await db.logPipelineEvent({ content_type: 'training', content_id: id, from_status: module.pipeline_status, to_status, agent_name, notes });

    res.json({ id, from_status: module.pipeline_status, to_status });
  } catch (e) { next(e); }
});

// POST /api/pipeline/training/modules  (Kirby only)
router.post('/training/modules', requireAgentToken(['Kirby', 'Henry']), async (req, res, next) => {
  try {
    const { title, type, phase, zt_module, access_tier, duration_min, content_url } = req.body;
    const validTypes = ['video', 'lab', 'step_by_step', 'glossary', 'training_byte'];
    const validPhases = ['1_video', '2_lab', '3_simulation', 'library'];

    if (!title || !type || !phase || !access_tier)
      return res.status(400).json(err('MISSING_FIELDS', 'title, type, phase, access_tier are required'));
    if (!validTypes.includes(type)) return res.status(400).json(err('INVALID_TYPE', `type must be one of: ${validTypes.join(', ')}`));
    if (!validPhases.includes(phase)) return res.status(400).json(err('INVALID_PHASE', `phase must be one of: ${validPhases.join(', ')}`));

    const module = await db.createTrainingModule({ title, type, phase, zt_module, access_tier, duration_min, content_url, created_by: req.agent.name });

    await db.logPipelineEvent({ content_type: 'training', content_id: module.id, from_status: null, to_status: 'draft', agent_name: 'Kirby', notes: 'Training module created' });

    res.status(201).json({ id: module.id, pipeline_status: 'draft' });
  } catch (e) { next(e); }
});

// POST /api/pipeline/release  (Laura only)
router.post('/release', requireAgentToken(['Laura', 'Henry']), async (req, res, next) => {
  try {
    const { content_type, content_id, maya_approved } = req.body;

    if (!content_type || !content_id || maya_approved !== true)
      return res.status(400).json(err('MISSING_FIELDS', 'content_type, content_id, and maya_approved:true are required'));

    let content;
    if (content_type === 'article') content = await db.getArticleById(content_id);
    else if (content_type === 'briefing') content = await db.getBriefingById(content_id);
    else if (content_type === 'training') content = await db.getTrainingModule(content_id);
    else return res.status(400).json(err('INVALID_CONTENT_TYPE', 'content_type must be article, briefing, or training'));

    if (!content) return res.status(404).json(err('NOT_FOUND', 'Content not found'));
    if (!content.maya_approved_at && content.pipeline_status !== 'approved')
      return res.status(422).json(err('NOT_APPROVED', 'Content has not received Maya approval. Distribution blocked.'));

    if (content_type === 'article') await db.advanceArticleStatus(content_id, 'published');
    else if (content_type === 'briefing') await db.advanceBriefingStatus(content_id, 'published');
    else if (content_type === 'training') await db.advanceModuleStatus(content_id, 'published');

    await db.logPipelineEvent({ content_type, content_id, from_status: 'approved', to_status: 'published', agent_name: 'Laura', notes: 'Released by Laura after Maya approval' });
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'CONTENT_TYPE_CHECK', content_type: content_type, is_briefing: content_type === 'briefing' }));
    
    // ── Email distribution ────────────────────────────────────────────────
    if (content_type === 'briefing') {
      try {
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'RELEASE_DEBUG', content_type, content_id }));
        const { sendBriefingEmail } = require('../services/sendgrid');
        const subscribers = await db.pool.query(
          `SELECT email, full_name FROM users
           WHERE email_subscribed = true
           AND email_verified = true
           AND deleted_at IS NULL`
        ).then(r => r.rows.map(u => ({ email: u.email, name: u.full_name || 'Reader' })));

        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'BRIEFING_EMAIL_ATTEMPT', briefing_id: content_id, subject: content.subject_line, edition_date: content.edition_date, subscribers: subscribers.length }));

        if (subscribers.length > 0) {
          await sendBriefingEmail(subscribers, content);
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'BRIEFING_EMAIL_SENT', briefing_id: content_id, recipients: subscribers.length }));
        } else {
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'BRIEFING_EMAIL_SKIPPED', briefing_id: content_id, reason: 'no eligible subscribers' }));
        }
      } catch (e) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'BRIEFING_EMAIL_FAILED', briefing_id: content_id, error: e.message }));
      }
    }
    // ── End email distribution ────────────────────────────────────────────

    const distribution_tasks = [];
    if (content_type === 'training' && content?.type === 'video') {
      const t = await db.createTask({ agent_name: 'Ethan', task_type: 'publish_video', content_type: 'training', content_id, sla_deadline: null });
      distribution_tasks.push({ agent: 'Ethan', task_id: t.id });
      await notifyAgents(['Ethan'], { type: 'RELEASE_SIGNAL', content_type, content_id, maya_approved_at: content.maya_approved_at });
    }

    res.json({ released: true, content_type, content_id, published_at: new Date().toISOString(), distribution_tasks });
  } catch (e) { next(e); }
});

module.exports = router;