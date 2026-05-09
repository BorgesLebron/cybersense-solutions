'use strict';

// ── content.js ────────────────────────────────────────────────────────────────
const express = require('express');
const contentRouter = express.Router();
const db = require('../db/queries');
const { requireUserToken, requireAdminToken, gateContent, TIER_RANK, AGENT_PERMISSIONS, err } = require('../middleware/auth');

contentRouter.get('/articles', requireUserToken('free'), async (req, res, next) => {
  try {
    const { section, page = 1, limit = 20 } = req.query;
    const articles = await db.listArticles({ section, page: +page, limit: +limit });
    const gated = articles.map(a => gateContent(a, req.user.tier));
    const total = await db.pool.query('SELECT COUNT(*) FROM articles WHERE pipeline_status=$1', ['published']).then(r => +r.rows[0].count);
    res.json({ data: gated, meta: { page: +page, limit: +limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) { next(e); }
});

contentRouter.get('/articles/:slug', requireUserToken('free'), async (req, res, next) => {
  try {
    const article = await db.getArticle(req.params.slug);
    if (!article || article.pipeline_status !== 'published') return res.status(404).json(err('NOT_FOUND', 'Article not found'));
    await db.incrementArticleViews(article.id);
    res.json(gateContent(article, req.user.tier));
  } catch (e) { next(e); }
});

contentRouter.get('/briefings', requireUserToken('free'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    if (TIER_RANK[req.user.tier] < TIER_RANK['freemium']) {
      const current = await db.pool.query("SELECT id,edition_date,subject_line FROM briefings WHERE pipeline_status='published' AND edition_date <= CURRENT_DATE ORDER BY edition_date DESC LIMIT 1").then(r => r.rows[0]);
      return res.json({ data: [{ ...current, blurred: true, teaser: 'Subscribe free to read the Daily Digital Awareness Briefing.' }], meta: { page: 1, limit: 1, total: 1, pages: 1 } });
    }
    const briefings = await db.listBriefings({ page: +page, limit: +limit });
    const total = await db.pool.query("SELECT COUNT(*) FROM briefings WHERE pipeline_status='published'").then(r => +r.rows[0].count);
    res.json({ data: briefings, meta: { page: +page, limit: +limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) { next(e); }
});

contentRouter.get('/briefings/:date', requireUserToken('freemium'), async (req, res, next) => {
  try {
    const briefing = await db.getBriefingByDate(req.params.date);
    if (!briefing || briefing.pipeline_status !== 'published') return res.status(404).json(err('NOT_FOUND', 'Briefing not found'));
    res.json(briefing);
  } catch (e) { next(e); }
});

contentRouter.get('/radar', requireUserToken('free'), async (req, res, next) => {
  try {
    const { severity, page = 1, limit = 50 } = req.query;
    const threats = await db.getThreatRecords({ severity, page: +page, limit: +limit });
    const isSubscriber = TIER_RANK[req.user.tier] >= TIER_RANK['monthly'];
    const BLUR_AFTER = 7;
    const gated = threats.map((t, i) => {
      if (i >= BLUR_AFTER && !isSubscriber) return { id: t.id, blurred: true };
      return { id: t.id, severity: t.severity, threat_name: t.threat_name, cve_id: t.cve_id, cvss_score: t.cvss_score, category: t.category, tags: t.tags, priority: t.priority, ingested_at: t.ingested_at, article_link: t.has_article ? `/intel/${t.article_id}` : null };
    });
    res.json({ data: gated, meta: { page: +page, limit: +limit, subscriber_view: isSubscriber } });
  } catch (e) { next(e); }
});

contentRouter.get('/radar/:id', requireUserToken('monthly'), async (req, res, next) => {
  try {
    const threat = await db.getThreatById(req.params.id);
    if (!threat) return res.status(404).json(err('NOT_FOUND', 'Threat record not found'));
    const { source_url, raw_data, ...safe } = threat;
    res.json(safe);
  } catch (e) { next(e); }
});

// ── users.js ──────────────────────────────────────────────────────────────────
const usersRouter = express.Router();
const stripeService = require('../services/stripe');

usersRouter.get('/me', requireUserToken(), async (req, res, next) => {
  try {
    const sub = await db.pool.query("SELECT tier,status,mrr_cents,current_period_end FROM subscriptions WHERE user_id=$1 AND status='active' LIMIT 1", [req.user.id]).then(r => r.rows[0] || null);
    const adminRole = await db.getAdminRole(req.user.id);
    const { password_hash, ...safe } = req.user;
    res.json({ ...safe, subscription: sub, admin_role: adminRole || null });
  } catch (e) { next(e); }
});

usersRouter.patch('/me', requireUserToken(), async (req, res, next) => {
  try {
    const allowed = ['full_name', 'email_subscribed'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json(err('NO_VALID_FIELDS', 'No valid fields to update'));
    const updated = await db.updateUser(req.user.id, updates);
    const { password_hash, ...safe } = updated;
    res.json(safe);
  } catch (e) { next(e); }
});

usersRouter.delete('/me', requireUserToken(), async (req, res, next) => {
  try {
    const sub = await db.pool.query("SELECT stripe_subscription_id FROM subscriptions WHERE user_id=$1 AND status='active'", [req.user.id]).then(r => r.rows[0]);
    if (sub?.stripe_subscription_id) await stripeService.cancelSubscription(sub.stripe_subscription_id);
    await db.softDeleteUser(req.user.id);
    res.clearCookie('cs_refresh');
    res.json({ message: 'Account deleted.' });
  } catch (e) { next(e); }
});

usersRouter.get('/', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const { page = 1, limit = 50, tier } = req.query;
    const users = await db.listUsers({ page: +page, limit: +limit, tier });
    const count = await db.countUsers(tier);
    res.json({ data: users, meta: { page: +page, limit: +limit, total: +count.count, pages: Math.ceil(count.count / limit) } });
  } catch (e) { next(e); }
});

usersRouter.get('/:id', requireAdminToken(), async (req, res, next) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json(err('NOT_FOUND', 'User not found'));
    const { password_hash, ...safe } = user;
    res.json(safe);
  } catch (e) { next(e); }
});

usersRouter.patch('/:id/tier', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { tier } = req.body;
    const validTiers = ['free', 'freemium', 'monthly', 'enterprise'];
    if (!validTiers.includes(tier)) return res.status(400).json(err('INVALID_TIER', `tier must be one of: ${validTiers.join(', ')}`));
    const updated = await db.updateUserTier(req.params.id, tier);
    if (!updated) return res.status(404).json(err('NOT_FOUND', 'User not found'));
    await db.logAuditEvent({ actor: req.user.id, action: 'manual_tier_override', target_agent: null, reason: `Tier changed to ${tier}`, affected_content_id: req.params.id });
    res.json({ id: updated.id, tier: updated.tier });
  } catch (e) { next(e); }
});

