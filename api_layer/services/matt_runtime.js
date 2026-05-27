'use strict';

// services/matt_runtime.js
// Matt's production runtime — newsletter HTML generation and GitHub Pages commit.
// Triggered when a briefing reaches `approved` status. Renders the edition HTML
// from body_md, commits it to the GitHub Pages repo via the GitHub Contents API,
// and writes file_path to the briefing record so the HITL panel link is live.

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../db/queries');
const { notifyAgents } = require('./agents');

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GITHUB_API_BASE  = 'https://api.github.com';
const GITHUB_REPO      = 'BorgesLebron/cybersense-solutions';
const POLL_WINDOW_HOURS = 48;

// ── Token management ─────────────────────────────────────────────────────────

let _mattToken = null;

async function ensureMattToken() {
  if (_mattToken) {
    try {
      jwt.verify(_mattToken, process.env.AGENT_JWT_SECRET);
      return _mattToken;
    } catch (_) {}
  }
  const token = jwt.sign(
    { type: 'agent', agent_name: 'Matt', agent_team: 'production' },
    process.env.AGENT_JWT_SECRET,
    { expiresIn: '8h' }
  );
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.rotateAgentToken('Matt', hash);
  _mattToken = token;
  return token;
}

// ── File path helpers ─────────────────────────────────────────────────────────

function buildFilePath(edition_date, edition_number) {
  const d     = new Date(edition_date + 'T12:00:00Z');
  const month = MONTHS[d.getUTCMonth()];
  const year  = d.getUTCFullYear();
  const mm    = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd    = String(d.getUTCDate()).padStart(2, '0');
  return `newsletter/${year}/${month}/${mm}${dd}${year}_edition${edition_number}.html`;
}

function formatDisplayDate(edition_date) {
  const d = new Date(edition_date + 'T12:00:00Z');
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ── Markdown → HTML ───────────────────────────────────────────────────────────

function inlineMarkdown(text) {
  let s = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#38bdf8;">$1</a>');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLines(lines) {
  const result = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      if (inList) { result.push('</ul>'); inList = false; }
      continue;
    }
    const bulletMatch   = line.match(/^[-*•]\s+(.+)/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);

    if (bulletMatch || numberedMatch) {
      const text = (bulletMatch || numberedMatch)[1];
      if (!inList) { result.push('<ul class="list-disc list-inside space-y-1 text-gray-800 mb-3 text-sm">'); inList = true; }
      result.push(`<li>${inlineMarkdown(text)}</li>`);
    } else {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push(`<p class="text-gray-800 mb-3 text-sm">${inlineMarkdown(line)}</p>`);
    }
  }
  if (inList) result.push('</ul>');
  return result.join('\n');
}

