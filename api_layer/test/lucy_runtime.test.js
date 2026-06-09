const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

jest.mock('../db/queries', () => ({
  getArticleById: jest.fn(),
  updateArticleBanner: jest.fn(),
  updateTask: jest.fn(),
  logPipelineEvent: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock('../services/agents', () => ({
  notifyAgents: jest.fn(),
}));

jest.mock('../services/github_content', () => ({
  commitBufferToGithub: jest.fn(),
}));

const {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  buildImagePrompt,
  composeBanner,
  isArticleBannerReleaseable,
  wrapHeadline,
} = require('../services/lucy_runtime');

const article = {
  id: 'article-1',
  slug: 'identity-governance-for-autonomous-agents',
  title: 'Identity Governance for Autonomous Agents Requires New Operational Guardrails',
  section: 'innovation',
  body_md: '## Executive Summary\nAutonomous agents create new identity, authorization, and audit requirements.',
};

describe('Lucy article banner runtime', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.TOGETHER_AI_API_KEY;
  });

  test('builds a text-free editorial image prompt from article context', () => {
    const prompt = buildImagePrompt(article);

    expect(prompt).toContain(article.title);
    expect(prompt).toContain('negative space');
    expect(prompt).toContain('No text, letters, numbers, logos');
  });

  test('wraps long headlines to no more than three lines', () => {
    const lines = wrapHeadline(article.title);

    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join(' ')).toContain('Identity Governance');
  });

  test('release eligibility requires a committed image or an explicit skip', () => {
    expect(isArticleBannerReleaseable({ banner_status: 'pending' })).toBe(false);
    expect(isArticleBannerReleaseable({ banner_status: 'ready', banner_image_url: null })).toBe(false);
    expect(isArticleBannerReleaseable({
      banner_status: 'ready',
      banner_image_url: 'https://cybersense.solutions/headlineBanner/example.png',
    })).toBe(true);
    expect(isArticleBannerReleaseable({ banner_status: 'skipped' })).toBe(true);
  });

  test('composes a deterministic 1200x630 PNG with bundled fonts', async () => {
    expect(fs.existsSync(path.resolve(__dirname, '..', 'assets', 'fonts', 'BricolageGrotesque-Bold.ttf'))).toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '..', 'assets', 'fonts', 'InstrumentSans-Bold.ttf'))).toBe(true);

    const base = await sharp({
      create: {
        width: 1344,
        height: 768,
        channels: 3,
        background: '#17324d',
      },
    }).png().toBuffer();

    const result = await composeBanner(base, article);
    const metadata = await sharp(result).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(BANNER_WIDTH);
    expect(metadata.height).toBe(BANNER_HEIGHT);
  });

  test('accepts the deployed TOGETHER_AI_API_KEY alias', async () => {
    process.env.TOGETHER_AI_API_KEY = 'railway-together-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }),
    });

    const { generateBaseImage } = require('../services/lucy_runtime');
    const result = await generateBaseImage(article);

    expect(result.toString()).toBe('image');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer railway-together-key',
        }),
      })
    );
  });
});