// ── tasks.js ──────────────────────────────────────────────────────────────────
const tasksRouter = express.Router();
const { requireAgentToken } = require('../middleware/auth');
const { notifyAgents } = require('../services/agents');

tasksRouter.post('/', requireAgentToken([]), async (req, res, next) => {
  try {
    const { agent_name, task_type, content_type, content_id, sla_deadline } = req.body;
    if (!agent_name || !task_type || !content_type || !content_id) return res.status(400).json(err('MISSING_FIELDS', 'agent_name, task_type, content_type, content_id are required'));
    const task = await db.createTask({ agent_name, task_type, content_type, content_id, sla_deadline: sla_deadline || null });
    res.status(201).json(task);
  } catch (e) { next(e); }
});

tasksRouter.patch('/:id', requireAgentToken([]), async (req, res, next) => {
  try {
    const { status, error_message } = req.body;
    const validStatuses = ['queued', 'in_progress', 'complete', 'failed', 'escalated'];
    if (!validStatuses.includes(status)) return res.status(400).json(err('INVALID_STATUS', `status must be one of: ${validStatuses.join(', ')}`));
    const task = await db.updateTask(req.params.id, { status, error_message });
    if (!task) return res.status(404).json(err('NOT_FOUND', 'Task not found'));
    if (status === 'failed') {
      const failCount = await db.pool.query("SELECT COUNT(*) FROM agent_tasks WHERE agent_name=$1 AND status='failed' AND started_at > now()-interval '24 hours'", [task.agent_name]).then(r => +r.rows[0].count);
      if (failCount >= 3) await notifyAgents(['Victor', 'Barret'], { type: 'FAILURE_PATTERN', agent_name: task.agent_name, count: failCount });
    }
    res.json(task);
  } catch (e) { next(e); }
});

