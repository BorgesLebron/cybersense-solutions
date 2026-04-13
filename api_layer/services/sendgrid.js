'use strict';
// ── services/sendgrid.js ──────────────────────────────────────────────────────
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM = { email: process.env.FROM_EMAIL || 'noreply@cybersense.solutions', name: 'CyberSense.Solutions' };

async function sendVerificationEmail(to, name, token) {
  const link = `${process.env.APP_URL}/verify-email?token=${token}`;
  try {
    await sgMail.send({
      to, from: FROM,
      templateId: process.env.SG_TEMPLATE_VERIFY,
      dynamicTemplateData: { name, link, platform_name: 'CyberSense.Solutions' },
    });
  } catch (e) {
    console.error('SendGrid verification email failed:', e.message);
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
    console.error('SendGrid reset email failed:', e.message);
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
    console.error('SendGrid welcome email failed:', e.message);
  }
}

async function sendBriefingEmail(to_list, briefing) {
  const messages = to_list.map(({ email, name }) => ({
    to: email, from: FROM,
    templateId: process.env.SG_TEMPLATE_BRIEFING,
    dynamicTemplateData: { name, edition_date: briefing.edition_date, subject: briefing.subject_line, preview_url: `${process.env.APP_URL}/newsletter/${briefing.edition_date}` },
  }));
  try {
    await sgMail.send(messages);
  } catch (e) {
    console.error('SendGrid briefing email failed:', e.message);
  }
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail, sendBriefingEmail };
