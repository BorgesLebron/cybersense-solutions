'use strict';

const path = require('path');
const sharp = require('sharp');
const opentype = require('opentype.js');
const db = require('../db/queries');
const { notifyAgents } = require('./agents');
const { commitBufferToGithub } = require('./github_content');

const TOGETHER_IMAGES_URL = 'https://api.together.xyz/v1/images/generations';
const LUCY_MODEL = process.env.LUCY_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
const BANNER_WIDTH = 1200;
const BANNER_HEIGHT = 630;
const POLL_WINDOW_HOURS = 48;
const PUBLIC_BASE_URL = (process.env.PUBLIC_SITE_URL || 'https://cybersense.solutions').replace(/\/$/, '');
const FONT_ROOT = path.resolve(__dirname, '..', 'assets', 'fonts');
const HEADLINE_FONT = path.join(FONT_ROOT, 'BricolageGrotesque-Bold.ttf');
const BODY_FONT = path.join(FONT_ROOT, 'InstrumentSans-Bold.ttf');
let _headlineFont;
let _bodyFont;

const SECTION_LABELS = {
  threat: 'THREAT INTELLIGENCE',
  policy: 'POLICY & GUIDANCE',
  innovation: 'INNOVATION',
  growth: 'PROFESSIONAL GROWTH',
  training: 'TRAINING RESOURCES',
};

function escapeMarkup(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function articleSummary(article) {
  const body = String(article.body_md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 700);
}

function buildImagePrompt(article) {
  const section = SECTION_LABELS[article.section] || 'CYBERSECURITY INTELLIGENCE';
  return [
    `Create a sophisticated editorial illustration for a ${section.toLowerCase()} article.`,
    `Subject: ${article.title}.`,
    `Context: ${articleSummary(article)}`,
    'Wide cinematic composition with the primary subject weighted to the right side.',
    'Leave darker, low-detail negative space across the left half for a headline overlay.',
    'Cybersecurity intelligence aesthetic, realistic materials, deep navy and cyan palette, restrained lighting, professional and credible.',
    'No text, letters, numbers, logos, badges, watermarks, interface screenshots, or readable documents.',
  ].join(' ');
}

function wrapHeadline(title, maxChars = 31, maxLines = 3) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const overflow = lines.slice(maxLines - 1).join(' ');
  kept[maxLines - 1] = overflow.length > maxChars
    ? `${overflow.slice(0, Math.max(1, maxChars - 1)).trimEnd()}...`
    : overflow;
  return kept;
}

function loadFonts() {
  _headlineFont ||= opentype.loadSync(HEADLINE_FONT);
  _bodyFont ||= opentype.loadSync(BODY_FONT);
  return { headline: _headlineFont, body: _bodyFont };
}

function textPath(font, text, x, baseline, fontSize, color) {
  const glyphPath = font.getPath(text, x, baseline, fontSize);
  return `<path d="${glyphPath.toPathData(2)}" fill="${color}"/>`;
}

function buildTypographyLayer(article) {
  const fonts = loadFonts();
  const headlineLines = wrapHeadline(article.title);
  const category = SECTION_LABELS[article.section] || 'CYBERSECURITY INTELLIGENCE';
  const brand = 'CyberSense.Solutions';
  const brandSize = 20;
  const brandWidth = fonts.body.getAdvanceWidth(brand, brandSize);

  const headlinePaths = headlineLines.map((line, index) =>
    textPath(fonts.headline, line, 54, 215 + index * 60, 58, '#FFFFFF')
  ).join('');

  return Buffer.from(`
    <svg width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      ${textPath(fonts.body, category, 82, 104, 18, '#00D2FF')}
      ${headlinePaths}
      ${textPath(fonts.body, brand, 1146 - brandWidth, 598, brandSize, '#FFFFFF')}
    </svg>
  `);
}