tasksRouter.get('/', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const { agent_name, status, content_type, date, page = 1, limit = 50 } = req.query;
    const tasks = await db.listTasks({ agent_name, status, content_type, date, page: +page, limit: +limit });
    res.json({ data: tasks, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

tasksRouter.get('/sla-breaches', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const breaches = await db.getSLABreaches();
    res.json({ data: breaches });
  } catch (e) { next(e); }
});

// ── training.js ───────────────────────────────────────────────────────────────
const trainingRouter = express.Router();

trainingRouter.get('/modules', requireUserToken('monthly'), async (req, res, next) => {
  try {
    const { type, phase, zt_module, page = 1, limit = 30 } = req.query;
    const modules = await db.listTrainingModules({ type, phase, zt_module, page: +page, limit: +limit });
    res.json({ data: modules, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

trainingRouter.get('/modules/:id', requireUserToken('free'), async (req, res, next) => {
  try {
    const module = await db.getTrainingModule(req.params.id);
    if (!module || module.pipeline_status !== 'published') return res.status(404).json(err('NOT_FOUND', 'Module not found'));
    if (TIER_RANK[req.user.tier] < TIER_RANK[module.access_tier]) return res.json({ id: module.id, title: module.title, type: module.type, access_tier: module.access_tier, locked: true });
    res.json(module);
  } catch (e) { next(e); }
});

trainingRouter.post('/completions', requireUserToken('monthly'), async (req, res, next) => {
  try {
    const { module_id, score, time_spent_min } = req.body;
    if (!module_id || score == null || !time_spent_min) return res.status(400).json(err('MISSING_FIELDS', 'module_id, score, time_spent_min are required'));
    if (score < 0 || score > 100) return res.status(400).json(err('INVALID_SCORE', 'score must be between 0 and 100'));
    const completion = await db.recordCompletion({ user_id: req.user.id, module_id, org_id: req.user.org_id, department: req.user.department, score, time_spent_min });
    res.status(201).json(completion);
  } catch (e) { next(e); }
});

trainingRouter.get('/completions/me', requireUserToken(), async (req, res, next) => {
  try {
    const completions = await db.getUserCompletions(req.user.id);
    res.json({ data: completions });
  } catch (e) { next(e); }
});

trainingRouter.get('/completions/org/:org_id', requireAdminToken(['gm', 'training', 'analyst']), async (req, res, next) => {
  try {
    const { org_id } = req.params;
    const { department } = req.query;
    const [details, summary] = await Promise.all([db.getOrgCompletions(org_id, { department }), db.getOrgCompletionSummary(org_id)]);
    res.json({ org_id, summary, details });
  } catch (e) { next(e); }
});

trainingRouter.post('/simulations', requireAgentToken(['Kirby', 'Henry']), async (req, res, next) => {
  try {
    const { org_id, type, campaign_name, target_count } = req.body;
    const validTypes = ['phishing', 'spear_phishing', 'vishing', 'smishing'];
    if (!org_id || !type || !campaign_name || !target_count) return res.status(400).json(err('MISSING_FIELDS', 'org_id, type, campaign_name, target_count are required'));
    if (!validTypes.includes(type)) return res.status(400).json(err('INVALID_TYPE', `type must be one of: ${validTypes.join(', ')}`));
    const sim = await db.createSimulation({ org_id, type, campaign_name, target_count });
    res.status(201).json(sim);
  } catch (e) { next(e); }
});

trainingRouter.post('/simulations/:id/results', requireAgentToken(['Kirby', 'Henry']), async (req, res, next) => {
  try {
    const { simulation_id, user_id, outcome, response_time_sec, department } = req.body;
    const validOutcomes = ['reported', 'clicked', 'ignored'];
    if (!validOutcomes.includes(outcome)) return res.status(400).json(err('INVALID_OUTCOME', `outcome must be one of: ${validOutcomes.join(', ')}`));
    const result = await db.recordSimulationResult({ simulation_id: req.params.id, user_id, outcome, response_time_sec, department });
    const updates = { reported_count: outcome === 'reported' ? db.pool.query('UPDATE simulations SET reported_count=reported_count+1 WHERE id=$1', [req.params.id]) : null, clicked_count: outcome === 'clicked' ? db.pool.query('UPDATE simulations SET clicked_count=clicked_count+1 WHERE id=$1', [req.params.id]) : null };
    res.status(201).json(result);
  } catch (e) { next(e); }
});

trainingRouter.get('/simulations/org/:org_id', requireAdminToken(['gm', 'training', 'analyst']), async (req, res, next) => {
  try {
    const { org_id } = req.params;
    const sims = await db.getOrgSimulations(org_id);
    res.json({ data: sims });
  } catch (e) { next(e); }
});

// ── revenue.js ────────────────────────────────────────────────────────────────
const revenueRouter = express.Router();
const stripe = require('../services/stripe');
const crypto = require('crypto');

revenueRouter.post('/subscribe', requireUserToken(), async (req, res, next) => {
  try {
    const { tier } = req.body;
    const validTiers = ['monthly', 'enterprise'];
    if (!validTiers.includes(tier)) return res.status(400).json(err('INVALID_TIER', 'tier must be monthly or enterprise'));
    const session = await stripe.createCheckoutSession({ user: req.user, tier });
    res.json({ checkout_url: session.url });
  } catch (e) { next(e); }
});

revenueRouter.post('/portal', requireUserToken(), async (req, res, next) => {
  try {
    if (!req.user.stripe_customer_id) return res.status(400).json(err('NO_SUBSCRIPTION', 'No active subscription found'));
    const session = await stripe.createBillingPortal(req.user.stripe_customer_id);
    res.json({ portal_url: session.url });
  } catch (e) { next(e); }
});

revenueRouter.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.constructWebhookEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (e) { return res.status(400).json(err('INVALID_SIGNATURE', 'Stripe webhook signature verification failed')); }

    const data = event.data.object;

    await db.logStripeEvent({ stripe_event_id: event.id, event_type: event.type, subscription_id: data.id, amount_cents: data.amount_paid || null, payload: event });

    if (event.type === 'invoice.paid') {
      const sub = await db.getSubscriptionByStripeId(data.subscription);
      if (sub) {
        await db.updateSubscription(data.subscription, { status: 'active', current_period_start: new Date(data.period_start * 1000), current_period_end: new Date(data.period_end * 1000) });
        // S3: notify Mary on new paid activation (first invoice = upgrade event)
        if (data.billing_reason === 'subscription_create') {
          const user = sub.user_id ? await db.getUserById(sub.user_id) : null;
          await notifyAgents(['Mary'], {
            type: 'UPGRADE_EVENT',
            user_id: sub.user_id,
            org_id: sub.org_id,
            email: user?.email,
            full_name: user?.full_name,
            tier: sub.tier,
            mrr_cents: sub.mrr_cents,
            message: `New paid activation: ${user?.email || sub.org_id} upgraded to ${sub.tier}. Qualify for account handoff to William. (S3)`,
          });
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = await db.getSubscriptionByStripeId(data.id);
      if (sub) {
        await db.updateSubscription(data.id, { status: 'cancelled', cancelled_at: new Date() });
        await db.updateUserTier(sub.user_id || sub.org_id, 'free');
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = await db.getSubscriptionByStripeId(data.id);
      if (sub) {
        const newStatus = data.status === 'active' ? 'active' : data.status === 'past_due' ? 'past_due' : 'cancelled';
        await db.updateSubscription(data.id, { status: newStatus, current_period_end: new Date(data.current_period_end * 1000) });
      }
    }

    res.json({ received: true });
  } catch (e) { next(e); }
});

revenueRouter.get('/subscriptions', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const { page = 1, limit = 50, tier, status } = req.query;
    const subs = await db.listSubscriptions({ page: +page, limit: +limit, tier, status });
    res.json({ data: subs, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

revenueRouter.get('/mrr', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const [snapshot, live, breakdown] = await Promise.all([db.getLatestSnapshot(), db.getLiveMetricsDelta(), db.getMRRSummary()]);
    const totalMRR = breakdown.reduce((s, r) => s + parseInt(r.mrr_cents), 0);
    res.json({
      mrr_cents: totalMRR,
      mrr_usd: (totalMRR / 100).toFixed(2),
      arr_usd: ((totalMRR * 12) / 100).toFixed(2),
      churn_rate: snapshot?.churn_rate || null,
      by_tier: breakdown.map(r => ({ tier: r.tier, accounts: +r.accounts, mrr_cents: +r.mrr_cents })),
      snapshot_date: snapshot?.snapshot_date || null,
    });
  } catch (e) { next(e); }
});

// ── sales.js ──────────────────────────────────────────────────────────────────
const salesRouter = express.Router();
const SALES_AGENTS = ['Mary', 'William', 'Joe', 'Henry'];

salesRouter.post('/leads', async (req, res, next) => {
  try {
    const { email, full_name, company, source, target_tier, est_seats, est_value_cents, notes } = req.body;
    if (!email || !full_name) return res.status(400).json(err('MISSING_FIELDS', 'email and full_name are required'));
    const lead = await db.createLead({ email, full_name, company, source: source || 'direct', target_tier, est_seats, est_value_cents, notes });
    res.status(201).json(lead);
  } catch (e) { next(e); }
});

salesRouter.patch('/leads/:id', requireAgentToken(SALES_AGENTS), async (req, res, next) => {
  try {
    const allowed = ['status', 'assigned_to', 'notes', 'est_seats', 'est_value_cents', 'converted_at'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const lead = await db.updateLead(req.params.id, updates);
    if (!lead) return res.status(404).json(err('NOT_FOUND', 'Lead not found'));
    res.json(lead);
  } catch (e) { next(e); }
});

salesRouter.get('/leads', requireAdminToken(['gm', 'sales']), async (req, res, next) => {
  try {
    const { status, assigned_to, page = 1, limit = 50 } = req.query;
    const leads = await db.listLeads({ status, assigned_to, page: +page, limit: +limit });
    res.json({ data: leads, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

salesRouter.get('/accounts', requireAdminToken(['gm', 'sales']), async (req, res, next) => {
  try {
    const orgs = await db.listOrgs();
    res.json({ data: orgs });
  } catch (e) { next(e); }
});

salesRouter.patch('/accounts/:id', requireAgentToken(SALES_AGENTS), async (req, res, next) => {
  try {
    const allowed = ['health_score', 'renewal_date', 'account_manager_id', 'seat_count'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const org = await db.updateOrg(req.params.id, updates);
    if (!org) return res.status(404).json(err('NOT_FOUND', 'Account not found'));
    res.json(org);
  } catch (e) { next(e); }
});

salesRouter.get('/partners', requireAdminToken(['gm', 'sales']), async (req, res, next) => {
  try {
    const partners = await db.listPartners();
    res.json({ data: partners });
  } catch (e) { next(e); }
});

salesRouter.post('/partners', requireAgentToken(['William', 'Henry']), async (req, res, next) => {
  try {
    const { name, type, status, monthly_value_cents, commission_pct, contract_start, contract_end, owner_agent } = req.body;
    if (!name || !type) return res.status(400).json(err('MISSING_FIELDS', 'name and type are required'));
    const partner = await db.createPartner({ name, type, status, monthly_value_cents, commission_pct, contract_start, contract_end, owner_agent: owner_agent || req.agent.name });
    res.status(201).json(partner);
  } catch (e) { next(e); }
});

// ── ops.js ────────────────────────────────────────────────────────────────────
const opsRouter = express.Router();

opsRouter.get('/dashboard', requireAdminToken(), async (req, res, next) => {
  try {
    const [snapshot, live] = await Promise.all([db.getLatestSnapshot(), db.getLiveMetricsDelta()]);
    res.json({ snapshot, live, generated_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

opsRouter.get('/pipeline-status', requireAdminToken(), async (req, res, next) => {
  try {
    const status = await db.getPipelineStatus();
    res.json({ data: status });
  } catch (e) { next(e); }
});

opsRouter.get('/activity-feed', requireAdminToken(), async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const feed = await db.getActivityFeed(+limit);
    res.json({ data: feed });
  } catch (e) { next(e); }
});

opsRouter.post('/risk', requireAgentToken([]), async (req, res, next) => {
  try {
    const { domain, title, description, severity, score, owner_agent, due_date } = req.body;
    const validDomains = ['operational', 'intelligence', 'reputational', 'financial', 'compliance'];
    const validSeverities = ['high', 'medium', 'low'];
    if (!domain || !title || !severity) return res.status(400).json(err('MISSING_FIELDS', 'domain, title, severity are required'));
    if (!validDomains.includes(domain)) return res.status(400).json(err('INVALID_DOMAIN', `domain must be one of: ${validDomains.join(', ')}`));
    if (!validSeverities.includes(severity)) return res.status(400).json(err('INVALID_SEVERITY', `severity must be one of: ${validSeverities.join(', ')}`));
    const raised_by = req.agent?.name || req.user?.id || 'system';
    const risk = await db.createRisk({ domain, title, description, severity, score: score || (severity === 'high' ? 70 : severity === 'medium' ? 45 : 20), owner_agent, raised_by, due_date });
    if (severity === 'high') await notifyAgents(['Henry'], { type: 'HIGH_RISK_RAISED', risk_id: risk.id, title, domain, severity });
    res.status(201).json(risk);
  } catch (e) { next(e); }
});

opsRouter.patch('/risk/:id', requireAgentToken([]), async (req, res, next) => {
  try {
    const allowed = ['status', 'score', 'description', 'owner_agent', 'due_date', 'resolved_at'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (updates.status === 'resolved') updates.resolved_at = new Date().toISOString();
    const risk = await db.updateRisk(req.params.id, updates);
    if (!risk) return res.status(404).json(err('NOT_FOUND', 'Risk item not found'));
    res.json(risk);
  } catch (e) { next(e); }
});

opsRouter.get('/risk', requireAdminToken(), async (req, res, next) => {
  try {
    const { domain, severity, status } = req.query;
    const risks = await db.listRisks({ domain, severity, status: status || 'open' });
    res.json({ data: risks });
  } catch (e) { next(e); }
});

opsRouter.get('/sla', requireAdminToken(['gm', 'analyst']), async (req, res, next) => {
  try {
    const breaches = await db.getSLABreaches();
    res.json({ data: breaches });
  } catch (e) { next(e); }
});

opsRouter.post('/escalate', requireAgentToken([]), async (req, res, next) => {
  try {
    const { from_agent, to_agent, reason, content_id, severity } = req.body;
    if (!from_agent || !to_agent || !reason || !severity) return res.status(400).json(err('MISSING_FIELDS', 'from_agent, to_agent, reason, severity are required'));
    const escalation = await db.createEscalation({ from_agent, to_agent, reason, content_id, severity });
    if (to_agent === 'Henry' || severity === 'critical') await notifyAgents(['Henry', 'Barret'], { type: 'ESCALATION', escalation_id: escalation.id, from_agent, reason, severity });
    res.status(201).json(escalation);
  } catch (e) { next(e); }
});

// ── social.js ─────────────────────────────────────────────────────────────────
const socialRouter = express.Router();
const SOCIAL_AGENTS = ['Oliver', 'Lucy', 'Riley', 'Ethan', 'Henry'];

socialRouter.post('/posts', requireAgentToken(SOCIAL_AGENTS), async (req, res, next) => {
  try {
    const { briefing_id, platform, post_body, phase, scheduled_at, published_at } = req.body;
    const validPlatforms = ['linkedin', 'meta', 'x', 'tiktok', 'youtube'];
    const validPhases = ['0700_main', '0900_byte', '1200_note'];
    if (!briefing_id || !platform || !post_body || !phase)
      return res.status(400).json(err('MISSING_FIELDS', 'briefing_id, platform, post_body, phase are required'));
    if (!validPlatforms.includes(platform))
      return res.status(400).json(err('INVALID_PLATFORM', `platform must be one of: ${validPlatforms.join(', ')}`));
    if (!validPhases.includes(phase))
      return res.status(400).json(err('INVALID_PHASE', `phase must be one of: ${validPhases.join(', ')}`));

    const post = await db.createSocialPost({
      briefing_id, platform, agent_name: req.agent.name,
      post_body, phase, scheduled_at,
      published_at: published_at || new Date().toISOString()
    });

    // Publish to LinkedIn if platform is linkedin
    let linkedin_urn = null;
    if (platform === 'linkedin') {
      try {
        const { postToLinkedIn } = require('../services/linkedin');
        const result = await postToLinkedIn({ post_body, briefing_id });
        linkedin_urn = result.post_urn;
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'LINKEDIN_POSTED', post_id: post.id, urn: linkedin_urn }));
      } catch (e) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'LINKEDIN_POST_FAILED', post_id: post.id, error: e.message }));
      }
    }

    res.status(201).json({ ...post, linkedin_urn });
  } catch (e) { next(e); }
});

socialRouter.patch('/posts/:id/metrics', requireAgentToken(SOCIAL_AGENTS), async (req, res, next) => {
  try {
    const { reach, engagements, conversions } = req.body;
    if (reach == null || engagements == null || conversions == null) return res.status(400).json(err('MISSING_FIELDS', 'reach, engagements, conversions are required'));
    const post = await db.updateSocialMetrics(req.params.id, { reach, engagements, conversions });
    if (!post) return res.status(404).json(err('NOT_FOUND', 'Post not found'));
    res.json(post);
  } catch (e) { next(e); }
});

socialRouter.get('/posts', requireAdminToken(), async (req, res, next) => {
  try {
    const { platform, date, phase, page = 1, limit = 50 } = req.query;
    const posts = await db.listSocialPosts({ platform, date, phase, page: +page, limit: +limit });
    res.json({ data: posts, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

socialRouter.get('/performance', requireAdminToken(), async (req, res, next) => {
  try {
    const { platform, from_date, to_date } = req.query;
    const perf = await db.getSocialPerformance({ platform, from_date, to_date });
    res.json({ data: perf });
  } catch (e) { next(e); }
});

// ── admin.js ──────────────────────────────────────────────────────────────────
const adminRouter = express.Router();

// Aggregated Command Center metrics — single call for the full dashboard header row.
adminRouter.get('/metrics', requireAdminToken(), async (req, res, next) => {
  try {
    const [live, pipeline, activity, threatCount] = await Promise.all([
      db.getLiveMetricsDelta(),
      db.getPipelineStatus(),
      db.getActivityFeed(10),
      db.countActiveThreats(),
    ]);
    res.json({
      live,
      pipeline,
      activity,
      radar_threats: +(threatCount?.count ?? 0),
      jim_validated: false,
    });
  } catch (e) { next(e); }
});

adminRouter.get('/me', requireAdminToken(), async (req, res, next) => {
  try {
    const { password_hash, ...safe } = req.user;
    res.json({ ...safe, admin_role: req.adminRole });
  } catch (e) { next(e); }
});

adminRouter.get('/agents', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const health = await db.getAgentHealthSummary();
    res.json({ data: health, generated_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

adminRouter.post('/agents/:name/token', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { name } = req.params;
    const jwt = require('jsonwebtoken');
    const crypto = require('crypto');
    const agentConfig = require('../middleware/auth').AGENT_PERMISSIONS;
    if (!agentConfig[name]) return res.status(404).json(err('UNKNOWN_AGENT', `Agent ${name} not found in fleet`));
    const newToken = jwt.sign({ type: 'agent', agent_name: name, agent_team: agentConfig[name].teams[0] }, process.env.AGENT_JWT_SECRET);
    const hash = crypto.createHash('sha256').update(newToken).digest('hex');
    await db.rotateAgentToken(name, hash);
    await db.logAuditEvent({ actor: req.user.id, action: 'agent_token_rotation', target_agent: name, reason: 'Admin-initiated rotation', affected_content_id: null });
    res.json({ agent_name: name, token: newToken, rotated_at: new Date().toISOString(), message: 'Store this token securely — it will not be shown again.' });
  } catch (e) { next(e); }
});

adminRouter.post('/users/:id/role', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const validRoles = ['gm', 'editor', 'analyst', 'sales', 'training'];
    if (!role || !validRoles.includes(role)) return res.status(400).json(err('INVALID_ROLE', `role must be one of: ${validRoles.join(', ')}`));
    const user = await db.getUserById(id);
    if (!user) return res.status(404).json(err('NOT_FOUND', 'User not found'));
    const adminRole = await db.grantAdminRole(id, role, req.user.id);
    await db.logAuditEvent({ actor: req.user.id, action: 'admin_role_granted', target_agent: user.email, reason: `Role ${role} granted`, affected_content_id: null });
    res.json({ user_id: id, email: user.email, role: adminRole.role, granted_at: adminRole.granted_at });
  } catch (e) { next(e); }
});

// Transition-phase endpoint: create a briefing entry directly without requiring
// the full agent pipeline (no threat/intel/training records needed). Used when
// automated agents are not yet operational. Bypasses the API's 3-item composition
// validation — matches the archive migration approach.
adminRouter.post('/briefings/create-manual', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { edition_date, edition_number, subject_line, file_path, body_md } = req.body;
    if (!edition_date || !edition_number || !subject_line)
      return res.status(400).json(err('MISSING_FIELDS', 'edition_date, edition_number, subject_line are required'));

    const existing = await db.getBriefingByDate(edition_date);
    if (existing) return res.status(409).json(err('DUPLICATE_EDITION', `A briefing for ${edition_date} already exists (id: ${existing.id})`));

    const result = await db.pool.query(
      `INSERT INTO briefings
         (id, edition_date, edition_number, subject_line, body_md, file_path,
          threat_item_ids, innovation_item_ids, pipeline_status, draft_completed_at, open_count, click_count)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}', '{}', 'draft', now(), 0, 0)
       RETURNING id, edition_date, edition_number, subject_line, file_path, pipeline_status`,
      [edition_date, edition_number, subject_line, body_md || subject_line, file_path || null]
    );

    const briefing = result.rows[0];
    await db.logAuditEvent({
      actor: req.user.id,
      action: 'manual_briefing_created',
      target_agent: 'Henry',
      reason: `Manual briefing created by admin — Edition ${edition_number} (${edition_date})`,
      affected_content_id: briefing.id,
    });

    res.status(201).json(briefing);
  } catch (e) { next(e); }
});

adminRouter.delete('/briefings/:id', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    await db.deleteBriefingById(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { next(e); }
});

adminRouter.delete('/users/:id', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json(err('NOT_FOUND', 'User not found'));
    await db.softDeleteUser(req.params.id);
    res.json({ deleted: true, id: req.params.id, email: user.email });
  } catch (e) { next(e); }
});

adminRouter.get('/audit', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { agent, action_type, from_date, page = 1, limit = 50 } = req.query;
    const log = await db.getAuditLog({ agent, action_type, from_date, page: +page, limit: +limit });
    res.json({ data: log, meta: { page: +page, limit: +limit } });
  } catch (e) { next(e); }
});

// Returns briefings with pipeline_status='approved' — the Preview Briefing queue
adminRouter.get('/briefings/preview', requireAdminToken(), async (req, res, next) => {
  try {
    const briefings = await db.listApprovedBriefingPreviews();
    res.json({ data: briefings });
  } catch (e) { next(e); }
});

adminRouter.get('/threats', requireAdminToken(), async (req, res, next) => {
  try {
    const { severity, page = 1, limit = 50 } = req.query;
    const threats = await db.getThreatRecords({ severity, page: +page, limit: +limit });
    res.json({ data: threats });
  } catch (e) { next(e); }
});

adminRouter.get('/repository/items/:id', requireAdminToken(), async (req, res, next) => {
  try {
    const item = await db.getRepositoryItemDetail(req.params.id);
    if (!item) return res.status(404).json(err('NOT_FOUND', 'Repository item not found'));
    res.json(item);
  } catch (e) { next(e); }
});

adminRouter.get('/repository/items/:id/references', requireAdminToken(), async (req, res, next) => {
  try {
    const refs = await db.getApprovedContentReferences(req.params.id, parseInt(req.query.limit) || 8);
    res.json({ data: refs });
  } catch (e) { next(e); }
});

// Manual awareness pipeline trigger. Fires Ruth's daily_cycle task for the
// given edition_date (defaults to tomorrow CT). Bypasses idempotency guard only
// when force:true. Intended for validation runs and pipeline recovery.
adminRouter.post('/pipeline/ruth/trigger', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { date, force = false } = req.body;
    const editionDate = date || (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    })();

    if (!force) {
      const existing = await db.getBriefingByDate(editionDate);
      if (existing)
        return res.status(409).json(err('BRIEFING_EXISTS', `A briefing for ${editionDate} already exists. Pass force:true to override.`));
    }

    const sla = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const task = await db.createTask({
      agent_name: 'Ruth',
      task_type: 'daily_cycle',
      content_type: 'briefing',
      content_id: '00000000-0000-0000-0000-000000000000',
      sla_deadline: sla,
    });

    await notifyAgents(['Ruth'], {
      type: 'DAILY_CYCLE_START',
      edition_date: editionDate,
      sla_deadline: sla.toISOString(),
      composition_required: { threat: 3, innovation: 2, growth: 1, training_byte: 1 },
      kirby_deadline: '05:00 CT',
      ivan_charlie_deadline: '05:30 CT',
      triggered_by: 'manual_admin',
      message: `Begin daily cycle for ${editionDate}. Source, select, and structure 7 items per SOP OA-AWR-001. Deliver package to Peter by ${sla.toISOString()}.`,
    });

    await db.logAuditEvent({
      actor: req.user.id,
      action: 'ruth_cycle_manual_trigger',
      target_agent: 'Ruth',
      reason: `Manual trigger for ${editionDate}${force ? ' (forced)' : ''}`,
      affected_content_id: task.id,
    });

    res.json({ triggered: true, edition_date: editionDate, task_id: task.id, sla_deadline: sla.toISOString() });
  } catch (e) { next(e); }
});

// Human-in-the-loop gate. Confirms distribution, creates Laura's release task,
// and schedules Oliver's LinkedIn post for next 0700 CT.
// Distribution is blocked until this endpoint is called — no exceptions.
adminRouter.post('/briefings/:id/confirm-distribution', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const briefing = await db.getBriefingById(req.params.id);
    if (!briefing) return res.status(404).json(err('NOT_FOUND', 'Briefing not found'));
    if (briefing.pipeline_status !== 'approved')
      return res.status(422).json(err('NOT_APPROVED', 'Briefing must be in approved status before distribution can be confirmed'));

    // Next 0700 CT (server local time — same timezone convention as rest of codebase)
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + 1);
    scheduledAt.setHours(7, 0, 0, 0);

    const lauraTask = await db.createTask({
      agent_name: 'Laura',
      task_type: 'release_briefing',
      content_type: 'briefing',
      content_id: briefing.id,
      sla_deadline: new Date(scheduledAt.getTime() - 5 * 60 * 1000),
    });

    const oliverTask = await db.createTask({
      agent_name: 'Oliver',
      task_type: 'post_scheduled',
      content_type: 'briefing',
      content_id: briefing.id,
      sla_deadline: scheduledAt,
    });

    await db.logAuditEvent({
      actor: req.user.id,
      action: 'hitl_distribution_confirmed',
      target_agent: 'Laura',
      reason: `Distribution confirmed — Edition ${briefing.edition_number} (${briefing.edition_date})`,
      affected_content_id: briefing.id,
    });

    await notifyAgents(['Laura'], {
      type: 'DISTRIBUTION_CONFIRMED',
      briefing_id: briefing.id,
      edition_number: briefing.edition_number,
      edition_date: briefing.edition_date,
      subject_line: briefing.subject_line,
      task_id: lauraTask.id,
      scheduled_post_at: scheduledAt.toISOString(),
      message: `Human executive confirmed distribution for Edition ${briefing.edition_number}. Release briefing and trigger email distribution. Oliver's LinkedIn post is scheduled for ${scheduledAt.toISOString()}.`,
    });

    await notifyAgents(['Oliver'], {
      type: 'POST_SCHEDULED',
      briefing_id: briefing.id,
      edition_number: briefing.edition_number,
      edition_date: briefing.edition_date,
      subject_line: briefing.subject_line,
      task_id: oliverTask.id,
      scheduled_at: scheduledAt.toISOString(),
      platform: 'linkedin',
      message: `LinkedIn post for Edition ${briefing.edition_number} scheduled for ${scheduledAt.toISOString()}. Prepare post content. Scheduler triggers execution at 0700 CT.`,
    });

    await db.advanceBriefingStatus(briefing.id, 'published');

    await db.logPipelineEvent({
      content_type: 'briefing',
      content_id: briefing.id,
      from_status: 'approved',
      to_status: 'published',
      agent_name: 'human_executive',
      notes: `Distribution confirmed by human executive — Edition ${briefing.edition_number}`,
    });

    res.json({
      confirmed: true,
      briefing_id: briefing.id,
      edition_number: briefing.edition_number,
      edition_date: briefing.edition_date,
      scheduled_post_at: scheduledAt.toISOString(),
      laura_task_id: lauraTask.id,
      oliver_task_id: oliverTask.id,
    });
  } catch (e) { next(e); }
});

// Executive requests revision — returns briefing to Maya with a documented reason.
// Status reverts to 'maya', maya_approved_at cleared, Maya notified.
adminRouter.post('/briefings/:id/request-revision', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const briefing = await db.getBriefingById(req.params.id);
    if (!briefing) return res.status(404).json(err('NOT_FOUND', 'Briefing not found'));
    if (briefing.pipeline_status !== 'approved')
      return res.status(422).json(err('INVALID_STATUS', 'Only Maya-approved briefings can be returned for revision'));

    const { reason = 'Executive requested revision before distribution' } = req.body;

    await db.revertBriefingForRevision(req.params.id);

    await db.logAuditEvent({
      actor: req.user.id,
      action: 'hitl_revision_requested',
      target_agent: 'Maya',
      reason,
      affected_content_id: req.params.id,
    });

    await notifyAgents(['Maya'], {
      type: 'REVISION_REQUESTED',
      briefing_id: briefing.id,
      edition_number: briefing.edition_number,
      edition_date: briefing.edition_date,
      subject_line: briefing.subject_line,
      reason,
      message: `Human executive returned Edition ${briefing.edition_number} for revision: "${reason}". Review, revise, and re-approve or escalate to Henry.`,
    });

    res.json({ revision_requested: true, briefing_id: briefing.id, reason });
  } catch (e) { next(e); }
});

// ── Meetings (Conference tab) ─────────────────────────────────────────────────
// Convener routing is enforced server-side: operational/editorial/training → Henry, security → Cy.

adminRouter.get('/meetings', requireAdminToken(), async (req, res, next) => {
  try {
    const { status } = req.query;
    const meetings = await db.listMeetings({ status });
    res.json({ data: meetings });
  } catch (e) { next(e); }
});

adminRouter.post('/meetings', requireAdminToken(), async (req, res, next) => {
  try {
    const { title, type, agenda } = req.body;
    const validTypes = ['operational', 'security', 'editorial', 'training'];
    if (!title || !type) return res.status(400).json(err('MISSING_FIELDS', 'title and type are required'));
    if (!validTypes.includes(type)) return res.status(400).json(err('INVALID_TYPE', `type must be one of: ${validTypes.join(', ')}`));

    const convener = type === 'security' ? 'Cy' : 'Henry';

    const meeting = await db.createMeeting({ title, type, convener, initiated_by: req.user.id, agenda });

    await db.logAuditEvent({
      actor: req.user.id,
      action: 'meeting_created',
      target_agent: convener,
      reason: `${type} meeting initiated: ${title}`,
      affected_content_id: meeting.id,
    });

    await notifyAgents([convener], {
      type: 'MEETING_INITIATED',
      meeting_id: meeting.id,
      meeting_type: type,
      title,
      agenda: agenda || null,
      message: `New ${type} meeting initiated: "${title}". You are the convener.`,
    });

    res.status(201).json(meeting);
  } catch (e) { next(e); }
});

adminRouter.get('/meetings/:id/action-items', requireAdminToken(), async (req, res, next) => {
  try {
    const items = await db.listActionItems(req.params.id);
    res.json({ data: items });
  } catch (e) { next(e); }
});

adminRouter.post('/meetings/:id/action-items', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const { title, owner_agent } = req.body;
    if (!title) return res.status(400).json(err('MISSING_FIELDS', 'title is required'));
    const meeting = await db.getMeetingById(req.params.id);
    if (!meeting) return res.status(404).json(err('NOT_FOUND', 'Meeting not found'));
    const item = await db.createActionItem({ meeting_id: req.params.id, title, owner_agent });
    res.status(201).json(item);
  } catch (e) { next(e); }
});

