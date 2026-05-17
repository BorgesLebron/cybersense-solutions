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
const grantAdminRole = (user_id, role, granted_by) =>
  q1(`INSERT INTO admin_roles (id,user_id,role,dashboard_sections,granted_by,granted_at)
      VALUES (gen_random_uuid(),$1,$2,'[]',$3,now())
      ON CONFLICT (user_id) DO UPDATE SET role=$2, granted_by=$3, granted_at=now()
      RETURNING *`,
    [user_id, role, granted_by]);
const deleteBriefingById = (id) => q('DELETE FROM briefings WHERE id=$1', [id]);

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

const getIntelRadarItems = ({ type, limit = 50 } = {}) => {
  const params = [];
  const conds = [];
  if (type) {
    params.push(type);
    conds.push(`i.type=$${params.length}`);
  } else {
    conds.push(`i.type IN ('innovation', 'growth')`);
  }
  params.push(limit);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return q(`SELECT i.id, i.type, i.category, i.headline, i.summary, i.tags, i.priority,
                   i.ingested_at,
                   EXISTS (
                     SELECT 1
                     FROM briefings b
                     WHERE i.id = ANY(b.innovation_item_ids)
                        OR i.id = b.growth_item_id
                   ) AS used_in_briefing,
                   CASE WHEN i.article_id IS NOT NULL THEN true ELSE false END AS has_article,
                   r.id AS repository_id, r.ready_for_intel, r.ready_for_awareness, r.processed_at
            FROM intel_items i
            LEFT JOIN intel_repository r ON r.source_id = i.id
            ${where}
            ORDER BY i.ingested_at DESC
            LIMIT $${params.length}`, params);
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
  const excludeUsed = pipeline === 'awareness'
    ? `AND NOT EXISTS (
         SELECT 1
         FROM briefings b
         WHERE r.source_id = ANY(b.threat_item_ids)
            OR r.source_id = ANY(b.innovation_item_ids)
            OR r.source_id = b.growth_item_id
       )`
    : '';
  if (pipeline === 'awareness') {
    return q(`WITH ranked AS (
              SELECT r.*,
                     CASE r.source_type
                       WHEN 'growth' THEN 1
                       WHEN 'innovation' THEN 2
                       WHEN 'threat' THEN 3
                       ELSE 4
                     END AS source_type_rank,
                     row_number() OVER (PARTITION BY r.source_type ORDER BY r.processed_at ASC) AS type_row,
                     CASE r.source_type WHEN 'threat' THEN t.threat_name WHEN 'innovation' THEN i.headline ELSE i.headline END AS title
              FROM intel_repository r
              LEFT JOIN threat_records t ON t.id=r.source_id AND r.source_type='threat'
              LEFT JOIN intel_items i ON i.id=r.source_id AND r.source_type IN ('innovation','growth','policy')
              WHERE r.${col}=true ${excludeUsed}
            )
            SELECT *
            FROM ranked
            WHERE type_row <= $1
            ORDER BY source_type_rank, processed_at ASC`, [limit]);
  }
  return q(`SELECT r.*,
              CASE r.source_type WHEN 'threat' THEN t.threat_name WHEN 'innovation' THEN i.headline ELSE i.headline END AS title
            FROM intel_repository r
            LEFT JOIN threat_records t ON t.id=r.source_id AND r.source_type='threat'
            LEFT JOIN intel_items i ON i.id=r.source_id AND r.source_type IN ('innovation','growth','policy')
            WHERE r.${col}=true ${excludeUsed} ORDER BY r.processed_at ASC LIMIT $1`, [limit]);
};

