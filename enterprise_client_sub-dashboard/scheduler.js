'use strict';

// services/scheduler.js
// Scheduled jobs: nightly dashboard snapshot, awareness pipeline health check,
// SLA breach monitoring, and daily financial summary trigger.
// In production: run via node-cron, pg_cron, or AWS EventBridge.

const db = require('../db/queries');
const { checkAwarenessPipelineHealth, notifyAgents } = require('./agents');

// ── Nightly dashboard snapshot (runs at 00:05 CT) ─────────────────────────────
async function runNightlySnapshot() {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'nightly_snapshot', status: 'start' }));
  try {
    const live = await db.getLiveMetricsDelta();
    const mrr = await db.getMRRSummary();
    const totalMRR = mrr.reduce((s, r) => s + parseInt(r.mrr_cents), 0);

    const recentSubs = await db.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE cancelled_at > now() - interval '30 days')  AS churned,
        COUNT(*) FILTER (WHERE created_at < now() - interval '30 days' AND status='active') AS base
      FROM subscriptions`).then(r => r.rows[0]);

    const churnRate = recentSubs.base > 0
      ? parseFloat((recentSubs.churned / recentSubs.base * 100).toFixed(2))
      : 0;

    const emailStats = await db.pool.query(`
      SELECT ROUND(AVG(
        CASE WHEN b.open_count > 0 THEN b.open_count::DECIMAL / NULLIF(b.click_count,0) ELSE 0 END
      )::DECIMAL, 2) AS avg_open_rate
      FROM briefings b WHERE b.published_at > now() - interval '30 days'`).then(r => r.rows[0]);

    await db.pool.query(`
      INSERT INTO dashboard_snapshots
        (snapshot_date, total_subscribers, paid_accounts, enterprise_accounts,
         mrr_cents, churn_rate, articles_published, briefings_published,
         avg_open_rate, open_risk_count, agent_tasks_completed)
      VALUES (CURRENT_DATE,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (snapshot_date) DO UPDATE SET
        total_subscribers=$1, paid_accounts=$2, enterprise_accounts=$3,
        mrr_cents=$4, churn_rate=$5, articles_published=$6, briefings_published=$7,
        avg_open_rate=$8, open_risk_count=$9, agent_tasks_completed=$10`,
      [
        live.total_subscribers, live.paid_accounts, live.enterprise_accounts,
        totalMRR, churnRate,
        live.articles_published, live.briefings_published,
        emailStats.avg_open_rate || 0, live.open_risk_count, live.agent_tasks_completed,
      ]);

    // Refresh materialized view
    await db.pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_current');

    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'nightly_snapshot', status: 'complete', mrr_cents: totalMRR }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'nightly_snapshot', status: 'error', error: e.message }));
    await notifyAgents(['Henry', 'Barret'], { type: 'SCHEDULER_ERROR', job: 'nightly_snapshot', error: e.message });
  }
}

// ── Awareness pipeline health check (runs every 15 min, 05:00–09:30 CT) ──────
async function runAwarenessPipelineCheck() {
  const now = new Date();
  const hour = now.getUTCHours() - 5; // rough CT offset (adjust for DST)
  if (hour < 5 || hour > 9) return;

  try {
    const health = await checkAwarenessPipelineHealth();
    console.log(JSON.stringify({ ts: now.toISOString(), job: 'awareness_health_check', ...health }));

    if (health.status === 'missing' && hour >= 5) {
      await notifyAgents(['Barret', 'Henry', 'Ruth'], {
        type: 'AWARENESS_PIPELINE_MISSING',
        date: health.date,
        current_hour_ct: hour,
        message: `No briefing draft found for ${health.date}. Pipeline may be stalled.`,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: now.toISOString(), job: 'awareness_health_check', error: e.message }));
  }
}

// ── SLA breach sweep (runs every 5 min) ───────────────────────────────────────
async function runSLABreachSweep() {
  try {
    const breaches = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE sla_deadline IS NOT NULL
        AND sla_deadline < now()
        AND status NOT IN ('complete','failed','escalated')
        AND completed_at IS NULL`).then(r => r.rows);

    for (const task of breaches) {
      const delta_min = Math.round((Date.now() - new Date(task.sla_deadline)) / 60000);

      await db.pool.query(
        'UPDATE agent_tasks SET status=$1 WHERE id=$2',
        ['escalated', task.id]);

      await db.logHandoffSLA({
        from_agent: task.agent_name,
        to_agent: 'system',
        content_id: task.content_id,
        expected_at: task.sla_deadline,
        actual_at: new Date().toISOString(),
      });

      await notifyAgents(['Barret'], {
        type: 'SLA_BREACH_DETECTED',
        task_id: task.id,
        agent_name: task.agent_name,
        content_type: task.content_type,
        content_id: task.content_id,
        delta_min,
        sla_deadline: task.sla_deadline,
      });

      if (delta_min > 30 || task.content_type === 'briefing') {
        await notifyAgents(['Henry'], {
          type: 'SLA_BREACH_CRITICAL',
          task_id: task.id,
          agent_name: task.agent_name,
          delta_min,
        });
      }
    }

    if (breaches.length > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'sla_breach_sweep', breaches_found: breaches.length }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'sla_breach_sweep', error: e.message }));
  }
}

// ── Expired session cleanup (runs nightly at 01:00 CT) ────────────────────────
async function runSessionCleanup() {
  try {
    const result = await db.pool.query('DELETE FROM sessions WHERE expires_at < now()');
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'session_cleanup', deleted: result.rowCount }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'session_cleanup', error: e.message }));
  }
}

// ── Daily financial summary trigger (runs at 07:00 CT) ────────────────────────
async function triggerDailyFinancialSummary() {
  try {
    const mrr = await db.getMRRSummary();
    const totalMRR = mrr.reduce((s, r) => s + parseInt(r.mrr_cents), 0);

    const recentActivations = await db.pool.query(`
      SELECT COUNT(*) FROM subscriptions
      WHERE created_at > now() - interval '24 hours' AND status='active'`).then(r => +r.rows[0].count);

    const recentChurn = await db.pool.query(`
      SELECT COUNT(*) FROM subscriptions
      WHERE cancelled_at > now() - interval '24 hours'`).then(r => +r.rows[0].count);

    await notifyAgents(['Jim'], {
      type: 'DAILY_FINANCIAL_TRIGGER',
      mrr_cents: totalMRR,
      new_activations_24h: recentActivations,
      churn_24h: recentChurn,
      by_tier: mrr,
    });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'financial_summary', error: e.message }));
  }
}

// ── Scheduler bootstrap (node-cron) ──────────────────────────────────────────
function startScheduler() {
  try {
    const cron = require('node-cron');
    cron.schedule('5 0 * * *',   runNightlySnapshot,          { timezone: 'America/Chicago' });
    cron.schedule('1 0 * * *',   runSessionCleanup,           { timezone: 'America/Chicago' });
    cron.schedule('*/15 5-9 * * *', runAwarenessPipelineCheck,{ timezone: 'America/Chicago' });
    cron.schedule('*/5 * * * *', runSLABreachSweep);
    cron.schedule('0 7 * * *',   triggerDailyFinancialSummary,{ timezone: 'America/Chicago' });
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'SCHEDULER_STARTED', jobs: 5 }));
  } catch (e) {
    console.warn('node-cron not installed — scheduler disabled. Install with: npm install node-cron');
  }
}

module.exports = {
  startScheduler,
  runNightlySnapshot,
  runAwarenessPipelineCheck,
  runSLABreachSweep,
  runSessionCleanup,
  triggerDailyFinancialSummary,
};
