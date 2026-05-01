'use strict';

// services/scheduler.js
// Scheduled jobs: nightly dashboard snapshot, awareness pipeline health check,
// SLA breach monitoring, and daily financial summary trigger.
// In production: run via node-cron, pg_cron, or AWS EventBridge.

const db = require('../db/queries');
const { checkAwarenessPipelineHealth, notifyAgents } = require('./agents');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const OPS_ALERT_EMAIL = 'hjborges@gmail.com';

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
        AND sla_deadline < now() - INTERVAL '5 minutes'
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

// ── Red Team: 4-hour batch cycle trigger (R6 + IC4) ──────────────────────────
// Fires every 4 hours. Tells Rick to submit his queued threat records and
// Ivan/Charlie to deliver their Innovation + Growth batch to Barbara.
async function runRedTeamBatchCycle() {
  try {
    await notifyAgents(['Rick'], {
      type: 'BATCH_CYCLE_TRIGGER',
      pipeline: 'threat_acquisition',
      message: 'Submit queued threat records to Barbara (R6 — 4-hour batch cycle).',
    });
    await notifyAgents(['Ivan/Charlie'], {
      type: 'BATCH_CYCLE_TRIGGER',
      pipeline: 'intel_acquisition',
      message: 'Submit queued Innovation and Growth records to Barbara (IC4 — 4-hour batch cycle).',
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'red_team_batch_cycle', status: 'triggered' }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'red_team_batch_cycle', error: e.message }));
  }
}

// ── Ivan/Charlie → Ruth delivery reminder (IC3 — fires at 05:45 CT) ──────────
// Gives Ivan/Charlie 15 minutes to deliver their minimum daily package
// (2 Innovation + 1 Growth) directly to Ruth before her 0615 CT assembly deadline.
async function runIvanCharlieRuthReminder() {
  try {
    await notifyAgents(['Ivan/Charlie'], {
      type: 'RUTH_DELIVERY_REMINDER',
      deadline: '06:00 CT',
      minimum: '2 Innovation records + 1 Growth record',
      message: 'Deliver minimum daily Intelligence package to Ruth by 0600 CT (IC3).',
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'ivan_charlie_ruth_reminder', status: 'sent' }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'ivan_charlie_ruth_reminder', error: e.message }));
  }
}

// ── Ivan/Charlie Ruth delivery check (IC6 — fires at 06:05 CT) ───────────────
// Detects missed 0600 CT delivery to Ruth and escalates to Barret immediately.
// Checks for any intel items submitted by Ivan/Charlie since midnight CT.
async function runAcquisitionDeliveryCheck() {
  try {
    const result = await db.pool.query(`
      SELECT COUNT(*) AS delivered
      FROM intel_items
      WHERE ingested_by = 'Ivan/Charlie'
        AND created_at >= (CURRENT_DATE::TIMESTAMPTZ AT TIME ZONE 'America/Chicago')
    `).then(r => parseInt(r.rows[0].delivered));

    if (result === 0) {
      const ts = new Date().toISOString();
      console.warn(JSON.stringify({ ts, job: 'acquisition_delivery_check', status: 'MISSED', agent: 'Ivan/Charlie' }));
      await notifyAgents(['Barret'], {
        type: 'INTEL_DELIVERY_MISSED',
        agent: 'Ivan/Charlie',
        deadline: '06:00 CT',
        message: 'Ivan/Charlie has not delivered any intel items today. Ruth\'s 0615 CT assembly deadline is at risk. (IC6)',
      });
      await notifyAgents(['Henry'], {
        type: 'INTEL_DELIVERY_MISSED',
        agent: 'Ivan/Charlie',
        deadline: '06:00 CT',
        message: 'Ivan/Charlie delivery to Ruth missed 0600 CT deadline. Barret notified. (IC6)',
      });
      await sgMail.send({
        to: OPS_ALERT_EMAIL,
        from: { email: process.env.FROM_EMAIL || 'noreply@cybersense.solutions', name: 'CyberSense.Solutions' },
        subject: '[OPS ALERT] Ivan/Charlie missed 06:00 CT delivery to Ruth',
        text: `Acquisition delivery check fired at ${ts}.\n\nIvan/Charlie have not submitted any intel items today. Ruth's 0615 CT briefing assembly deadline is at risk.\n\nBarret and Henry have been notified via the agent fleet.\n\n— CyberSense Scheduler`,
      }).catch(e => console.error(JSON.stringify({ ts, job: 'acquisition_delivery_check', event: 'EMAIL_FAILED', error: e.message })));
    } else {
      console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'acquisition_delivery_check', status: 'ok', items_today: result }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'acquisition_delivery_check', error: e.message }));
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