const getRepositorySummary = () =>
  q(`WITH base AS (
       SELECT r.id, r.source_type, r.source_id, r.ready_for_intel, r.ready_for_awareness,
              r.processed_at, i.article_id AS intel_article_id, t.article_id AS threat_article_id,
              EXISTS (
                SELECT 1
                FROM briefings b
                WHERE r.source_id = ANY(b.threat_item_ids)
                   OR r.source_id = ANY(b.innovation_item_ids)
                   OR r.source_id = b.growth_item_id
              ) AS used_in_briefing
       FROM intel_repository r
       LEFT JOIN intel_items i ON i.id = r.source_id AND r.source_type IN ('innovation','growth','policy')
       LEFT JOIN threat_records t ON t.id = r.source_id AND r.source_type = 'threat'
     )
     SELECT source_type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ready_for_intel)::int AS ready_for_intel,
            COUNT(*) FILTER (WHERE ready_for_awareness)::int AS ready_for_awareness,
            COUNT(*) FILTER (WHERE used_in_briefing)::int AS used_in_briefing,
            COUNT(*) FILTER (WHERE COALESCE(intel_article_id, threat_article_id) IS NOT NULL)::int AS article_linked,
            COUNT(*) FILTER (
              WHERE ready_for_intel
                AND COALESCE(intel_article_id, threat_article_id) IS NULL
            )::int AS ready_for_article,
            COUNT(*) FILTER (
              WHERE ready_for_awareness
                AND NOT used_in_briefing
            )::int AS ready_for_newsletter,
            MIN(processed_at) AS oldest_processed_at,
            MAX(processed_at) AS newest_processed_at
      FROM base
      GROUP BY source_type
      ORDER BY source_type`);

const listApprovedBriefingPreviews = () =>
  q(`SELECT b.id, b.edition_number, b.edition_date, b.subject_line, b.file_path,
            b.maya_approved_at, b.pipeline_status,
            EXISTS (
              SELECT 1 FROM pipeline_events pe
              WHERE pe.content_type = 'briefing'
                AND pe.content_id = b.id
                AND pe.notes LIKE 'Distribution authorized for 0430 CT%'
            ) AS authorized_for_distribution,
            COALESCE(jsonb_agg(item.data ORDER BY item.sort_order) FILTER (WHERE item.data IS NOT NULL), '[]'::jsonb) AS items
     FROM briefings b
     LEFT JOIN LATERAL (
       SELECT x.ord AS sort_order,
              jsonb_build_object(
                'type', 'threat',
                'source_type', 'threat',
                'source_id', x.id,
                'label', 'Threat Item ' || x.ord || ' / 3',
                'title', COALESCE(t.threat_name, r.normalized_data->>'title', 'Threat Item'),
                'source', COALESCE(t.source_url, r.normalized_data->>'source_url', 'Threat records'),
                'repository_id', r.id
              ) AS data
       FROM unnest(b.threat_item_ids) WITH ORDINALITY AS x(id, ord)
       LEFT JOIN threat_records t ON t.id = x.id
       LEFT JOIN intel_repository r ON r.source_id = x.id

       UNION ALL

       SELECT 10 + x.ord AS sort_order,
              jsonb_build_object(
                'type', 'innovation',
                'source_type', 'innovation',
                'source_id', x.id,
                'label', 'Innovation Item ' || x.ord || ' / 2',
                'title', COALESCE(i.headline, r.normalized_data->>'title', 'Innovation Item'),
                'source', COALESCE(i.category, r.normalized_data->>'category', 'Innovation intelligence'),
                'repository_id', r.id
              ) AS data
       FROM unnest(b.innovation_item_ids) WITH ORDINALITY AS x(id, ord)
       LEFT JOIN intel_items i ON i.id = x.id
       LEFT JOIN intel_repository r ON r.source_id = x.id

       UNION ALL

       SELECT 20 AS sort_order,
              jsonb_build_object(
                'type', 'growth',
                'source_type', 'growth',
                'source_id', b.growth_item_id,
                'label', 'Growth Item 1 / 1',
                'title', COALESCE(i.headline, r.normalized_data->>'title', 'Growth Item'),
                'source', COALESCE(i.category, r.normalized_data->>'category', 'Growth intelligence'),
                'repository_id', r.id
              ) AS data
       FROM intel_items i
       LEFT JOIN intel_repository r ON r.source_id = i.id
       WHERE i.id = b.growth_item_id

       UNION ALL

       SELECT 30 AS sort_order,
              jsonb_build_object(
                'type', 'training',
                'source_type', 'training',
                'source_id', b.training_byte_id,
                'label', 'Training Byte',
                'title', COALESCE(tm.title, 'Training Byte'),
                'source', 'Training modules',
                'repository_id', null
              ) AS data
       FROM training_modules tm
       WHERE tm.id = b.training_byte_id
     ) item ON true
     WHERE b.pipeline_status = 'approved'
     GROUP BY b.id
     ORDER BY b.edition_date DESC`);

