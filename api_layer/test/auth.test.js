const {
  gateContent,
  validatePipelineTransition,
  TIER_RANK,
  AGENT_PERMISSIONS,
} = require('../middleware/auth');

describe('auth helper behavior', () => {
  test('tier ranks preserve subscriber upgrade order', () => {
    expect(TIER_RANK.free).toBeLessThan(TIER_RANK.freemium);
    expect(TIER_RANK.freemium).toBeLessThan(TIER_RANK.monthly);
    expect(TIER_RANK.monthly).toBeLessThan(TIER_RANK.enterprise);
  });

  test('gateContent returns full content when user tier is sufficient', () => {
    const article = {
      id: 'article-1',
      title: 'Full article',
      slug: 'full-article',
      section: 'growth',
      access_tier: 'monthly',
      body_md: 'Full body',
    };

    expect(gateContent(article, 'enterprise')).toBe(article);
    expect(gateContent(article, 'monthly')).toBe(article);
  });

  test('gateContent returns teaser-only payload when user tier is insufficient', () => {
    const article = {
      id: 'article-1',
      title: 'Monthly article',
      slug: 'monthly-article',
      section: 'growth',
      access_tier: 'monthly',
      published_at: '2026-05-17T00:00:00.000Z',
      read_time_min: 3,
      body_md: 'A'.repeat(320),
    };

    const gated = gateContent(article, 'free');

    expect(gated).toMatchObject({
      id: article.id,
      title: article.title,
      slug: article.slug,
      section: article.section,
      access_tier: article.access_tier,
      blurred: true,
    });
    expect(gated.body_md).toBeUndefined();
    expect(gated.teaser).toHaveLength(281);
  });

  test('article pipeline requires QA timestamp before Maya stage', () => {
    const result = validatePipelineTransition('article', 'qa', 'maya', 'Maya', {
      qa_passed_at: null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('qa_passed_at');
  });

  test('article pipeline allows Jeff to advance EIC review to QA', () => {
    expect(validatePipelineTransition('article', 'eic_review', 'qa', 'Jeff', {})).toEqual({ valid: true });
  });

  test('stage authorization rejects wrong agent for publication', () => {
    const result = validatePipelineTransition('article', 'approved', 'published', 'Maya', {
      qa_passed_at: '2026-05-17T00:00:00.000Z',
      maya_approved_at: '2026-05-17T00:00:00.000Z',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Maya');
  });

  test('agent fleet configuration includes Gwen-owned editorial operators', () => {
    expect(AGENT_PERMISSIONS.James.endpoints).toContain('pipeline:articles');
    expect(AGENT_PERMISSIONS.Maya.endpoints).toContain('pipeline:articles:status');
    expect(AGENT_PERMISSIONS.Laura.endpoints).toContain('pipeline:release');
  });
});