adminRouter.patch('/meetings/:id/action-items/:aid', requireAdminToken(['gm']), async (req, res, next) => {
  try {
    const allowed = ['status', 'owner_agent'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const item = await db.patchActionItem(req.params.aid, updates);
    if (!item) return res.status(404).json(err('NOT_FOUND', 'Action item not found'));
    res.json(item);
  } catch (e) { next(e); }
});

// ── agents (webhook receiver) ─────────────────────────────────────────────────
// Inbound notification endpoint for the internal agent communication bus.
// Called exclusively by notifyAgents() in services/agents.js via X-CS-Internal.
// Creates a DB task record on every received notification so agents can poll
// if they miss the live signal. Mounting: /agents (no /api prefix).
const agentsRouter = express.Router();

function requireInternal(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return res.status(503).json(err('NOT_CONFIGURED', 'Internal notification endpoint not configured'));
  if (req.headers['x-cs-internal'] !== secret) return res.status(401).json(err('UNAUTHORIZED', 'Internal authentication required'));
  next();
}

agentsRouter.post('/:name/notify', requireInternal, async (req, res, next) => {
  try {
    const agentName = Object.keys(AGENT_PERMISSIONS).find(k => k.toLowerCase() === req.params.name.toLowerCase());
    if (!agentName) return res.status(404).json(err('UNKNOWN_AGENT', `Agent ${req.params.name} not found in fleet`));

    const { type, content_id, record_id, task_id } = req.body;
    if (!type) return res.status(400).json(err('MISSING_TYPE', 'Notification type is required'));

    const resolvedContentId = content_id || record_id || task_id || '00000000-0000-0000-0000-000000000000';

    await db.createTask({
      agent_name: agentName,
      task_type: 'notification',
      content_type: 'system',
      content_id: resolvedContentId,
      sla_deadline: null,
    });

    await db.logAuditEvent({
      actor: 'system',
      action: 'agent_notification',
      target_agent: agentName,
      reason: type,
      affected_content_id: resolvedContentId !== '00000000-0000-0000-0000-000000000000' ? resolvedContentId : null,
    });

    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'AGENT_NOTIFIED', agent: agentName, type }));

    res.json({ received: true, agent: agentName, type });
  } catch (e) { next(e); }
});

module.exports = { contentRouter, usersRouter, tasksRouter, trainingRouter, revenueRouter, salesRouter, opsRouter, socialRouter, adminRouter, agentsRouter };