const getRepositoryItemDetail = (id) =>
  q1(`SELECT r.id AS repository_id, r.source_type, r.source_id, r.normalized_data,
             r.correlation_tags, r.ready_for_intel, r.ready_for_awareness,
             r.processed_by, r.processed_at,
             CASE r.source_type WHEN 'threat' THEN t.threat_name ELSE i.headline END AS title,
             CASE r.source_type WHEN 'threat' THEN t.source_url ELSE i.category END AS source,
             CASE r.source_type WHEN 'threat' THEN t.category ELSE i.category END AS category,
             CASE r.source_type WHEN 'threat' THEN t.severity ELSE NULL END AS severity,
             CASE r.source_type WHEN 'threat' THEN t.cvss_score ELSE NULL END AS cvss_score,
             CASE r.source_type WHEN 'threat' THEN t.raw_data ELSE NULL END AS raw_threat_data,
             CASE r.source_type WHEN 'threat' THEN NULL ELSE i.summary END AS item_summary,
             CASE r.source_type WHEN 'threat' THEN t.tags ELSE i.tags END AS tags,
             CASE r.source_type WHEN 'threat' THEN t.priority::text ELSE i.priority::text END AS priority
      FROM intel_repository r
      LEFT JOIN threat_records t ON t.id = r.source_id AND r.source_type = 'threat'
      LEFT JOIN intel_items i ON i.id = r.source_id AND r.source_type IN ('innovation','growth','policy')
      WHERE r.source_id = $1 OR r.id = $1
      LIMIT 1`, [id]);

const getApprovedContentReferences = (id, limit = 8) =>
  q(`WITH current_item AS (
       SELECT r.id AS repository_id, r.source_type, r.source_id,
              COALESCE(
                CASE r.source_type WHEN 'threat' THEN t.category ELSE i.category END,
                r.normalized_data->>'category',
                r.source_type::text
              ) AS category
       FROM intel_repository r
       LEFT JOIN threat_records t ON t.id = r.source_id AND r.source_type = 'threat'
       LEFT JOIN intel_items i ON i.id = r.source_id AND r.source_type IN ('innovation','growth','policy')
       WHERE r.source_id = $1 OR r.id = $1
       LIMIT 1
     ),
     article_refs AS (
       SELECT 'article' AS content_type, a.id, a.title,
              a.pipeline_status::text AS status,
              COALESCE(a.published_at, a.maya_approved_at, a.created_at) AS content_date,
              a.section::text AS category,
              a.slug AS path
       FROM articles a, current_item c
       WHERE a.pipeline_status IN ('approved','published')
         AND (
           a.section::text = CASE WHEN c.source_type = 'threat' THEN 'threat' ELSE c.source_type::text END
           OR lower(a.title) LIKE '%' || lower(c.category) || '%'
           OR lower(a.body_md) LIKE '%' || lower(c.category) || '%'
         )
       ORDER BY COALESCE(a.published_at, a.maya_approved_at, a.created_at) DESC
       LIMIT $2
     ),
     briefing_refs AS (
       SELECT 'briefing' AS content_type, b.id, b.subject_line AS title,
              b.pipeline_status::text AS status,
              COALESCE(b.published_at, b.maya_approved_at, b.edition_date::timestamptz) AS content_date,
              'briefing' AS category,
              b.file_path AS path
       FROM briefings b, current_item c
       WHERE b.pipeline_status IN ('approved','published')
         AND (
           c.source_id = ANY(b.threat_item_ids)
           OR c.source_id = ANY(b.innovation_item_ids)
           OR c.source_id = b.growth_item_id
           OR lower(b.subject_line) LIKE '%' || lower(c.category) || '%'
           OR lower(b.body_md) LIKE '%' || lower(c.category) || '%'
         )
       ORDER BY COALESCE(b.published_at, b.maya_approved_at, b.edition_date::timestamptz) DESC
       LIMIT $2
     )
     SELECT * FROM (
       SELECT * FROM article_refs
       UNION ALL
       SELECT * FROM briefing_refs
     ) refs
     ORDER BY content_date DESC
     LIMIT $2`, [id, limit]);

