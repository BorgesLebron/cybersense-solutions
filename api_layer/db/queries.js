'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
});

const q = (text, params) => pool.query(text, params).then(r => r.rows);
const q1 = (text, params) => pool.query(text, params).then(r => r.rows[0] || null);

// ── USERS ─────────────────────────────────────────────────────────────────────

const getUserById = (id) => q1('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);
const getUserByEmail = (email) => q1('SELECT * FROM users WHERE email=lower($1) AND deleted_at IS NULL', [email]);

const createUser = ({ email, password_hash, full_name }) =>
  q1(`INSERT INTO users (id,email,password_hash,full_name,tier,email_verified,email_subscribed,created_at)
      VALUES (gen_random_uuid(),lower($1),$2,$3,'free',false,true,now()) RETURNING *`,
    [email, password_hash, full_name]);

const updateUser = (id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE users SET ${sets} WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [id, ...Object.values(fields)]);
};

const softDeleteUser = (id) => q1('UPDATE users SET deleted_at=now() WHERE id=$1 RETURNING id', [id]);

const setEmailVerified = (id) =>
  q1("UPDATE users SET email_verified=true, tier='freemium' WHERE id=$1 RETURNING *", [id]);

const updateLastLogin = (id) => q('UPDATE users SET last_login_at=now() WHERE id=$1', [id]);

const updateUserTier = (id, tier) =>
  q1('UPDATE users SET tier=$2 WHERE id=$1 RETURNING *', [id, tier]);

const listUsers = ({ page = 1, limit = 50, tier } = {}) => {
  const offset = (page - 1) * limit;
  const where = tier ? 'AND tier=$3' : '';
  const params = tier ? [limit, offset, tier] : [limit, offset];
  return q(`SELECT id,email,full_name,tier,org_id,email_verified,email_subscribed,last_login_at,created_at
            FROM users WHERE deleted_at IS NULL ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params);
};

const countUsers = (tier) => {
  const where = tier ? 'AND tier=$1' : '';
  return q1(`SELECT COUNT(*) FROM users WHERE deleted_at IS NULL ${where}`, tier ? [tier] : []);
};

// ── ORGANIZATIONS ──────────────────────────────────────────────────────────────

const getOrgById = (id) => q1('SELECT * FROM organizations WHERE id=$1', [id]);

const createOrg = ({ name, domain, seat_count, billing_contact_id, account_manager_id }) =>
  q1(`INSERT INTO organizations (id,name,domain,seat_count,seat_used,billing_contact_id,account_manager_id,health_score,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,0,$4,$5,100,now()) RETURNING *`,
    [name, domain, seat_count, billing_contact_id, account_manager_id]);

const updateOrg = (id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE organizations SET ${sets} WHERE id=$1 RETURNING *`, [id, ...Object.values(fields)]);
};