// ── Task retry sweep (runs every 5 min alongside SLA sweep) ──────────────────
// Picks up queued notification tasks whose webhook delivery failed on first
// attempt. Retries with exponential backoff: 5m → 10m → 20m (max 3 attempts).
const MAX_RETRIES = 3;

async function runTaskRetryQueue() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE status = 'queued'
        AND retry_count > 0
        AND retry_count < $1
        AND retry_after IS NOT NULL
        AND retry_after < now()
    `, [MAX_RETRIES]).then(r => r.rows);

    for (const task of tasks) {
      try {
        const url = `${process.env.AGENT_WEBHOOK_BASE || 'http://localhost:4000/agents'}/${task.agent_name.toLowerCase()}/notify`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CS-Internal': process.env.INTERNAL_SECRET },
          body: JSON.stringify({ type: 'PENDING_TASK', task_id: task.id, task_type: task.task_type, content_type: task.content_type, content_id: task.content_id, ts: new Date().toISOString() }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          await db.updateTask(task.id, { status: 'complete' });
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (e) {
        if (task.retry_count + 1 >= MAX_RETRIES) {
          await db.updateTask(task.id, { status: 'failed', error_message: `Max retries reached: ${e.message}` });
          console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'task_retry_queue', task_id: task.id, agent: task.agent_name, status: 'EXHAUSTED' }));
        } else {
          await db.bumpTaskRetry(task.id, task.retry_count);
        }
      }
    }

    if (tasks.length > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'task_retry_queue', retried: tasks.length }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'task_retry_queue', error: e.message }));
  }
}

// ── Sales: lead qualification scan (S1 — runs daily at 09:00 CT) ─────────────
// Surfaces active free/freemium users who have been on the platform long enough
// to qualify for outreach. Mary receives a batched signal rather than one-per-user
// to avoid notification flood.
async function runLeadQualificationCheck() {
  try {
    const candidates = await db.pool.query(`
      SELECT id, email, full_name, tier, last_login_at, created_at
      FROM users
      WHERE tier IN ('free', 'freemium')
        AND email_verified = true
        AND deleted_at IS NULL
        AND last_login_at > now() - INTERVAL '7 days'
        AND created_at < now() - INTERVAL '14 days'
      ORDER BY last_login_at DESC
      LIMIT 50
    `).then(r => r.rows);

    if (candidates.length === 0) return;

    await notifyAgents(['Mary'], {
      type: 'ENGAGEMENT_SIGNAL',
      candidate_count: candidates.length,
      candidates: candidates.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, tier: u.tier, last_login_at: u.last_login_at })),
      message: `${candidates.length} active free/freemium users meet qualification threshold. Review for outreach. (S1)`,
    });

    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'lead_qualification_check', candidates: candidates.length }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'lead_qualification_check', error: e.message }));
  }
}

// ── Training: Kirby daily cycle initiation (T1 — fires at 05:00 CT) ──────────
async function runKirbyDailyCycle() {
  try {
    await notifyAgents(['Kirby'], {
      type: 'DAILY_CYCLE_TRIGGER',
      pipeline: 'training',
      deadline: '05:30 CT',
      message: 'Begin training byte production. Deliver to Ruth and Mario by 0530 CT (T1).',
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'kirby_daily_cycle', status: 'triggered' }));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'kirby_daily_cycle', error: e.message }));
  }
}

// ── Sales: renewal outreach (S7 — runs daily at 08:00 CT) ────────────────────
// Detects accounts with renewal_date landing in exactly 90, 60, or 30 days
// and notifies Joe to begin proactive outreach for each window.
async function runRenewalOutreach() {
  try {
    const accounts = await db.pool.query(`
      SELECT id, name, domain, health_score, renewal_date, seat_count, account_manager_id
      FROM organizations
      WHERE renewal_date IS NOT NULL
        AND renewal_date IN (
          CURRENT_DATE + INTERVAL '90 days',
          CURRENT_DATE + INTERVAL '60 days',
          CURRENT_DATE + INTERVAL '30 days'
        )
      ORDER BY renewal_date ASC
    `).then(r => r.rows);

    for (const account of accounts) {
      const days_until_renewal = Math.round((new Date(account.renewal_date) - new Date()) / 86400000);
      await notifyAgents(['Joe'], {
        type: 'RENEWAL_OUTREACH_TRIGGER',
        org_id: account.id,
        org_name: account.name,
        renewal_date: account.renewal_date,
        days_until_renewal,
        health_score: account.health_score,
        seat_count: account.seat_count,
        message: `${account.name} renewal is in ${days_until_renewal} days (${account.renewal_date}). Health score: ${account.health_score}. Begin outreach. (S7)`,
      });
    }

    if (accounts.length > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'renewal_outreach', accounts_flagged: accounts.length }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'renewal_outreach', error: e.message }));
  }
}

// ── Sales: account health score monitoring (S6 — runs daily at 08:30 CT) ─────
// Flags orgs below health threshold. Joe handles retention; Victor is looped in
// if score is critical (< 40) indicating potential churn or operational risk.
const HEALTH_WARN_THRESHOLD    = 70;
const HEALTH_CRITICAL_THRESHOLD = 40;

async function runAccountHealthCheck() {
  try {
    const accounts = await db.pool.query(`
      SELECT id, name, domain, health_score, renewal_date, seat_count, account_manager_id
      FROM organizations
      WHERE health_score < $1
      ORDER BY health_score ASC
    `, [HEALTH_WARN_THRESHOLD]).then(r => r.rows);

    for (const account of accounts) {
      const critical = account.health_score < HEALTH_CRITICAL_THRESHOLD;
      await notifyAgents(['Joe'], {
        type: 'ACCOUNT_HEALTH_ALERT',
        org_id: account.id,
        org_name: account.name,
        health_score: account.health_score,
        renewal_date: account.renewal_date,
        critical,
        message: `${account.name} health score is ${account.health_score}. ${critical ? 'CRITICAL — ' : ''}Proactive retention action required. (S6)`,
      });

      if (critical) {
        await notifyAgents(['Victor'], {
          type: 'ACCOUNT_HEALTH_CRITICAL',
          org_id: account.id,
          org_name: account.name,
          health_score: account.health_score,
          message: `${account.name} health score is ${account.health_score} — below critical threshold. Risk escalation may be needed. (S6)`,
        });
      }
    }

    if (accounts.length > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'account_health_check', accounts_flagged: accounts.length }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), job: 'account_health_check', error: e.message }));
  }
}

// ── Midnight content update (00:00 CT, Mon–Fri = Sun–Thu nights) ─────────────
// Confirms the current published edition before the 0430 CT Ruth kickoff.
// Failure escalates to Barret + Cy immediately with ops email — no 0700 CT
// delivery can happen without a confirmed current edition pointer.
async function runMidnightContentUpdate() {
  try {
    const edition = await db.pool.query(`
      SELECT id, edition_number, file_path, subject_line, edition_date, published_at
      FROM briefings
      WHERE pipeline_status = 'published'
      ORDER BY edition_date DESC
      LIMIT 1
    `).then(r => r.rows[0]);

    if (!edition) throw new Error('No published edition found in briefings table');

    await notifyAgents(['Nora'], {
      type: 'CURRENT_EDITION_CONFIRMED',
      edition_number: edition.edition_number,
      file_path: edition.file_path,
      subject_line: edition.subject_line,
      edition_date: edition.edition_date,
      published_at: edition.published_at,
      message: `Current edition confirmed: Edition ${edition.edition_number} — "${edition.subject_line}". File: ${edition.file_path}. Ready for 0700 CT delivery window.`,
    });

    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'midnight_content_update', status: 'complete', edition_number: edition.edition_number }));
  } catch (e) {
    const ts = new Date().toISOString();
    console.error(JSON.stringify({ ts, job: 'midnight_content_update', status: 'error', error: e.message }));
    await notifyAgents(['Barret', 'Cy'], {
      type: 'MIDNIGHT_UPDATE_FAILED',
      error: e.message,
      message: `Midnight content update failed. Current edition pointer not confirmed. Manual intervention required before 0430 CT.`,
    });
    await sgMail.send({
      to: OPS_ALERT_EMAIL,
      from: { email: process.env.FROM_EMAIL || 'noreply@cybersense.solutions', name: 'CyberSense.Solutions' },
      subject: '[OPS ALERT] Midnight content update job failed',
      text: `Midnight content update failed at ${ts}.\n\nError: ${e.message}\n\nBarret and Cy have been notified. Manual intervention required before 0430 CT.\n\n— CyberSense Scheduler`,
    }).catch(emailErr => console.error(JSON.stringify({ ts, job: 'midnight_content_update', event: 'EMAIL_FAILED', error: emailErr.message })));
  }
}

// ── LinkedIn token refresh (Sun 23:00 CT weekly) ──────────────────────────────
// Weekly proactive refresh keeps the token well within LinkedIn's 60-day
// expiry window. Runs Sunday night before the production week starts.
// Quinn notified on success (credential audit trail).
// Cy + Quinn notified on failure — expired token blocks Oliver's 0700 CT post.
async function runLinkedInTokenRefresh() {
  if (!process.env.LINKEDIN_REFRESH_TOKEN) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'linkedin_token_refresh', status: 'skipped', reason: 'LINKEDIN_REFRESH_TOKEN not provisioned' }));
    return;
  }
  try {
    const { refreshLinkedInToken } = require('./linkedin');
    const result = await refreshLinkedInToken();
    await notifyAgents(['Quinn'], {
      type: 'CREDENTIAL_REFRESHED',
      service: 'linkedin',
      expires_in: result.expires_in,
      message: `LinkedIn access token refreshed. Expires in ${result.expires_in}s. Update LINKEDIN_ACCESS_TOKEN in Railway env if persistent storage is required.`,
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'linkedin_token_refresh', status: 'complete', expires_in: result.expires_in }));
  } catch (e) {
    const ts = new Date().toISOString();
    console.error(JSON.stringify({ ts, job: 'linkedin_token_refresh', status: 'error', error: e.message }));
    await notifyAgents(['Cy', 'Quinn'], {
      type: 'CREDENTIAL_REFRESH_FAILED',
      service: 'linkedin',
      error: e.message,
      message: `LinkedIn token refresh failed. Oliver's 0700 CT post may fail if current token has expired. Immediate credential check required.`,
    });
    await sgMail.send({
      to: OPS_ALERT_EMAIL,
      from: { email: process.env.FROM_EMAIL || 'noreply@cybersense.solutions', name: 'CyberSense.Solutions' },
      subject: '[OPS ALERT] LinkedIn token refresh failed',
      text: `LinkedIn token refresh failed at ${ts}.\n\nError: ${e.message}\n\nCy and Quinn have been notified. Oliver's next post may fail if the current token has expired.\n\n— CyberSense Scheduler`,
    }).catch(emailErr => console.error(JSON.stringify({ ts, job: 'linkedin_token_refresh', event: 'EMAIL_FAILED', error: emailErr.message })));
  }
}