// ── ARTICLES ───────────────────────────────────────────────────────────────────

const createArticle = async ({ title, section, body_md, access_tier, source_ids, created_by }) => {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
  const article = await q1(`INSERT INTO articles (id,title,slug,section,body_md,access_tier,pipeline_status,view_count,read_time_min,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'draft',0,
              GREATEST(1, ROUND(array_length(regexp_split_to_array(trim($4),E'\\\\s+'),1)/200.0)),now()) RETURNING *`,
    [title, slug, section, body_md, access_tier]);

  const ids = Array.isArray(source_ids) ? source_ids.filter(Boolean) : [];
  if (ids.length) {
    await q('UPDATE threat_records SET article_id=$1 WHERE id = ANY($2::uuid[])', [article.id, ids]);
    await q('UPDATE intel_items SET article_id=$1 WHERE id = ANY($2::uuid[])', [article.id, ids]);
  }

  return article;
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

const listArticlesForPreview = () =>
  q(`SELECT id, section AS type, title, slug, body_md, access_tier, read_time_min,
            pipeline_status::text AS stage,
            CASE pipeline_status::text
              WHEN 'draft' THEN 'James'
              WHEN 'dev_edit' THEN 'Jason'
              WHEN 'eic_review' THEN 'Rob'
              WHEN 'qa' THEN 'Jeff'
              WHEN 'maya' THEN 'Maya'
              WHEN 'approved' THEN 'Maya'
              ELSE 'Editorial'
            END AS agent,
            CASE pipeline_status::text
              WHEN 'draft' THEN 'In Progress'
              WHEN 'dev_edit' THEN 'Development Edit'
              WHEN 'eic_review' THEN 'EIC Review'
              WHEN 'qa' THEN 'QA'
              WHEN 'maya' THEN 'Maya Review'
              WHEN 'approved' THEN 'Final HITL'
              ELSE pipeline_status::text
            END AS stage_label,
            LEFT(regexp_replace(body_md, E'[#*_>\\n\\r-]+', ' ', 'g'), 320) AS summary,
            TO_CHAR(GREATEST(maya_approved_at, published_at, created_at), 'YYYY-MM-DD') AS updated
     FROM articles WHERE pipeline_status::text != 'published'
     ORDER BY created_at DESC`);

const advanceArticleStatus = (id, to_status) =>
  q1(`UPDATE articles SET pipeline_status=$2,
        qa_passed_at = CASE WHEN $3='qa' AND qa_passed_at IS NULL THEN now() ELSE qa_passed_at END,
        maya_approved_at = CASE WHEN $4='approved' THEN now() ELSE maya_approved_at END,
        published_at = CASE WHEN $5='published' THEN now() ELSE published_at END
      WHERE id=$1 RETURNING *`, [id, to_status, to_status, to_status, to_status]);

const incrementArticleViews = (id) => q('UPDATE articles SET view_count=view_count+1 WHERE id=$1', [id]);

// ── BRIEFINGS ──────────────────────────────────────────────────────────────────

const createBriefing = ({ edition_date, edition_number, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id, file_path, description }) =>
  q1(`INSERT INTO briefings (id,edition_date,edition_number,subject_line,body_md,threat_item_ids,innovation_item_ids,growth_item_id,training_byte_id,file_path,description,pipeline_status,draft_completed_at,open_count,click_count)
      VALUES (gen_random_uuid(),$1,COALESCE($2, (SELECT COALESCE(MAX(edition_number), 0) + 1 FROM briefings)),$3,$4,$5,$6,$7,$8,$9,$10,'draft',now(),0,0) RETURNING *`,
    [edition_date, edition_number || null, subject_line, body_md, threat_item_ids, innovation_item_ids, growth_item_id, training_byte_id, file_path || null, description || null]);

const getBriefingByDate = (date) => q1('SELECT * FROM briefings WHERE edition_date=$1', [date]);
const getBriefingById = (id) => q1('SELECT * FROM briefings WHERE id=$1', [id]);

const listBriefings = ({ page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;
  return q(`SELECT id,edition_date,edition_number,subject_line,description,file_path,pipeline_status,published_at,open_count,click_count
            FROM briefings WHERE pipeline_status='published' AND edition_date <= CURRENT_DATE ORDER BY edition_date DESC LIMIT $1 OFFSET $2`, [limit, offset]);
};

const advanceBriefingStatus = (id, to_status) =>
  q1(`UPDATE briefings SET pipeline_status=$2,
        draft_completed_at   = CASE WHEN $3='dev_edit'  AND draft_completed_at  IS NULL THEN now() ELSE draft_completed_at  END,
        qa_passed_at         = CASE WHEN $3='qa'        AND qa_passed_at        IS NULL THEN now() ELSE qa_passed_at        END,
        maya_approved_at     = CASE WHEN $3='maya'      AND maya_approved_at    IS NULL THEN now() ELSE maya_approved_at    END,
        published_at         = CASE WHEN $3='published' AND published_at        IS NULL THEN now() ELSE published_at        END
      WHERE id=$1 RETURNING *`, [id, to_status, to_status]);

const revertBriefingForRevision = (id) =>
  q1(`UPDATE briefings SET pipeline_status='maya', maya_approved_at=NULL WHERE id=$1 RETURNING *`, [id]);

// ── PIPELINE EVENTS ────────────────────────────────────────────────────────────

const logPipelineEvent = ({ content_type, content_id, from_status, to_status, agent_name, notes }) =>
  q1(`INSERT INTO pipeline_events (id,content_type,content_id,from_status,to_status,agent_name,notes,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3::text,$4::text,$5,$6,now()) RETURNING *`,
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

const createTrainingModule = ({ title, type, phase, zt_module, access_tier, duration_min, content_url, body_md, created_by }) =>
  q1(`INSERT INTO training_modules (id,title,type,phase,zt_module,access_tier,duration_min,content_url,body_md,pipeline_status,created_by)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) RETURNING *`,
    [title, type, phase, zt_module, access_tier, duration_min, content_url, body_md, created_by]);

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
        qa_passed_at     = CASE WHEN $3='qa'        AND qa_passed_at     IS NULL THEN now() ELSE qa_passed_at     END,
        maya_approved_at = CASE WHEN $3='maya'      AND maya_approved_at IS NULL THEN now() ELSE maya_approved_at END,
        published_at     = CASE WHEN $3='published' AND published_at     IS NULL THEN now() ELSE published_at     END
      WHERE id=$1 RETURNING *`, [id, to_status, to_status]);

// ── TRAINING GLOSSARY ──────────────────────────────────────────────────────────

const listGlossaryTerms = ({ category, search, page = 1, limit = 100 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (category) { params.push(category); conds.push(`category=$${params.length}`); }
  if (search) { params.push(`%${search}%`); conds.push(`(term ILIKE $${params.length} OR definition ILIKE $${params.length})`); }
  params.push(limit, (page - 1) * limit);
  return q(`SELECT * FROM training_glossary WHERE ${conds.join(' AND ')} ORDER BY term ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
};

const getGlossaryTerm = (id_or_term) =>
  q1('SELECT * FROM training_glossary WHERE id=$1 OR term=$1', [id_or_term]);

const createGlossaryTerm = ({ term, definition, category }) =>
  q1('INSERT INTO training_glossary (id, term, definition, category) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *', [term, definition, category]);

const updateGlossaryTerm = (id, fields) => {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE training_glossary SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...Object.values(fields)]);
};

