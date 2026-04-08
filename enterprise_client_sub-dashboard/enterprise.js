'use strict';

// routes/enterprise.js
// Enterprise org admin dashboard — separate from CyberSense internal admin.
// Accessible to: (a) CyberSense admin tokens with gm/training role,
//                (b) org-level admins (users with is_org_admin=true scoped to their own org).

const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { requireUserToken, requireAdminToken, TIER_RANK, err } = require('../middleware/auth');

// Middleware: allows either a CyberSense admin OR the org's own admin user
function requireOrgAccess(paramKey = 'org_id') {
  return async (req, res, next) => {
    const org_id = req.params[paramKey];

    // Path 1: CyberSense internal admin
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        if (payload.type === 'admin') {
          const adminRole = await db.getAdminRole(payload.user_id);
          if (adminRole && ['gm', 'training', 'analyst'].includes(adminRole.role)) {
            req.org_id = org_id;
            req.actor_type = 'cs_admin';
            return next();
          }
        }
        // Path 2: Enterprise org admin user
        if (payload.type === 'user') {
          const user = await db.getUserById(payload.user_id);
          if (user && user.org_id === org_id && user.is_org_admin && TIER_RANK[user.tier] >= TIER_RANK['enterprise']) {
            req.user = user;
            req.org_id = org_id;
            req.actor_type = 'org_admin';
            return next();
          }
        }
      } catch (e) { /* fall through to 403 */ }
    }

    return res.status(403).json(err('FORBIDDEN', 'Enterprise dashboard access requires org admin or CyberSense admin credentials'));
  };
}