// ── Scheduler bootstrap (node-cron) ──────────────────────────────────────────
function startScheduler() {
  try {
    const cron = require('node-cron');
    cron.schedule('5 0 * * *',      runNightlySnapshot,            { timezone: 'America/Chicago' });
    cron.schedule('1 0 * * *',      runSessionCleanup,             { timezone: 'America/Chicago' });
    cron.schedule('*/15 5-9 * * *', runAwarenessPipelineCheck,     { timezone: 'America/Chicago' });
    cron.schedule('*/5 * * * *',    runSLABreachSweep);
    cron.schedule('*/5 * * * *',    runTaskRetryQueue);
    cron.schedule('0 7 * * *',      triggerDailyFinancialSummary,  { timezone: 'America/Chicago' });
    // Red Team acquisition cycle
    cron.schedule('0 */4 * * *',    runRedTeamBatchCycle,          { timezone: 'America/Chicago' });
    cron.schedule('45 5 * * *',     runIvanCharlieRuthReminder,    { timezone: 'America/Chicago' });
    cron.schedule('5 6 * * *',      runAcquisitionDeliveryCheck,   { timezone: 'America/Chicago' });
    // Training + Sales
    cron.schedule('0 5 * * *',      runKirbyDailyCycle,            { timezone: 'America/Chicago' });
    cron.schedule('0 8 * * *',      runRenewalOutreach,            { timezone: 'America/Chicago' });
    cron.schedule('30 8 * * *',     runAccountHealthCheck,         { timezone: 'America/Chicago' });
    cron.schedule('0 9 * * *',      runLeadQualificationCheck,     { timezone: 'America/Chicago' });
    // Content + credentials
    cron.schedule('0 0 * * 1-5',    runMidnightContentUpdate,      { timezone: 'America/Chicago' });
    cron.schedule('0 23 * * 0',     runLinkedInTokenRefresh,       { timezone: 'America/Chicago' });
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'SCHEDULER_STARTED', jobs: 15 }));
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
  runRedTeamBatchCycle,
  runIvanCharlieRuthReminder,
  runAcquisitionDeliveryCheck,
  runKirbyDailyCycle,
  runRenewalOutreach,
  runAccountHealthCheck,
  runTaskRetryQueue,
  runLeadQualificationCheck,
  runMidnightContentUpdate,
  runLinkedInTokenRefresh,
};
