'use strict';

// ── content.js ────────────────────────────────────────────────────────────────
const express = require('express');
const contentRouter = express.Router();
const db = require('../db/queries');
const { requireUserToken, requireAdminToken, gateContent, TIER_RANK, err } = require('../middleware/auth');

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

module.exports = { contentRouter, usersRouter, tasksRouter, trainingRouter, revenueRouter, salesRouter, opsRouter, socialRouter, adminRouter };