const deleteGlossaryTerm = (id) => q('DELETE FROM training_glossary WHERE id=$1', [id]);

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

const createTask = ({ agent_name, task_type, content_type, content_id, sla_deadline, retry_after }) =>
  q1(`INSERT INTO agent_tasks (id,agent_name,task_type,content_type,content_id,status,sla_deadline,retry_after,started_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'queued',$5,$6,now()) RETURNING *`,
    [agent_name, task_type, content_type, content_id, sla_deadline || null, retry_after || null]);

const updateTask = (id, { status, error_message }) =>
  q1(`UPDATE agent_tasks SET status=$2,
        completed_at = CASE WHEN $3 IN ('complete','failed') THEN now() ELSE completed_at END,
        latency_sec = CASE WHEN $4='complete' THEN EXTRACT(EPOCH FROM now()-started_at)::int ELSE latency_sec END,
        error_message = COALESCE($5, error_message)
      WHERE id=$1 RETURNING *`, [id, status, status, status, error_message || null]);

const bumpTaskRetry = (id, retry_count) => {
  const delay_min = 5 * Math.pow(2, retry_count); // 5m → 10m → 20m
  return q1(
    `UPDATE agent_tasks SET retry_count=$2, retry_after=now()+($3 || ' minutes')::interval WHERE id=$1 RETURNING *`,
    [id, retry_count + 1, delay_min]
  );
};

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