async function composeBanner(baseImage, article) {
  const typographyLayer = buildTypographyLayer(article);

  const shading = Buffer.from(`
    <svg width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#020813" stop-opacity="0.98"/>
          <stop offset="54%" stop-color="#020813" stop-opacity="0.76"/>
          <stop offset="82%" stop-color="#020813" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="#020813" stop-opacity="0.08"/>
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="58%" stop-color="#020813" stop-opacity="0"/>
          <stop offset="100%" stop-color="#020813" stop-opacity="0.78"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#shade)"/>
      <rect width="1200" height="630" fill="url(#floor)"/>
      <rect x="54" y="64" width="7" height="62" rx="3.5" fill="#00D2FF"/>
      <line x1="54" y1="557" x2="1146" y2="557" stroke="#00D2FF" stroke-opacity="0.42"/>
    </svg>
  `);

  return sharp(baseImage)
    .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: 'cover', position: 'attention' })
    .composite([
      { input: shading, top: 0, left: 0 },
      { input: typographyLayer, top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function generateBaseImage(article) {
  const apiKey = process.env.TOGETHER_API_KEY || process.env.TOGETHER_AI_API_KEY;
  if (!apiKey) throw new Error('TOGETHER_API_KEY or TOGETHER_AI_API_KEY not configured');

  const response = await fetch(TOGETHER_IMAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LUCY_MODEL,
      prompt: buildImagePrompt(article),
      width: 1344,
      height: 768,
      steps: 4,
      n: 1,
      response_format: 'base64',
      output_format: 'png',
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Together image generation failed: ${response.status} - ${detail.slice(0, 240)}`);
  }

  const payload = await response.json();
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) throw new Error('Together image response did not include base64 image data');
  return Buffer.from(encoded, 'base64');
}

async function executeLucyBanner(task) {
  const ts = new Date().toISOString();
  await db.updateTask(task.id, { status: 'in_progress' });

  try {
    const article = await db.getArticleById(task.content_id);
    if (!article) throw new Error(`Article ${task.content_id} not found`);
    if (article.banner_status === 'ready') {
      await db.updateTask(task.id, { status: 'complete' });
      return;
    }

    await db.updateArticleBanner(article.id, {
      status: 'generating',
      incrementAttempts: true,
      clearSkip: true,
      error: null,
    });

    const baseImage = await generateBaseImage(article);
    const banner = await composeBanner(baseImage, article);
    const current = await db.getArticleById(article.id);
    if (current?.banner_status === 'skipped') {
      console.log(JSON.stringify({
        ts, runtime: 'lucy', event: 'BANNER_ABORTED_AFTER_SKIP',
        article_id: article.id, task_id: task.id,
      }));
      return;
    }
    const filePath = `headlineBanner/${article.slug}.png`;
    const bannerUrl = `${PUBLIC_BASE_URL}/${filePath}`;
    const versionedBannerUrl = `${bannerUrl}?v=${Date.now()}`;

    await commitBufferToGithub({
      filePath,
      content: banner,
      commitMessage: `[LUCY] Article headline banner - ${article.title} (Lucy)`,
      token: process.env.GITHUB_ARTICLE_ASSET_TOKEN || process.env.GITHUB_NEWSLETTER_TOKEN,
      userAgent: 'cybersense-lucy-runtime',
    });

    await db.updateArticleBanner(article.id, {
      status: 'ready',
      imageUrl: versionedBannerUrl,
      altText: `${article.title} - CyberSense.Solutions article banner`,
      generatedAt: new Date(),
      error: null,
      clearSkip: true,
    });
    await db.logPipelineEvent({
      content_type: 'article',
      content_id: article.id,
      from_status: article.pipeline_status,
      to_status: article.pipeline_status,
      agent_name: 'Lucy',
      notes: `Article banner committed: ${filePath}`,
    });
    await db.updateTask(task.id, { status: 'complete' });
    await notifyAgents(['Maya', 'Laura'], {
      type: 'ARTICLE_BANNER_READY',
      article_id: article.id,
      banner_image_url: versionedBannerUrl,
      message: `Lucy completed the article banner for "${article.title}".`,
    });

    console.log(JSON.stringify({
      ts, runtime: 'lucy', event: 'BANNER_COMPLETE',
      article_id: article.id, task_id: task.id, file_path: filePath,
    }));
  } catch (error) {
    await db.updateArticleBanner(task.content_id, {
      status: 'failed',
      error: error.message,
    }).catch(() => {});
    await db.updateTask(task.id, { status: 'failed', error_message: error.message });
    await notifyAgents(['Barret', 'Henry'], {
      type: 'LUCY_BANNER_FAILED',
      article_id: task.content_id,
      task_id: task.id,
      error: error.message,
      message: `Lucy article banner failed: ${error.message}. Editorial work may continue; GM can retry or skip the banner.`,
    });
    console.error(JSON.stringify({
      ts, runtime: 'lucy', event: 'BANNER_ERROR',
      task_id: task.id, article_id: task.content_id, error: error.message,
    }));
  }
}

async function pollLucyTasks() {
  try {
    const tasks = await db.pool.query(`
      SELECT t.*
      FROM agent_tasks t
      JOIN articles a ON a.id = t.content_id
      WHERE t.agent_name = 'Lucy'
        AND t.task_type = 'generate_article_banner'
        AND t.content_type = 'article'
        AND t.status IN ('queued', 'escalated')
        AND t.started_at > now() - INTERVAL '${POLL_WINDOW_HOURS} hours'
        AND a.banner_status IN ('pending', 'failed', 'skipped')
      ORDER BY t.started_at ASC
      LIMIT 1
    `).then(r => r.rows);

    for (const task of tasks) await executeLucyBanner(task);
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), runtime: 'lucy', event: 'POLL_ERROR', error: error.message,
    }));
  }
}

function isArticleBannerReleaseable(article) {
  return article?.banner_status === 'skipped'
    || (article?.banner_status === 'ready' && Boolean(article.banner_image_url));
}

module.exports = {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  LUCY_MODEL,
  buildImagePrompt,
  composeBanner,
  executeLucyBanner,
  generateBaseImage,
  isArticleBannerReleaseable,
  pollLucyTasks,
  wrapHeadline,
};