const listOrgs = ({ page = 1, limit = 50 } = {}) => {
  const offset = (page - 1) * limit;
  return q(`SELECT o.*, u.email AS billing_email,
              (SELECT COUNT(*) FROM users WHERE org_id=o.id AND deleted_at IS NULL) AS actual_seat_used
            FROM organizations o
            LEFT JOIN users u ON u.id=o.billing_contact_id
            ORDER BY o.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
};

// ── ADMIN ROLES ────────────────────────────────────────────────────────────────

const getAdminRole = (user_id) => q1('SELECT * FROM admin_roles WHERE user_id=$1', [user_id]);

// ── SESSIONS ───────────────────────────────────────────────────────────────────

const createSession = ({ user_id, token_hash, ip_address, user_agent, expires_at }) =>
  q1(`INSERT INTO sessions (id,user_id,token_hash,ip_address,user_agent,expires_at,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now()) RETURNING *`,
    [user_id, token_hash, ip_address, user_agent, expires_at]);

const deleteSession = (user_id) => q('DELETE FROM sessions WHERE user_id=$1', [user_id]);
const deleteSessionByToken = (token_hash) => q('DELETE FROM sessions WHERE token_hash=$1', [token_hash]);

// ── AGENT TOKENS ───────────────────────────────────────────────────────────────

const getAgentToken = (agent_name) => q1('SELECT * FROM agent_tokens WHERE agent_name=$1 AND active=true', [agent_name]);

const rotateAgentToken = (agent_name, token_hash) =>
  q1(`UPDATE agent_tokens SET token_hash=$2, rotated_at=now() WHERE agent_name=$1 RETURNING agent_name, rotated_at`,
    [agent_name, token_hash]);

// ── THREAT RECORDS ─────────────────────────────────────────────────────────────

const createThreatRecord = ({ cve_id, threat_name, severity, cvss_score, category, source_url, raw_data, tags, priority, ingested_by }) =>
  q1(`INSERT INTO threat_records (id,cve_id,threat_name,severity,cvss_score,category,source_url,raw_data,tags,priority,ingested_by,ingested_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING *`,
    [cve_id, threat_name, severity, cvss_score, category, source_url, JSON.stringify(raw_data), tags, priority, ingested_by]);

const getThreatRecords = ({ page = 1, limit = 50, severity, blurAfter = 7 } = {}) => {
  const offset = (page - 1) * limit;
  const where = severity ? 'WHERE severity=$3' : '';
  const params = severity ? [limit, offset, severity] : [limit, offset];
  return q(`SELECT id,threat_name,cve_id,severity,cvss_score,category,tags,priority,ingested_at,article_id,
              CASE WHEN article_id IS NOT NULL THEN true ELSE false END AS has_article
            FROM threat_records ${where} ORDER BY ingested_at DESC LIMIT $1 OFFSET $2`, params);
};

const getThreatById = (id) => q1('SELECT * FROM threat_records WHERE id=$1', [id]);

const linkThreatToArticle = (threat_id, article_id) =>
  q1('UPDATE threat_records SET article_id=$2 WHERE id=$1 RETURNING id', [threat_id, article_id]);

// ── INTEL ITEMS ────────────────────────────────────────────────────────────────

const createIntelItem = ({ type, category, headline, summary, tags, priority, ingested_by }) =>
  q1(`INSERT INTO intel_items (id,type,category,headline,summary,tags,priority,ingested_by,ingested_at,used_in_briefing)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,now(),false) RETURNING *`,
    [type, category, headline, summary, tags, priority, ingested_by]);

const getIntelItems = ({ type, ready_for_awareness, limit = 20, since } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (type) { params.push(type); conds.push(`type=$${params.length}`); }
  if (ready_for_awareness) conds.push('used_in_briefing=false');
  if (since) { params.push(since); conds.push(`ingested_at>$${params.length}`); }
  params.push(limit);
  return q(`SELECT * FROM intel_items WHERE ${conds.join(' AND ')} ORDER BY priority DESC, ingested_at DESC LIMIT $${params.length}`, params);
};

// ── INTEL REPOSITORY ───────────────────────────────────────────────────────────

const processIntoRepository = ({ source_type, source_id, normalized_data, correlation_tags, processed_by, ready_for_intel, ready_for_awareness }) =>
  q1(`INSERT INTO intel_repository (id,source_type,source_id,normalized_data,correlation_tags,ready_for_intel,ready_for_awareness,processed_by,processed_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (source_id) DO UPDATE SET normalized_data=$3,correlation_tags=$4,ready_for_intel=$5,ready_for_awareness=$6,processed_by=$7,processed_at=now()
      RETURNING *`,
    [source_type, source_id, JSON.stringify(normalized_data), correlation_tags, ready_for_intel, ready_for_awareness, processed_by]);

const getRepositoryQueue = ({ pipeline, limit = 30 } = {}) => {
  const col = pipeline === 'awareness' ? 'ready_for_awareness' : 'ready_for_intel';
  return q(`SELECT r.*, 
              CASE r.source_type WHEN 'threat' THEN t.threat_name WHEN 'innovation' THEN i.headline ELSE i.headline END AS title
            FROM intel_repository r
            LEFT JOIN threat_records t ON t.id=r.source_id AND r.source_type='threat'
            LEFT JOIN intel_items i ON i.id=r.source_id AND r.source_type IN ('innovation','growth','policy')
            WHERE r.${col}=true ORDER BY r.processed_at ASC LIMIT $1`, [limit]);
};

// ── ARTICLES ───────────────────────────────────────────────────────────────────

const createArticle = ({ title, section, body_md, access_tier, source_ids, created_by }) => {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
  return q1(`INSERT INTO articles (id,title,slug,section,body_md,access_tier,pipeline_status,view_count,read_time_min,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'draft',0,
              GREATEST(1, ROUND(array_length(regexp_split_to_array(trim($4),E'\\\\s+'),1)/200.0)),now()) RETURNING *`,
    [title, slug, section, body_md, access_tier]);
};

const getArticle = (slug) => q1('SELECT * FROM articles WHERE slug=$1', [slug]);
const getArticleById = (id) => q1('SELECT * FROM articles WHERE id=$1', [id]);

const listArticles = ({ section, access_tier, status = 'published', page = 1, limit = 20 } = {}) => {
  const conds = [`pipeline_status=$1`];
  const params = [status];
  if (section) { params.push(section); conds.push(`section=$${params.length}`); }
  if (access_tier) { params.push(access_tier); conds.push(`access_tier=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT id,title,slug,section,access_tier,pipeline_status,published_at,view_count,read_time_min
            FROM articles WHERE ${conds.join(' AND ')} ORDER BY published_at DESC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const advanceArticleStatus = (id, to_status) =>
  q1(`UPDATE articles SET pipeline_status=$2,
        qa_passed_at = CASE WHEN $2::text='maya' THEN now() ELSE qa_passed_at END,
        maya_approved_at = CASE WHEN $2::text='approved' THEN now() ELSE maya_approved_at END,
        published_at = CASE WHEN $2::text='published' THEN now() ELSE published_at END
      WHERE id=$1 RETURNING *`, [id, to_status]);

const incrementArticleViews = (id) => q('UPDATE articles SET view_count=view_count+1 WHERE id=$1', [id]);

// ── BRIEFINGS ──────────────────────────────────────────────────────────────────

const createBriefing = ({ edition_date, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id }) =>
  q1(`INSERT INTO briefings (id,edition_date,subject_line,body_md,threat_item_ids,innovation_item_ids,growth_item_id,training_byte_id,pipeline_status,draft_completed_at,open_count,click_count)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'draft',now(),0,0) RETURNING *`,
    [edition_date, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id]);

const getBriefingByDate = (date) => q1('SELECT * FROM briefings WHERE edition_date=$1', [date]);
const getBriefingById = (id) => q1('SELECT * FROM briefings WHERE id=$1', [id]);

const listBriefings = ({ page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;
  return q(`SELECT id,edition_date,subject_line,pipeline_status,published_at,open_count,click_count
            FROM briefings WHERE pipeline_status='published' ORDER BY edition_date DESC LIMIT $1 OFFSET $2`, [limit, offset]);
};

const advanceBriefingStatus = (id, to_status) =>
  q1(`UPDATE briefings SET pipeline_status=$2,
        draft_completed_at = CASE WHEN $2::text='dev_edit' AND draft_completed_at IS NULL THEN now() ELSE draft_completed_at END,
        published_at = CASE WHEN $2::text='published' THEN now() ELSE published_at END
      WHERE id=$1 RETURNING *`, [id, to_status]);

// ── PIPELINE EVENTS ────────────────────────────────────────────────────────────

const logPipelineEvent = ({ content_type, content_id, from_status, to_status, agent_name, notes }) =>
  q1(`INSERT INTO pipeline_events (id,content_type,content_id,from_status,to_status,agent_name,notes,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,now()) RETURNING *`,
    [content_type, content_id, from_status, to_status, agent_name, notes || null]);

const countRejections = (agent_team, hours = 24) =>
  q1(`SELECT COUNT(*) FROM pipeline_events
      WHERE to_status='draft' AND created_at > now() - interval '${hours} hours'
      AND agent_name IN (SELECT agent_name FROM agent_tokens WHERE team=$1)`, [agent_team]);

// ── SOCIAL POSTS ───────────────────────────────────────────────────────────────

const createSocialPost = ({ briefing_id, platform, agent_name, post_body, phase, scheduled_at, published_at }) =>
  q1(`INSERT INTO social_posts (id,briefing_id,platform,agent_name,post_body,phase,scheduled_at,published_at,reach,engagements,conversions)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,0,0,0) RETURNING *`,
    [briefing_id, platform, agent_name, post_body, phase, scheduled_at || null, published_at || null]);

const updateSocialMetrics = (id, { reach, engagements, conversions }) =>
  q1('UPDATE social_posts SET reach=$2, engagements=$3, conversions=$4 WHERE id=$1 RETURNING *',
    [id, reach, engagements, conversions]);

const listSocialPosts = ({ platform, date, phase, page = 1, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (platform) { params.push(platform); conds.push(`platform=$${params.length}`); }
  if (phase) { params.push(phase); conds.push(`phase=$${params.length}`); }
  if (date) { params.push(date); conds.push(`DATE(published_at)=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT * FROM social_posts WHERE ${conds.join(' AND ')} ORDER BY published_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const getSocialPerformance = ({ platform, from_date, to_date } = {}) => {
  const conds = ['published_at IS NOT NULL'];
  const params = [];
  if (platform) { params.push(platform); conds.push(`platform=$${params.length}`); }
  if (from_date) { params.push(from_date); conds.push(`DATE(published_at)>=$${params.length}`); }
  if (to_date) { params.push(to_date); conds.push(`DATE(published_at)<=$${params.length}`); }
  return q(`SELECT platform, phase, COUNT(*) AS posts, SUM(reach) AS total_reach,
              SUM(engagements) AS total_engagements, SUM(conversions) AS total_conversions,
              ROUND(AVG(CASE WHEN reach>0 THEN engagements::float/reach*100 ELSE 0 END),2) AS avg_engagement_rate
            FROM social_posts WHERE ${conds.join(' AND ')} GROUP BY platform, phase ORDER BY platform, phase`, params);
};

// ── TRAINING MODULES ───────────────────────────────────────────────────────────

const createTrainingModule = ({ title, type, phase, zt_module, access_tier, duration_min, content_url, created_by }) =>
  q1(`INSERT INTO training_modules (id,title,type,phase,zt_module,access_tier,duration_min,content_url,pipeline_status,created_by)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING *`,
    [title, type, phase, zt_module, access_tier, duration_min, content_url, created_by]);

const listTrainingModules = ({ type, phase, zt_module, page = 1, limit = 30 } = {}) => {
  const conds = ["pipeline_status='published'"];
  const params = [];
  if (type) { params.push(type); conds.push(`type=$${params.length}`); }
  if (phase) { params.push(phase); conds.push(`phase=$${params.length}`); }
  if (zt_module) { params.push(zt_module); conds.push(`zt_module=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT id,title,type,phase,zt_module,access_tier,duration_min,published_at
            FROM training_modules WHERE ${conds.join(' AND ')} ORDER BY published_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const getTrainingModule = (id) => q1('SELECT * FROM training_modules WHERE id=$1', [id]);

const advanceModuleStatus = (id, to_status) =>
  q1(`UPDATE training_modules SET pipeline_status=$2,
        published_at = CASE WHEN $2::text='published' THEN now() ELSE published_at END
      WHERE id=$1 RETURNING *`, [id, to_status]);

// ── TRAINING COMPLETIONS ───────────────────────────────────────────────────────

const recordCompletion = ({ user_id, module_id, org_id, department, score, time_spent_min }) =>
  q1(`INSERT INTO training_completions (id,user_id,module_id,org_id,department,status,score,time_spent_min,completed_at,assigned_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'completed',$5,$6,now(),now())
      ON CONFLICT (user_id, module_id) DO UPDATE SET status='completed',score=$5,time_spent_min=$6,completed_at=now()
      RETURNING *`,
    [user_id, module_id, org_id, department, score, time_spent_min]);

const getUserCompletions = (user_id) =>
  q(`SELECT tc.*, tm.title, tm.type, tm.phase, tm.zt_module, tm.duration_min
     FROM training_completions tc JOIN training_modules tm ON tm.id=tc.module_id
     WHERE tc.user_id=$1 ORDER BY tc.completed_at DESC`, [user_id]);

const getOrgCompletions = (org_id, { department } = {}) => {
  const where = department ? 'AND tc.department=$2' : '';
  const params = department ? [org_id, department] : [org_id];
  return q(`SELECT tc.user_id, u.full_name, u.email, tc.department, tc.module_id, tm.title, tm.zt_module,
              tc.status, tc.score, tc.time_spent_min, tc.completed_at
            FROM training_completions tc
            JOIN users u ON u.id=tc.user_id
            JOIN training_modules tm ON tm.id=tc.module_id
            WHERE tc.org_id=$1 ${where} ORDER BY u.full_name, tm.zt_module`, params);
};

const getOrgCompletionSummary = (org_id) =>
  q(`SELECT department, COUNT(DISTINCT user_id) AS employees,
            COUNT(*) FILTER (WHERE status='completed') AS completed,
            COUNT(*) AS total_assigned,
            ROUND(AVG(score) FILTER (WHERE score IS NOT NULL),1) AS avg_score
     FROM training_completions WHERE org_id=$1 GROUP BY department ORDER BY department`, [org_id]);

// ── SIMULATIONS ────────────────────────────────────────────────────────────────

const createSimulation = ({ org_id, type, campaign_name, target_count }) =>
  q1(`INSERT INTO simulations (id,org_id,type,campaign_name,target_count,reported_count,clicked_count,launched_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,0,0,now()) RETURNING *`,
    [org_id, type, campaign_name, target_count]);

const recordSimulationResult = ({ simulation_id, user_id, outcome, response_time_sec, department }) =>
  q1(`INSERT INTO simulation_results (id,simulation_id,user_id,outcome,response_time_sec,department,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now()) RETURNING *`,
    [simulation_id, user_id, outcome, response_time_sec, department]);

const getOrgSimulations = (org_id) =>
  q(`SELECT s.*, 
       ROUND(s.reported_count::float/NULLIF(s.target_count,0)*100,1) AS report_rate,
       ROUND(s.clicked_count::float/NULLIF(s.target_count,0)*100,1) AS click_rate
     FROM simulations s WHERE s.org_id=$1 ORDER BY s.launched_at DESC`, [org_id]);

const getSimulationResults = (simulation_id) =>
  q(`SELECT sr.*, u.full_name, u.email
     FROM simulation_results sr JOIN users u ON u.id=sr.user_id
     WHERE sr.simulation_id=$1 ORDER BY u.full_name`, [simulation_id]);

// ── SUBSCRIPTIONS ──────────────────────────────────────────────────────────────

const createSubscription = ({ user_id, org_id, stripe_subscription_id, tier, mrr_cents, current_period_start, current_period_end }) =>
  q1(`INSERT INTO subscriptions (id,user_id,org_id,stripe_subscription_id,tier,status,mrr_cents,current_period_start,current_period_end)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'active',$5,$6,$7) RETURNING *`,
    [user_id, org_id, stripe_subscription_id, tier, mrr_cents, current_period_start, current_period_end]);

const getSubscriptionByStripeId = (stripe_subscription_id) =>
  q1('SELECT * FROM subscriptions WHERE stripe_subscription_id=$1', [stripe_subscription_id]);

const updateSubscription = (stripe_subscription_id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE subscriptions SET ${sets} WHERE stripe_subscription_id=$1 RETURNING *`,
    [stripe_subscription_id, ...Object.values(fields)]);
};

const listSubscriptions = ({ page = 1, limit = 50, tier, status } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (tier) { params.push(tier); conds.push(`tier=$${params.length}`); }
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT s.*, u.email, u.full_name FROM subscriptions s LEFT JOIN users u ON u.id=s.user_id
            WHERE ${conds.join(' AND ')} ORDER BY s.current_period_start DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const getMRRSummary = () =>
  q(`SELECT tier, COUNT(*) AS accounts, SUM(mrr_cents) AS mrr_cents
     FROM subscriptions WHERE status='active' GROUP BY tier ORDER BY mrr_cents DESC`);

const logStripeEvent = ({ stripe_event_id, event_type, subscription_id, amount_cents, payload }) =>
  q1(`INSERT INTO stripe_events (id,stripe_event_id,event_type,subscription_id,amount_cents,payload,processed_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now())
      ON CONFLICT (stripe_event_id) DO NOTHING RETURNING *`,
    [stripe_event_id, event_type, subscription_id, amount_cents, JSON.stringify(payload)]);

// ── LEADS ──────────────────────────────────────────────────────────────────────

const createLead = ({ email, full_name, company, source, target_tier, est_seats, est_value_cents, notes }) =>
  q1(`INSERT INTO leads (id,email,full_name,company,source,status,assigned_to,target_tier,est_seats,est_value_cents,notes,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'new','Mary',$5,$6,$7,$8,now()) RETURNING *`,
    [email, full_name, company, source, target_tier, est_seats, est_value_cents, notes]);

const updateLead = (id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE leads SET ${sets} WHERE id=$1 RETURNING *`, [id, ...Object.values(fields)]);
};

const listLeads = ({ status, assigned_to, page = 1, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  if (assigned_to) { params.push(assigned_to); conds.push(`assigned_to=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT * FROM leads WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

// ── PARTNERS ───────────────────────────────────────────────────────────────────

const createPartner = ({ name, type, status, monthly_value_cents, commission_pct, contract_start, contract_end, owner_agent }) =>
  q1(`INSERT INTO partners (id,name,type,status,monthly_value_cents,commission_pct,contract_start,contract_end,owner_agent)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, type, status || 'prospect', monthly_value_cents, commission_pct, contract_start, contract_end, owner_agent]);

const listPartners = () => q('SELECT * FROM partners ORDER BY monthly_value_cents DESC NULLS LAST');

// ── AGENT TASKS ────────────────────────────────────────────────────────────────

const createTask = ({ agent_name, task_type, content_type, content_id, sla_deadline }) =>
  q1(`INSERT INTO agent_tasks (id,agent_name,task_type,content_type,content_id,status,sla_deadline,started_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'queued',$5,now()) RETURNING *`,
    [agent_name, task_type, content_type, content_id, sla_deadline || null]);

const updateTask = (id, { status, error_message }) =>
  q1(`UPDATE agent_tasks SET status=$2,
        completed_at = CASE WHEN $2::text IN ('complete','failed') THEN now() ELSE completed_at END,
        latency_sec = CASE WHEN $2::text='complete' THEN EXTRACT(EPOCH FROM now()-started_at)::int ELSE latency_sec END,
        error_message = COALESCE($3, error_message)
      WHERE id=$1 RETURNING *`, [id, status, error_message || null]);

const listTasks = ({ agent_name, status, content_type, date, page = 1, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (agent_name) { params.push(agent_name); conds.push(`agent_name=$${params.length}`); }
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  if (content_type) { params.push(content_type); conds.push(`content_type=$${params.length}`); }
  if (date) { params.push(date); conds.push(`DATE(started_at)=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT * FROM agent_tasks WHERE ${conds.join(' AND ')} ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const getSLABreaches = () =>
  q(`SELECT at.*, h.breached, h.delta_sec, h.escalated_to
     FROM agent_tasks at
     LEFT JOIN handoff_sla_log h ON h.content_id=at.content_id
     WHERE at.sla_deadline IS NOT NULL AND at.completed_at > at.sla_deadline
     ORDER BY at.completed_at DESC LIMIT 100`);

const logHandoffSLA = ({ from_agent, to_agent, content_id, expected_at, actual_at }) => {
  const delta = `EXTRACT(EPOCH FROM $5::timestamptz - $4::timestamptz)::int`;
  return q1(`INSERT INTO handoff_sla_log (id,from_agent,to_agent,content_id,expected_at,actual_at,delta_sec,breached)
             VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,${delta},$5::timestamptz>$4::timestamptz) RETURNING *`,
    [from_agent, to_agent, content_id, expected_at, actual_at]);
};

const countAgentRejections24h = (pipeline_agents) =>
  q1(`SELECT COUNT(*) FROM pipeline_events
      WHERE to_status='draft' AND agent_name=ANY($1) AND created_at > now()-interval '24 hours'`,
    [pipeline_agents]);

// ── RISK REGISTER ──────────────────────────────────────────────────────────────

const createRisk = ({ domain, title, description, severity, score, owner_agent, raised_by, due_date }) =>
  q1(`INSERT INTO risk_register (id,domain,title,description,severity,score,status,owner_agent,raised_by,due_date,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'open',$6,$7,$8,now()) RETURNING *`,
    [domain, title, description, severity, score, owner_agent, raised_by, due_date]);

const updateRisk = (id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE risk_register SET ${sets} WHERE id=$1 RETURNING *`, [id, ...Object.values(fields)]);
};

const listRisks = ({ domain, severity, status = 'open' } = {}) => {
  const conds = ['status=$1'];
  const params = [status];
  if (domain) { params.push(domain); conds.push(`domain=$${params.length}`); }
  if (severity) { params.push(severity); conds.push(`severity=$${params.length}`); }
  return q(`SELECT * FROM risk_register WHERE ${conds.join(' AND ')} ORDER BY score DESC, due_date ASC`, params);
};

// ── DASHBOARD SNAPSHOTS ────────────────────────────────────────────────────────

const getLatestSnapshot = () =>
  q1('SELECT * FROM dashboard_snapshots ORDER BY snapshot_date DESC LIMIT 1');

const getLiveMetricsDelta = () =>
  q1(`SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_subscribers,
        (SELECT COUNT(*) FROM subscriptions WHERE status='active') AS paid_accounts,
        (SELECT COUNT(*) FROM subscriptions WHERE status='active' AND tier='enterprise') AS enterprise_accounts,
        (SELECT COALESCE(SUM(mrr_cents),0) FROM subscriptions WHERE status='active') AS mrr_cents,
        (SELECT COUNT(*) FROM risk_register WHERE status='open') AS open_risk_count,
        (SELECT COUNT(*) FROM agent_tasks WHERE DATE(started_at)=CURRENT_DATE) AS agent_tasks_today,
        (SELECT COUNT(*) FROM pipeline_events WHERE DATE(created_at)=CURRENT_DATE AND to_status='draft') AS rejections_today`);

const getPipelineStatus = () =>
  q(`SELECT content_type, pipeline_status, COUNT(*) FROM
      (SELECT 'article' AS content_type, pipeline_status FROM articles WHERE pipeline_status != 'published'
       UNION ALL
       SELECT 'briefing', pipeline_status FROM briefings WHERE pipeline_status != 'published'
       UNION ALL
       SELECT 'training', pipeline_status FROM training_modules WHERE pipeline_status != 'published') x
     GROUP BY content_type, pipeline_status ORDER BY content_type, pipeline_status`);

const getActivityFeed = (limit = 20) =>
  q(`SELECT pe.*, 
       CASE pe.content_type WHEN 'article' THEN a.title WHEN 'briefing' THEN b.subject_line ELSE tm.title END AS content_title
     FROM pipeline_events pe
     LEFT JOIN articles a ON a.id=pe.content_id AND pe.content_type='article'
     LEFT JOIN briefings b ON b.id=pe.content_id AND pe.content_type='briefing'
     LEFT JOIN training_modules tm ON tm.id=pe.content_id AND pe.content_type='training'
     ORDER BY pe.created_at DESC LIMIT $1`, [limit]);

const getAgentHealthSummary = () =>
  q(`SELECT agent_name,
       COUNT(*) FILTER (WHERE DATE(started_at)=CURRENT_DATE) AS tasks_today,
       COUNT(*) FILTER (WHERE status='complete' AND DATE(started_at)=CURRENT_DATE) AS completed_today,
       COUNT(*) FILTER (WHERE status='failed' AND DATE(started_at)=CURRENT_DATE) AS failed_today,
       COUNT(*) FILTER (WHERE status IN ('queued','in_progress')) AS active_queue,
       ROUND(AVG(latency_sec) FILTER (WHERE status='complete' AND DATE(started_at)=CURRENT_DATE)) AS avg_latency_sec
     FROM agent_tasks GROUP BY agent_name ORDER BY agent_name`);

const logAuditEvent = ({ actor, action, target_agent, reason, affected_content_id }) =>
  q1(`INSERT INTO audit_trail (id,actor,action,target_agent,reason,affected_content_id,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now()) RETURNING *`,
    [actor, action, target_agent, reason, affected_content_id]);

const getAuditLog = ({ agent, action_type, from_date, page = 1, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (agent) { params.push(agent); conds.push(`(actor=$${params.length} OR target_agent=$${params.length})`); }
  if (action_type) { params.push(action_type); conds.push(`action=$${params.length}`); }
  if (from_date) { params.push(from_date); conds.push(`DATE(created_at)>=$${params.length}`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT * FROM audit_trail WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

// ── ESCALATIONS ────────────────────────────────────────────────────────────────

const createEscalation = ({ from_agent, to_agent, reason, content_id, severity }) =>
  q1(`INSERT INTO escalations (id,from_agent,to_agent,reason,content_id,severity,status,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'open',now()) RETURNING *`,
    [from_agent, to_agent, reason, content_id, severity]);

module.exports = {
  pool,
  getUserById, getUserByEmail, createUser, updateUser, softDeleteUser,
  setEmailVerified, updateLastLogin, updateUserTier, listUsers, countUsers,
  getOrgById, createOrg, updateOrg, listOrgs,
  getAdminRole,
  createSession, deleteSession, deleteSessionByToken,
  getAgentToken, rotateAgentToken,
  createThreatRecord, getThreatRecords, getThreatById, linkThreatToArticle,
  createIntelItem, getIntelItems,
  processIntoRepository, getRepositoryQueue,
  createArticle, getArticle, getArticleById, listArticles, advanceArticleStatus, incrementArticleViews,
  createBriefing, getBriefingByDate, getBriefingById, listBriefings, advanceBriefingStatus,
  logPipelineEvent, countRejections, countAgentRejections24h,
  createSocialPost, updateSocialMetrics, listSocialPosts, getSocialPerformance,
  createTrainingModule, listTrainingModules, getTrainingModule, advanceModuleStatus,
  recordCompletion, getUserCompletions, getOrgCompletions, getOrgCompletionSummary,
  createSimulation, recordSimulationResult, getOrgSimulations, getSimulationResults,
  createSubscription, getSubscriptionByStripeId, updateSubscription,
  listSubscriptions, getMRRSummary, logStripeEvent,
  createLead, updateLead, listLeads,
  createPartner, listPartners,
  createTask, updateTask, listTasks, getSLABreaches, logHandoffSLA,
  createRisk, updateRisk, listRisks,
  getLatestSnapshot, getLiveMetricsDelta, getPipelineStatus, getActivityFeed,
  getAgentHealthSummary, logAuditEvent, getAuditLog,
  createEscalation,
};