const getTaskById = (id) => q1('SELECT * FROM agent_tasks WHERE id=$1', [id]);

const createAgentMessage = ({
  thread_id, task_id, content_type = 'system', content_id,
  from_role, from_name, to_agent, message, metadata,
}) =>
  q1(`INSERT INTO agent_messages
        (id,thread_id,task_id,content_type,content_id,from_role,from_name,to_agent,message,metadata,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())
      RETURNING *`,
    [
      thread_id,
      task_id || null,
      content_type,
      content_id || null,
      from_role,
      from_name,
      to_agent || null,
      message,
      JSON.stringify(metadata || {}),
    ]);

const listAgentMessages = ({ thread_id, task_id, content_id, to_agent, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (thread_id) { params.push(thread_id); conds.push(`thread_id=$${params.length}`); }
  if (task_id) { params.push(task_id); conds.push(`task_id=$${params.length}`); }
  if (content_id) { params.push(content_id); conds.push(`content_id=$${params.length}`); }
  if (to_agent) { params.push(to_agent); conds.push(`to_agent=$${params.length}`); }
  params.push(Math.min(Math.max(+limit || 50, 1), 200));
  return q(`SELECT * FROM agent_messages
            WHERE ${conds.join(' AND ')}
            ORDER BY created_at ASC
            LIMIT $${params.length}`, params);
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

const listPipelineEvents = ({ content_type, content_id, agent_name, limit = 50 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (content_type) { params.push(content_type); conds.push(`pe.content_type=$${params.length}`); }
  if (content_id) { params.push(content_id); conds.push(`pe.content_id=$${params.length}`); }
  if (agent_name) { params.push(agent_name); conds.push(`pe.agent_name=$${params.length}`); }
  params.push(Math.min(Math.max(+limit || 50, 1), 200));
  return q(`SELECT pe.*,
              CASE pe.content_type
                WHEN 'article' THEN a.title
                WHEN 'briefing' THEN b.subject_line
                ELSE tm.title
              END AS content_title
            FROM pipeline_events pe
            LEFT JOIN articles a ON a.id=pe.content_id AND pe.content_type='article'
            LEFT JOIN briefings b ON b.id=pe.content_id AND pe.content_type='briefing'
            LEFT JOIN training_modules tm ON tm.id=pe.content_id AND pe.content_type='training'
            WHERE ${conds.join(' AND ')}
            ORDER BY pe.created_at DESC
            LIMIT $${params.length}`, params);
};

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
      (SELECT 'article' AS content_type, pipeline_status::text AS pipeline_status FROM articles WHERE pipeline_status::text != 'published'
       UNION ALL
       SELECT 'briefing', pipeline_status::text FROM briefings WHERE pipeline_status::text != 'published'
       UNION ALL
       SELECT 'training', pipeline_status::text FROM training_modules WHERE pipeline_status::text != 'published') x
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

// ── MEETINGS ──────────────────────────────────────────────────────────────────

const countActiveThreats = () =>
  q1("SELECT COUNT(*) AS count FROM threat_records");

const createMeeting = ({ title, type, convener, initiated_by, agenda, lead, decision_maker, records_agent }) =>
  q1(`INSERT INTO meetings (id,title,type,convener,initiated_by,agenda,lead,decision_maker,records_agent)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [title, type, convener, initiated_by, agenda || null, lead || null, decision_maker || null, records_agent || null]);

const listMeetings = ({ status, limit = 20 } = {}) => {
  const conds = ['1=1'];
  const params = [];
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  params.push(limit);
  return q(`SELECT * FROM meetings WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
};

const getMeetingById = (id) =>
  q1('SELECT * FROM meetings WHERE id=$1', [id]);

const updateMeetingBriefing = (id, department, data) =>
  q1(`UPDATE meetings SET briefings = jsonb_set(briefings, ARRAY[$2], $3::jsonb, true) WHERE id=$1 RETURNING *`,
    [id, department, JSON.stringify(data)]);

const createActionItem = ({ meeting_id, title, owner_agent, department, priority }) =>
  q1(`INSERT INTO meeting_action_items (id,meeting_id,title,owner_agent,department,priority)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING *`,
    [meeting_id, title, owner_agent || null, department || null, priority || 'medium']);

const listActionItems = (meeting_id) =>
  q('SELECT * FROM meeting_action_items WHERE meeting_id=$1 ORDER BY created_at ASC', [meeting_id]);

const patchActionItem = (id, fields) => {
  const allowed = ['status', 'owner_agent', 'resolved_at', 'department', 'priority'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (safe.status === 'resolved' && !safe.resolved_at) safe.resolved_at = new Date().toISOString();
  const sets = Object.keys(safe).map((k, i) => `${k}=$${i + 2}`).join(',');
  return q1(`UPDATE meeting_action_items SET ${sets} WHERE id=$1 RETURNING *`, [id, ...Object.values(safe)]);
};

module.exports = {
  pool,
  getUserById, getUserByEmail, createUser, updateUser, softDeleteUser,
  setEmailVerified, updateLastLogin, updateUserTier, listUsers, countUsers,
  getOrgById, createOrg, updateOrg, listOrgs,
  getAdminRole, grantAdminRole, deleteBriefingById,
  createSession, deleteSession, deleteSessionByToken,
  getAgentToken, rotateAgentToken,
  createThreatRecord, getThreatRecords, getThreatById, linkThreatToArticle,
  createIntelItem, getIntelItems, getIntelRadarItems,
  processIntoRepository, getRepositoryQueue, getRepositorySummary, listApprovedBriefingPreviews, getRepositoryItemDetail, getApprovedContentReferences,
  createArticle, getArticle, getArticleById, listArticles, listArticlesForPreview, advanceArticleStatus, incrementArticleViews,
  createBriefing, getBriefingByDate, getBriefingById, listBriefings, advanceBriefingStatus, revertBriefingForRevision,
  logPipelineEvent, countRejections, countAgentRejections24h, listPipelineEvents,
  createSocialPost, updateSocialMetrics, listSocialPosts, getSocialPerformance,
  createTrainingModule, listTrainingModules, getTrainingModule, advanceModuleStatus,
  recordCompletion, getUserCompletions, getOrgCompletions, getOrgCompletionSummary,
  createSimulation, recordSimulationResult, getOrgSimulations, getSimulationResults,
  createSubscription, getSubscriptionByStripeId, updateSubscription,
  listSubscriptions, getMRRSummary, logStripeEvent,
  createLead, updateLead, listLeads,
  createPartner, listPartners,
  createTask, updateTask, bumpTaskRetry, listTasks, getTaskById,
  createAgentMessage, listAgentMessages,
  getSLABreaches, logHandoffSLA,
  createRisk, updateRisk, listRisks,
  getLatestSnapshot, getLiveMetricsDelta, getPipelineStatus, getActivityFeed,
  getAgentHealthSummary, logAuditEvent, getAuditLog,
  createEscalation,
  countActiveThreats,
  createMeeting, listMeetings, getMeetingById, updateMeetingBriefing,
  createActionItem, listActionItems, patchActionItem,
};