// ── GET /api/enterprise/:org_id/overview ──────────────────────────────────────
// Command center for the enterprise org — seats, completion rate, risk posture
router.get('/:org_id/overview', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;
    const [org, summary, simSummary, riskItems] = await Promise.all([
      db.getOrgById(org_id),
      db.getOrgCompletionSummary(org_id),
      db.pool.query(`
        SELECT type,
          COUNT(*)                                          AS campaigns,
          SUM(target_count)                                 AS total_targets,
          SUM(reported_count)                               AS total_reported,
          SUM(clicked_count)                                AS total_clicked,
          ROUND(SUM(reported_count)::DECIMAL / NULLIF(SUM(target_count),0) * 100, 1) AS report_rate,
          ROUND(SUM(clicked_count)::DECIMAL  / NULLIF(SUM(target_count),0) * 100, 1) AS click_rate
        FROM simulations WHERE org_id=$1 GROUP BY type`, [org_id]).then(r => r.rows),
      db.pool.query(`
        SELECT title, severity, status, due_date FROM risk_register
        WHERE owner_agent=$1 AND status != 'resolved'
        ORDER BY score DESC LIMIT 5`, [org_id]).then(r => r.rows),
    ]);

    if (!org) return res.status(404).json(err('NOT_FOUND', 'Organization not found'));

    const totalModules = await db.pool.query(
      "SELECT COUNT(*) FROM training_modules WHERE pipeline_status='published' AND access_tier='enterprise'"
    ).then(r => +r.rows[0].count);

    const overallCompletion = summary.reduce((acc, d) => {
      acc.completed += +d.completed;
      acc.total_assigned += +d.total_assigned;
      return acc;
    }, { completed: 0, total_assigned: 0 });

    res.json({
      org: {
        id: org.id, name: org.name, seat_count: org.seat_count,
        seat_used: org.seat_used, renewal_date: org.renewal_date, health_score: org.health_score,
      },
      training: {
        total_modules_available: totalModules,
        completion_rate: overallCompletion.total_assigned > 0
          ? Math.round(overallCompletion.completed / overallCompletion.total_assigned * 100)
          : 0,
        completed: overallCompletion.completed,
        total_assigned: overallCompletion.total_assigned,
        by_department: summary,
      },
      simulations: simSummary,
      risk_items: riskItems,
      generated_at: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/employees ─────────────────────────────────────
// Per-employee completion table — the by-name report
router.get('/:org_id/employees', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;
    const { department, module_id, status, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;

    const conds = ['u.org_id=$1', 'u.deleted_at IS NULL'];
    const params = [org_id];

    if (department) { params.push(department); conds.push(`u.department=$${params.length}`); }

    const employees = await db.pool.query(`
      SELECT
        u.id, u.full_name, u.email, u.department, u.last_login_at,
        COUNT(tc.id)                                        AS modules_assigned,
        COUNT(tc.id) FILTER (WHERE tc.status='completed')   AS modules_completed,
        ROUND(AVG(tc.score) FILTER (WHERE tc.score IS NOT NULL), 1) AS avg_score,
        MAX(tc.completed_at)                                AS last_activity,
        ROUND(COUNT(tc.id) FILTER (WHERE tc.status='completed')::DECIMAL /
          NULLIF(COUNT(tc.id), 0) * 100, 0)                AS completion_pct
      FROM users u
      LEFT JOIN training_completions tc ON tc.user_id=u.id AND tc.org_id=$1
      WHERE ${conds.join(' AND ')}
      GROUP BY u.id, u.full_name, u.email, u.department, u.last_login_at
      ORDER BY u.department, u.full_name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, +limit, +offset]).then(r => r.rows);

    const total = await db.pool.query(
      `SELECT COUNT(*) FROM users WHERE org_id=$1 AND deleted_at IS NULL ${department ? 'AND department=$2' : ''}`,
      department ? [org_id, department] : [org_id]).then(r => +r.rows[0].count);

    res.json({
      data: employees,
      meta: { page: +page, limit: +limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/employees/:user_id ────────────────────────────
// Individual employee detail — all module completions + simulation results
router.get('/:org_id/employees/:user_id', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id, user_id } = req.params;

    const user = await db.getUserById(user_id);
    if (!user || user.org_id !== org_id) return res.status(404).json(err('NOT_FOUND', 'Employee not found in this organization'));

    const [completions, simResults] = await Promise.all([
      db.pool.query(`
        SELECT tc.*, tm.title, tm.type, tm.phase, tm.zt_module, tm.duration_min
        FROM training_completions tc
        JOIN training_modules tm ON tm.id=tc.module_id
        WHERE tc.user_id=$1 AND tc.org_id=$2
        ORDER BY tm.phase, tm.zt_module, tc.completed_at`, [user_id, org_id]).then(r => r.rows),
      db.pool.query(`
        SELECT sr.outcome, sr.response_time_sec, sr.created_at,
               s.type AS simulation_type, s.campaign_name, s.launched_at
        FROM simulation_results sr
        JOIN simulations s ON s.id=sr.simulation_id
        WHERE sr.user_id=$1 AND s.org_id=$2
        ORDER BY sr.created_at DESC`, [user_id, org_id]).then(r => r.rows),
    ]);

    const { password_hash, ...safeUser } = user;
    res.json({
      employee: safeUser,
      training: {
        completions,
        summary: {
          total: completions.length,
          completed: completions.filter(c => c.status === 'completed').length,
          avg_score: completions.filter(c => c.score != null).reduce((s, c, _, a) => s + c.score / a.length, 0).toFixed(1),
        },
      },
      simulations: {
        results: simResults,
        summary: {
          total: simResults.length,
          reported: simResults.filter(r => r.outcome === 'reported').length,
          clicked: simResults.filter(r => r.outcome === 'clicked').length,
          ignored: simResults.filter(r => r.outcome === 'ignored').length,
        },
      },
    });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/departments ───────────────────────────────────
// Department-level rollup — completion and simulation performance by group
router.get('/:org_id/departments', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;

    const deptStats = await db.pool.query(`
      SELECT
        COALESCE(u.department, 'Unassigned')                AS department,
        COUNT(DISTINCT u.id)                                AS employee_count,
        COUNT(tc.id)                                        AS modules_assigned,
        COUNT(tc.id) FILTER (WHERE tc.status='completed')   AS modules_completed,
        ROUND(COUNT(tc.id) FILTER (WHERE tc.status='completed')::DECIMAL /
          NULLIF(COUNT(tc.id),0) * 100, 1)                  AS completion_rate,
        ROUND(AVG(tc.score) FILTER (WHERE tc.score IS NOT NULL), 1) AS avg_score
      FROM users u
      LEFT JOIN training_completions tc ON tc.user_id=u.id AND tc.org_id=$1
      WHERE u.org_id=$1 AND u.deleted_at IS NULL
      GROUP BY COALESCE(u.department, 'Unassigned')
      ORDER BY completion_rate DESC NULLS LAST`, [org_id]).then(r => r.rows);

    const simByDept = await db.pool.query(`
      SELECT
        COALESCE(sr.department, 'Unassigned')               AS department,
        COUNT(*)                                            AS total_simulations,
        COUNT(*) FILTER (WHERE sr.outcome='reported')       AS reported,
        COUNT(*) FILTER (WHERE sr.outcome='clicked')        AS clicked,
        ROUND(COUNT(*) FILTER (WHERE sr.outcome='reported')::DECIMAL / NULLIF(COUNT(*),0) * 100, 1) AS report_rate
      FROM simulation_results sr
      JOIN simulations s ON s.id=sr.simulation_id
      WHERE s.org_id=$1
      GROUP BY COALESCE(sr.department, 'Unassigned')
      ORDER BY report_rate DESC NULLS LAST`, [org_id]).then(r => r.rows);

    // Merge
    const merged = deptStats.map(d => ({
      ...d,
      simulation: simByDept.find(s => s.department === d.department) || null,
    }));

    res.json({ data: merged });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/modules ───────────────────────────────────────
// Module-level completion heatmap across the org
router.get('/:org_id/modules', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;

    const moduleStats = await db.pool.query(`
      SELECT
        tm.id, tm.title, tm.type, tm.phase, tm.zt_module, tm.duration_min,
        COUNT(tc.id)                                        AS assigned_count,
        COUNT(tc.id) FILTER (WHERE tc.status='completed')   AS completed_count,
        ROUND(COUNT(tc.id) FILTER (WHERE tc.status='completed')::DECIMAL /
          NULLIF(COUNT(tc.id),0) * 100, 1)                  AS completion_rate,
        ROUND(AVG(tc.score) FILTER (WHERE tc.score IS NOT NULL), 1) AS avg_score,
        ROUND(AVG(tc.time_spent_min) FILTER (WHERE tc.time_spent_min IS NOT NULL), 0) AS avg_time_min
      FROM training_modules tm
      LEFT JOIN training_completions tc ON tc.module_id=tm.id AND tc.org_id=$1
      WHERE tm.pipeline_status='published' AND tm.access_tier='enterprise'
      GROUP BY tm.id, tm.title, tm.type, tm.phase, tm.zt_module, tm.duration_min
      ORDER BY tm.phase, tm.zt_module, tm.title`, [org_id]).then(r => r.rows);

    res.json({ data: moduleStats });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/simulations ───────────────────────────────────
// All simulation campaigns for an org with per-result breakdown
router.get('/:org_id/simulations', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;
    const { type } = req.query;

    const whereType = type ? 'AND s.type=$2' : '';
    const params = type ? [org_id, type] : [org_id];

    const campaigns = await db.pool.query(`
      SELECT s.*,
        ROUND(s.reported_count::DECIMAL / NULLIF(s.target_count,0) * 100, 1) AS report_rate,
        ROUND(s.clicked_count::DECIMAL  / NULLIF(s.target_count,0) * 100, 1) AS click_rate,
        ROUND((s.target_count - s.reported_count - s.clicked_count)::DECIMAL /
          NULLIF(s.target_count,0) * 100, 1)                                  AS ignore_rate
      FROM simulations s
      WHERE s.org_id=$1 ${whereType}
      ORDER BY s.launched_at DESC`, params).then(r => r.rows);

    res.json({ data: campaigns });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/simulations/:sim_id/results ──────────────────
// Per-employee results for a specific campaign
router.get('/:org_id/simulations/:sim_id/results', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id, sim_id } = req.params;
    const { department } = req.query;

    const sim = await db.pool.query('SELECT * FROM simulations WHERE id=$1 AND org_id=$2', [sim_id, org_id]).then(r => r.rows[0]);
    if (!sim) return res.status(404).json(err('NOT_FOUND', 'Simulation not found for this organization'));

    const whereDept = department ? 'AND sr.department=$3' : '';
    const params = department ? [sim_id, org_id, department] : [sim_id, org_id];

    const results = await db.pool.query(`
      SELECT sr.outcome, sr.response_time_sec, sr.department, sr.created_at,
             u.full_name, u.email
      FROM simulation_results sr
      JOIN users u ON u.id=sr.user_id
      WHERE sr.simulation_id=$1 AND u.org_id=$2 ${whereDept}
      ORDER BY sr.department, u.full_name`, params).then(r => r.rows);

    const byDept = results.reduce((acc, r) => {
      const dept = r.department || 'Unassigned';
      if (!acc[dept]) acc[dept] = { reported: 0, clicked: 0, ignored: 0, total: 0 };
      acc[dept][r.outcome]++;
      acc[dept].total++;
      return acc;
    }, {});

    res.json({ simulation: sim, results, by_department: byDept });
  } catch (e) { next(e); }
});

// ── GET /api/enterprise/:org_id/compliance-report ────────────────────────────
// Exportable compliance summary — designed to meet client SLA reporting needs
router.get('/:org_id/compliance-report', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;
    const { from_date, to_date } = req.query;

    const org = await db.getOrgById(org_id);
    if (!org) return res.status(404).json(err('NOT_FOUND', 'Organization not found'));

    const dateFilter = from_date && to_date
      ? `AND tc.completed_at BETWEEN '${from_date}' AND '${to_date}'`
      : '';

    const [employeeSummary, moduleSummary, simSummary] = await Promise.all([
      db.pool.query(`
        SELECT
          u.full_name, u.email, u.department,
          COUNT(tc.id) FILTER (WHERE tc.status='completed')   AS modules_completed,
          COUNT(tc.id)                                        AS modules_assigned,
          ROUND(AVG(tc.score) FILTER (WHERE tc.score IS NOT NULL), 1) AS avg_score,
          MAX(tc.completed_at)                                AS last_completed,
          CASE
            WHEN COUNT(tc.id) = 0 THEN 'not_started'
            WHEN COUNT(tc.id) FILTER (WHERE tc.status='completed') = COUNT(tc.id) THEN 'complete'
            ELSE 'in_progress'
          END                                                 AS overall_status
        FROM users u
        LEFT JOIN training_completions tc ON tc.user_id=u.id AND tc.org_id=$1 ${dateFilter}
        WHERE u.org_id=$1 AND u.deleted_at IS NULL
        GROUP BY u.full_name, u.email, u.department
        ORDER BY u.department, u.full_name`, [org_id]).then(r => r.rows),

      db.pool.query(`
        SELECT tm.title, tm.zt_module, tm.phase,
          COUNT(tc.id)                                        AS assigned,
          COUNT(tc.id) FILTER (WHERE tc.status='completed')   AS completed,
          ROUND(COUNT(tc.id) FILTER (WHERE tc.status='completed')::DECIMAL /
            NULLIF(COUNT(tc.id),0) * 100, 1)                  AS completion_rate
        FROM training_modules tm
        LEFT JOIN training_completions tc ON tc.module_id=tm.id AND tc.org_id=$1 ${dateFilter}
        WHERE tm.access_tier='enterprise' AND tm.pipeline_status='published'
        GROUP BY tm.id, tm.title, tm.zt_module, tm.phase
        ORDER BY tm.phase, tm.zt_module`, [org_id]).then(r => r.rows),

      db.pool.query(`
        SELECT type, COUNT(*) AS campaigns,
          SUM(target_count) AS targets,
          SUM(reported_count) AS reported,
          SUM(clicked_count) AS clicked,
          ROUND(SUM(reported_count)::DECIMAL / NULLIF(SUM(target_count),0) * 100, 1) AS report_rate
        FROM simulations
        WHERE org_id=$1 ${from_date ? `AND launched_at >= '${from_date}'` : ''}
        GROUP BY type`, [org_id]).then(r => r.rows),
    ]);

    const overallRate = employeeSummary.length > 0
      ? Math.round(employeeSummary.filter(e => e.overall_status === 'complete').length / employeeSummary.length * 100)
      : 0;

    res.json({
      report: {
        org_name: org.name,
        generated_at: new Date().toISOString(),
        period: { from: from_date || 'inception', to: to_date || new Date().toISOString().split('T')[0] },
        headline: {
          total_employees: employeeSummary.length,
          fully_complete: employeeSummary.filter(e => e.overall_status === 'complete').length,
          in_progress: employeeSummary.filter(e => e.overall_status === 'in_progress').length,
          not_started: employeeSummary.filter(e => e.overall_status === 'not_started').length,
          overall_completion_rate: overallRate,
        },
        by_employee: employeeSummary,
        by_module: moduleSummary,
        simulations: simSummary,
      },
    });
  } catch (e) { next(e); }
});

// ── POST /api/enterprise/:org_id/assign-modules ───────────────────────────────
// Assign a set of training modules to all or specific employees in an org
router.post('/:org_id/assign-modules', requireOrgAccess(), async (req, res, next) => {
  try {
    const { org_id } = req;
    const { module_ids, user_ids, department } = req.body;

    if (!module_ids || !Array.isArray(module_ids) || module_ids.length === 0)
      return res.status(400).json(err('MISSING_FIELDS', 'module_ids array is required'));

    // Determine target employees
    let targetUsers;
    if (user_ids && Array.isArray(user_ids) && user_ids.length > 0) {
      targetUsers = await db.pool.query(
        'SELECT id, department FROM users WHERE id=ANY($1) AND org_id=$2 AND deleted_at IS NULL',
        [user_ids, org_id]).then(r => r.rows);
    } else if (department) {
      targetUsers = await db.pool.query(
        'SELECT id, department FROM users WHERE org_id=$1 AND department=$2 AND deleted_at IS NULL',
        [org_id, department]).then(r => r.rows);
    } else {
      targetUsers = await db.pool.query(
        'SELECT id, department FROM users WHERE org_id=$1 AND deleted_at IS NULL',
        [org_id]).then(r => r.rows);
    }

    if (targetUsers.length === 0) return res.status(404).json(err('NO_EMPLOYEES', 'No employees found matching criteria'));

    // Validate modules exist and are enterprise-tier
    const modules = await db.pool.query(
      "SELECT id FROM training_modules WHERE id=ANY($1) AND pipeline_status='published' AND access_tier='enterprise'",
      [module_ids]).then(r => r.rows);

    if (modules.length !== module_ids.length)
      return res.status(400).json(err('INVALID_MODULES', 'One or more module_ids are invalid or not available for enterprise tier'));

    // Bulk insert — ON CONFLICT DO NOTHING skips already-assigned
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const user of targetUsers) {
      for (const mod of modules) {
        placeholders.push(`(gen_random_uuid(),$${i},$${i+1},$${i+2},$${i+3},'not_started',now())`);
        values.push(user.id, mod.id, org_id, user.department || null);
        i += 4;
      }
    }

    const result = await db.pool.query(
      `INSERT INTO training_completions (id,user_id,module_id,org_id,department,status,assigned_at)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (user_id, module_id) DO NOTHING`,
      values);

    res.json({
      assigned: true,
      employees_targeted: targetUsers.length,
      modules_assigned: modules.length,
      records_created: result.rowCount,
    });
  } catch (e) { next(e); }
});

module.exports = router;
