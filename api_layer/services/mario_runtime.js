'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { postAgentStatusToActiveMeeting } = require('./meetings'); // Assuming meetings service for status updates

const POLL_INTERVAL_MS = 60 * 1000; // Poll every minute

// ── Token management ─────────────────────────────────────────────────────────

let _marioToken = null;

async function ensureMarioToken() {
  if (_marioToken) {
    try {
      jwt.verify(_marioToken, process.env.AGENT_JWT_SECRET);
      return _marioToken;
    } catch (_) {
      // Token expired or invalid
    }
  }

  const token = jwt.sign(
    { type: 'agent', agent_name: 'Mario', agent_team: 'production' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Mario', hash);
  _marioToken = token;
  return token;
}

// ── Markdown to HTML conversion (simple) ─────────────────────────────────────
function markdownToHtml(markdown) {
  let html = markdown;
  // Convert ## headings to <h2>
  html = html.replace(/^##\s*(.*)$/gm, '<h2>$1</h2>');
  // Convert bullet points to <ul><li>
  html = html.replace(/^\*\s*(.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(
<li>.*<\/li>)*)/gs, '<ul>$1</ul>');
  // Convert text within backticks to <code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Convert newlines to <br> where appropriate (simple paragraphs)
  html = html.replace(/

/g, '</p><p>');
  html = `<p>${html}</p>`; // Wrap the whole thing in a paragraph.
  return html;
}

// ── Content Production Logic ──────────────────────────────────────────────────

async function processTrainingModuleForHtml(module) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'mario', event: 'PROCESSING_HTML', module_id: module.id }));

  try {
    const htmlContent = markdownToHtml(module.body_md);

    await db.updateTrainingModuleHtmlAndStatus(module.id, htmlContent, 'html_ready');

    // Optionally post status to meeting
    try {
      await postAgentStatusToActiveMeeting('Mario', 'production', {
        event: 'TRAINING_BYTE_HTML_READY',
        title: module.title,
        module_id: module.id,
      });
    } catch (meetingErr) {
      console.warn(JSON.stringify({ ts, runtime: 'mario', event: 'MEETING_POST_FAILED', error: meetingErr.message }));
    }

    console.log(JSON.stringify({ ts, runtime: 'mario', event: 'HTML_READY', module_id: module.id }));
  } catch (e) {
    console.error(JSON.stringify({ ts, runtime: 'mario', event: 'HTML_PRODUCTION_ERROR', error: e.message, module_id: module.id }));
    // Consider updating module status to 'html_failed' or similar
    await db.updateTrainingModuleHtmlAndStatus(module.id, null, 'html_failed');
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollMarioTasks() {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, runtime: 'mario', event: 'POLLING_TASKS' }));

  try {
    const trainingModules = await db.getTrainingModulesByStatus('ready_for_html', 5); // Fetch up to 5 modules

    for (const module of trainingModules) {
      await processTrainingModuleForHtml(module);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'mario', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

const marioRuntime = {
  async init() {
    console.log('Mario Coordinator initialized.');
    await ensureMarioToken(); // Ensure token is available
    setInterval(pollMarioTasks, POLL_INTERVAL_MS); // Poll every minute
    pollMarioTasks(); // Initial poll
  },
};

module.exports = marioRuntime;