function parseH3Items(sectionText) {
  const parts = sectionText.split(/^###\s+/m).filter(Boolean);
  if (!parts.length) return [{ title: null, content: sectionText.trim() }];
  return parts.map(part => {
    const nl = part.indexOf('\n');
    if (nl === -1) return { title: part.trim(), content: '' };
    return { title: part.slice(0, nl).trim(), content: part.slice(nl + 1).trim() };
  });
}

function parseBodyMd(body_md) {
  const sections = {};
  // Ruth's LLM uses ## (H2) section headings; scaffold fallback uses ### (H3)
  const splitRe = /^## /m.test(body_md) ? /^## +/m : /^### +/m;
  for (const raw of body_md.split(splitRe)) {
    if (!raw.trim()) continue;
    const nl = raw.indexOf('\n');
    if (nl === -1) continue;
    const key     = raw.slice(0, nl).trim().toLowerCase().replace(/^[#\s]+/, '');
    const content = raw.slice(nl + 1).trim();
    if (key.includes('opening') || key.includes('brief'))         sections.opening       = content;
    else if (key.includes('situational'))                          sections.situational   = content;
    else if (key.includes('training'))                             sections.training      = content;
    else if (key.includes('career') || key.includes('development')) sections.career       = content;
    else if (key.includes('modernization') || key.includes('innovation')) sections.modernization = content;
    else if (key.includes('final'))                                sections.final         = content;
  }
  return sections;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderSituationalAwareness(content) {
  // Handle both ### heading items (scaffold) and --- separated items (LLM output)
  let items;
  if (/^###\s+/m.test(content)) {
    items = parseH3Items(content);
  } else {
    items = content.split(/^---\s*$/m).map(s => s.trim()).filter(Boolean).map(block => {
      const nl = block.indexOf('\n');
      return nl === -1
        ? { title: block.trim(), content: '' }
        : { title: block.slice(0, nl).trim(), content: block.slice(nl + 1).trim() };
    });
  }
  const inner = items.map((item, i) => [
    item.title ? `<h3 class="text-xl font-semibold mb-1">${escHtml(item.title)}</h3>` : '',
    renderLines(item.content.split('\n')),
    i < items.length - 1 ? '<hr class="my-6 border-white/10">' : '',
  ].filter(Boolean).join('\n')).join('\n');

  return `
  <div class="mb-8">
    <div class="section-card p-6 rounded-xl border w-full">
      <h2 class="text-3xl font-bold mb-6 flex items-center border-b pb-2">Situational Awareness</h2>
      ${inner}
    </div>
  </div>`;
}

function renderCard(title, content) {
  const items = parseH3Items(content || '');
  const inner = items.map(item => [
    item.title ? `<h3 class="text-xl font-semibold mb-2">${escHtml(item.title)}</h3>` : '',
    renderLines(item.content.split('\n')),
  ].filter(Boolean).join('\n')).join('\n');
  return `
    <div class="section-card p-6 rounded-xl border">
      <h2 class="text-2xl font-bold mb-4 flex items-center border-b pb-2">${escHtml(title)}</h2>
      ${inner}
    </div>`;
}

function renderFullWidthSection(title, content) {
  const items = parseH3Items(content);
  const inner = items.map((item, i) => [
    item.title ? `<h3 class="text-xl font-semibold mb-2">${escHtml(item.title)}</h3>` : '',
    renderLines(item.content.split('\n')),
    i < items.length - 1 ? '<hr>' : '',
  ].filter(Boolean).join('\n')).join('\n');

  return `
  <div class="mb-8">
    <div class="section-card p-6 rounded-xl border">
      <h2 class="text-2xl font-bold mb-4 flex items-center border-b pb-2">${escHtml(title)}</h2>
      ${inner}
    </div>
  </div>`;
}

// ── HTML assembly ─────────────────────────────────────────────────────────────

function buildNewsletterHtml(briefing) {
  const { edition_number, edition_date, subject_line, body_md } = briefing;
  const dateStr     = edition_date instanceof Date ? edition_date.toISOString().slice(0, 10) : String(edition_date).slice(0, 10);
  const year        = new Date(dateStr + 'T12:00:00Z').getUTCFullYear();
  const displayDate = formatDisplayDate(edition_date);
  const filePath    = buildFilePath(edition_date, edition_number);
  const publicUrl   = `https://cybersense.solutions/${filePath}`;
  const sections    = parseBodyMd(body_md);

  const openingHtml      = sections.opening      ? `<section class="mb-12">${renderLines(sections.opening.split('\n'))}</section>` : '';
  const situationalHtml  = sections.situational  ? renderSituationalAwareness(sections.situational) : '';
  const twoColHtml       = (sections.training || sections.career)
    ? `\n  <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">${renderCard('Training Byte', sections.training || '')}${renderCard('Career Development', sections.career || '')}\n  </div>`
    : '';
  const modernizationHtml = sections.modernization ? renderFullWidthSection('Modernization and AI Insight', sections.modernization) : '';
  const finalHtml         = sections.final
    ? `\n  <div class="mb-8">\n    <div class="section-card p-6 rounded-xl border">\n      <h2 class="text-2xl font-bold mb-4 flex items-center border-b pb-2">Final Thought</h2>\n      ${renderLines(sections.final.split('\n'))}\n    </div>\n  </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CyberSense: Daily Digital Awareness Brief | ${displayDate}</title>
<meta property="og:title" content="Edition ${edition_number} – ${escHtml(subject_line)} | ${displayDate}"/>
<meta property="og:description" content="${escHtml(subject_line)}"/>
<meta property="og:image" content="https://raw.githubusercontent.com/BorgesLebron/hectorborges-portfolio/main/assets/csicon.png"/>
<meta property="og:url" content="${publicUrl}"/>
<meta property="og:type" content="article" />
<link rel="icon" type="image/png" href="https://raw.githubusercontent.com/BorgesLebron/hectorborges-portfolio/main/assets/csicon.png">
<link rel="apple-touch-icon" href="https://raw.githubusercontent.com/BorgesLebron/hectorborges-portfolio/main/assets/csicon.png">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
  body {
    background-color: #111827;
    background-image:
      radial-gradient(circle at 10% 50%, rgba(30,60,100,0.25) 0%, rgba(30,60,100,0.0) 50%),
      radial-gradient(circle at 90% 40%, rgba(0,150,255,0.15) 0%, rgba(0,150,255,0.0) 30%),
      linear-gradient(0deg, transparent 24%, rgba(60,60,60,0.1) 25%, rgba(60,60,60,0.1) 26%, transparent 27%),
      linear-gradient(90deg, transparent 24%, rgba(60,60,60,0.1) 25%, rgba(60,60,60,0.1) 26%, transparent 27%);
    background-size: 100% 100%, 100% 100%, 50px 50px, 50px 50px;
    background-attachment: fixed;
    color: #e0e7ff;
    font-family: 'Inter', sans-serif;
  }
  .newsletter-container { background-color: rgba(255,255,255,0.05); backdrop-filter: blur(5px); border-color: rgba(255,255,255,0.1) !important; }
  .section-card { background-color: rgba(0,0,0,0.3) !important; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); transition: transform 0.2s, box-shadow 0.2s; height: 100%; border-color: rgba(255,255,255,0.1) !important; }
  .section-card:hover { transform: translateY(-2px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
  .text-gray-900, .text-gray-800, .text-gray-700 { color: #e0e7ff !important; }
  .border-cyan-700 { border-color: #0e7490 !important; }
  .libutton { display: flex; flex-direction: column; justify-content: center; padding: 7px; text-align: center; outline: none; text-decoration: none !important; color: #ffffff !important; width: 300px; height: 50px; border-radius: 30px; background-color: #0A66C2; font-family: "SF Pro Text", Helvetica, sans-serif; font-weight: 500; transition: background-color 0.15s ease-in-out; }
  .libutton:hover { background-color: #00FFFF; }
  hr { border-top: 2px solid rgba(255,255,255,0.1) !important; margin-top: 40px !important; border-bottom: none !important; margin-bottom: 40px !important; }
  h1 { text-align: center; color: #ffffff !important; font-family: georgia; }
  h2 { text-align: center; color: #0080ff !important; font-family: georgia; }
  h3 { text-align: left; color: #66B2FF !important; font-family: georgia; }
  .edition-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(0,0,0,0.3);
    border: 1px solid #0e7490;
    border-radius: 99px;
    padding: 4px 16px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #38bdf8;
  }
</style>
</head>
<body class="p-4 sm:p-8">
<div class="newsletter-container max-w-5xl mx-auto rounded-xl shadow-2xl p-6 sm:p-10 border">

  <div class="flex justify-center items-center w-full py-0">
    <img src="https://raw.githubusercontent.com/BorgesLebron/hectorborges-portfolio/main/assets/csicon.png"
         alt="CyberSense Newsletter Icon"
         class="rounded-full shadow-xl w-48 h-48 object-cover"
         onerror="this.onerror=null; this.src='https://placehold.co/192x192/4f46e5/ffffff?text=CS'">
  </div>

  <div class="flex justify-between items-center mt-4 mb-2">
    <span class="edition-badge">Edition ${edition_number}</span>
    <span class="text-gray-700 text-base font-semibold">${displayDate}</span>
  </div>

  <section class="mb-5 pb-6 border-b-4 border-cyan-700"></section>
  <header class="text-center mb-4 pb-5 border-b-4 border-cyan-700">
    <h1 class="text-4xl sm:text-5xl font-extrabold leading-tight tracking-tight">Daily Digital Awareness Brief</h1>
  </header>

  <div class="mb-8 mt-10">
    <h2 class="text-4xl sm:text-4xl font-extrabold leading-tight tracking-tight text-center">
      ${escHtml(subject_line)}
    </h2>
  </div>

  ${openingHtml}

  ${situationalHtml}

  ${twoColHtml}

  ${modernizationHtml}

  ${finalHtml}

  <footer class="mt-12 pt-6 border-t border-gray-300 text-center">
    <h3 class="text-lg font-base text-gray-800 text-center mb-2">Did you find this briefing useful?</h3>
    <div class="mt-4 mb-8 flex flex-col sm:flex-row justify-center items-center space-y-4 sm:space-y-0 sm:space-x-4">
      <a class="libutton shadow-md" href="https://cybersense.solutions/newsletter.html#subscribe" target="_blank">Subscribe</a>
      <button id="shareButton" class="inline-block px-10 py-2 bg-blue-700 text-gray-900 font-medium rounded-full hover:bg-cyan-500 transition duration-150 shadow-md">Share this Brief</button>
    </div>

    <div class="border-t pt-5 pb-4" style="background:linear-gradient(135deg,rgba(14,165,233,0.06),rgba(56,189,248,0.03));border-radius:8px;margin-bottom:16px;padding:16px 20px;">
      <p style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#38bdf8;margin-bottom:6px;">Mission Advance</p>
      <p style="font-size:13px;color:#F1F5F9;line-height:1.6;">CyberSense is moving to a dedicated platform. Our daily intelligence briefings, training modules, and threat radar will soon live at <a href="https://cybersense.solutions" style="color:#38bdf8;text-decoration:underline;">cybersense.solutions</a> — built for the teams that can’t afford to be caught off guard.</p>
    </div>

    <div class="border-t pt-4 text-sm">
      <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;margin-bottom:2px;">CyberSense<span style="color:#00D4FF;">.Solutions</span></div>
      <p class="mb-3 text-cyan-400" style="font-size:12px;">hello@cybersense.solutions</p>

      <div style="display:flex;justify-content:center;gap:10px;margin-bottom:16px;">
        <a href="https://www.linkedin.com/company/cybersense-solutions/" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f172a;color:#38bdf8;font-size:13px;font-weight:700;text-decoration:none;">in</a>
        <a href="https://www.facebook.com/profile.php?id=61570667370162" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f172a;color:#38bdf8;font-size:13px;font-weight:700;text-decoration:none;">f</a>
        <a href="https://x.com/cybersensesec" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f172a;color:#38bdf8;font-size:12px;font-weight:700;text-decoration:none;">X</a>
        <a href="https://www.instagram.com/cybersense.solutions/" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f172a;color:#38bdf8;font-size:12px;font-weight:700;text-decoration:none;">ig</a>
        <a href="https://www.threads.com/@cybersense.solutions" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f172a;color:#38bdf8;font-size:12px;font-weight:700;text-decoration:none;">tt</a>
      </div>

      <p style="font-size:11px;color:rgba(56,189,248,0.5);">
        &copy; ${year} CyberSense.Solutions. All content provided for educational and awareness purposes.<br>
        Veteran-Owned - <strong style="color:rgba(56,189,248,0.7);">Security awareness starts here.</strong>
      </p>
    </div>
  </footer>
</div>

<script>
  const shareButton = document.getElementById('shareButton');
  if (shareButton) {
    shareButton.addEventListener('click', () => {
      if (navigator.share) {
        navigator.share({
          title: 'CyberSense: Daily Digital Awareness Brief — Edition ${edition_number}',
          text: ${JSON.stringify(subject_line)},
          url: window.location.href
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(window.location.href).then(() => {
          shareButton.textContent = 'Link Copied!';
          setTimeout(() => { shareButton.textContent = 'Share this Brief'; }, 2000);
        });
      }
    });
  }
</script>
</body>
</html>`;
}

// ── GitHub Pages commit ───────────────────────────────────────────────────────

async function commitToGithub(filePath, htmlContent, commitMessage) {
  const token = process.env.GITHUB_NEWSLETTER_TOKEN;
  if (!token) throw new Error('GITHUB_NEWSLETTER_TOKEN not configured');

  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'cybersense-matt-runtime',
  };

  // GET first to retrieve SHA if the file already exists (idempotent update)
  let sha;
  const getRes = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET failed: ${getRes.status}`);
  }

  const body = {
    message: commitMessage,
    content: Buffer.from(htmlContent, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => '');
    throw new Error(`GitHub commit failed: ${putRes.status} — ${errText.slice(0, 200)}`);
  }

  return await putRes.json();
}

// ── Task execution ────────────────────────────────────────────────────────────

async function executeMattHtmlGeneration(task) {
  const ts = new Date().toISOString();

  console.log(JSON.stringify({
    ts, runtime: 'matt', event: 'HTML_GEN_START',
    task_id: task.id, content_id: task.content_id,
  }));

  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const briefing = await db.getBriefingById(task.content_id);
    if (!briefing) throw new Error(`Briefing ${task.content_id} not found`);

    if (briefing.pipeline_status !== 'approved') {
      console.log(JSON.stringify({
        ts, runtime: 'matt', event: 'SKIP_WRONG_STATUS',
        briefing_id: briefing.id, pipeline_status: briefing.pipeline_status,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    // Skip if file_path already set — already committed
    if (briefing.file_path) {
      console.log(JSON.stringify({
        ts, runtime: 'matt', event: 'SKIP_ALREADY_COMMITTED',
        briefing_id: briefing.id, file_path: briefing.file_path,
      }));
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    if (!briefing.body_md || briefing.body_md.trim().length < 200) {
      throw new Error(`body_md missing or too short (${briefing.body_md?.length || 0} chars) — editorial pipeline may not have completed`);
    }

    const filePath    = buildFilePath(briefing.edition_date, briefing.edition_number);
    const htmlContent = buildNewsletterHtml(briefing);
    const commitMsg   = `[MATT] Edition ${briefing.edition_number} newsletter HTML — ${briefing.edition_date} (Matt)`;

    await commitToGithub(filePath, htmlContent, commitMsg);

    await db.updateBriefingEditorial(briefing.id, { file_path: filePath });

    await db.logPipelineEvent({
      content_type: 'briefing',
      content_id:   briefing.id,
      from_status:  'approved',
      to_status:    'approved',
      agent_name:   'Matt',
      notes:        `Newsletter HTML committed to GitHub Pages: ${filePath}`,
    });

    await db.updateTask(task.id, { status: 'complete' });

    await notifyAgents(['Nora'], {
      type:           'NEWSLETTER_HTML_COMMITTED',
      briefing_id:    briefing.id,
      edition_number: briefing.edition_number,
      edition_date:   briefing.edition_date,
      file_path:      filePath,
      public_url:     `https://cybersense.solutions/${filePath}`,
      message:        `Edition ${briefing.edition_number} HTML committed. HITL link is now live.`,
    });

    console.log(JSON.stringify({
      ts, runtime: 'matt', event: 'HTML_GEN_COMPLETE',
      briefing_id: briefing.id, edition_number: briefing.edition_number,
      file_path: filePath, task_id: task.id,
    }));

  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: e.message });
    await notifyAgents(['Barret', 'Henry'], {
      type:    'MATT_HTML_GEN_FAILED',
      task_id: task.id,
      error:   e.message,
      message: `Matt newsletter HTML generation failed: ${e.message}. HITL link will be dead until resolved.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'matt', event: 'HTML_GEN_ERROR',
      task_id: task.id, error: e.message,
    }));
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollMattTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT * FROM agent_tasks
      WHERE agent_name = 'Matt'
        AND task_type   = 'generate_newsletter_html'
        AND status      IN ('queued', 'escalated')
        AND started_at  > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
      ORDER BY started_at ASC
      LIMIT 3
    `).then(r => r.rows);

    for (const task of tasks) {
      await executeMattHtmlGeneration(task);
    }
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'matt', event: 'POLL_ERROR', error: e.message,
    }));
  }
}

module.exports = { pollMattTasks, ensureMattToken, buildNewsletterHtml, buildFilePath };
