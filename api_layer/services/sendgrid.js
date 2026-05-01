'use strict';
// ── services/sendgrid.js ──────────────────────────────────────────────────────
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM = { email: process.env.FROM_EMAIL || 'noreply@cybersense.solutions', name: 'CyberSense.Solutions' };

function logSgError(label, e) {
  const details = e.response?.body?.errors ?? e.response?.body ?? e.message;
  console.error(`SendGrid ${label} failed:`, JSON.stringify(details));
}

async function sendVerificationEmail(to, name, token) {
  const link = `${process.env.APP_URL}/verify-email?token=${token}`;
  try {
    await sgMail.send({
      to, from: FROM,
      templateId: process.env.SG_TEMPLATE_VERIFY,
      dynamicTemplateData: { name, link, platform_name: 'CyberSense.Solutions' },
    });
  } catch (e) {
    logSgError('verification email', e);
  }
}

async function sendPasswordResetEmail(to, name, token) {
  const link = `${process.env.APP_URL}/reset-password?token=${token}`;
  try {
    await sgMail.send({
      to, from: FROM,
      templateId: process.env.SG_TEMPLATE_RESET,
      dynamicTemplateData: { name, link, expires_in: '1 hour' },
    });
  } catch (e) {
    logSgError('reset email', e);
  }
}

async function sendWelcomeEmail(to, name) {
  try {
    await sgMail.send({
      to, from: FROM,
      templateId: process.env.SG_TEMPLATE_WELCOME,
      dynamicTemplateData: { name, platform_url: process.env.APP_URL },
    });
  } catch (e) {
    logSgError('welcome email', e);
  }
}

async function sendBriefingEmail(to_list, briefing) {
  const rawDate = briefing.edition_date;
  const dateOnly = rawDate instanceof Date
    ? rawDate.toISOString().split('T')[0]
    : String(rawDate).split('T')[0];
  const dateFormatted = new Date(dateOnly + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const messages = to_list.map(({ email, name }) => ({
    to: email, from: FROM,
    templateId: process.env.SG_TEMPLATE_BRIEFING,
    dynamicTemplateData: {
      name,
      edition_date: dateFormatted,
      subject: briefing.subject_line,
      preview_url: briefing.file_path
        ? `${process.env.APP_URL}${briefing.file_path}`
        : `${process.env.APP_URL}/newsletter`
    },
  }));
  try {
    await sgMail.send(messages);
  } catch (e) {
    logSgError('briefing email', e);
  }
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail, sendBriefingEmail };
