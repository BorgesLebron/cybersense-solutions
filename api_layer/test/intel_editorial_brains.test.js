const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicCreate },
})));

const db = require('../db/queries');
const james = require('../services/james_runtime');
const jason = require('../services/jason_runtime');
const rob = require('../services/rob_runtime');
const jeff = require('../services/jeff_runtime');
const maya = require('../services/maya_runtime');
const {
  normalizeArticleBodyMarkdown,
  validateArticleMarkdown,
} = require('../services/article_markdown');

jest.mock('../db/queries', () => ({
  getArticleById: jest.fn(),
  rotateAgentToken: jest.fn(),
  updateTask: jest.fn(),
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../services/agents', () => ({
  notifyAgents: jest.fn(),
}));

global.fetch = jest.fn();

const validArticle = `
## Executive Summary
Recent digital identity activity shows that wallet support alone does not create durable institutional trust. Security leaders need governance, issuer verification, lifecycle controls, and practical operating models before credentials can support sensitive workflows.

## What Happened
Several public and private sector programs are expanding verifiable credential pilots for identity, workforce, and compliance use cases. The technology is maturing, but deployment quality remains uneven across issuers, relying parties, and verification surfaces.

## Why It Matters
For practitioners, the relevant risk is not whether a credential can be stored in a wallet. The operational question is whether the credential can be trusted, revoked, audited, and interpreted consistently across real business processes.

## Operational Implications
Organizations adopting credentials should define issuer assurance levels, verification policy, monitoring expectations, and exception handling. Without those controls, wallet adoption may increase complexity while leaving accountability unclear.

## Recommended Actions
1. Map credential use cases to defined risk tiers and issuer assurance requirements.
2. Validate revocation mechanics, relying-party obligations, and exception handling.
3. Test user recovery paths before expanding production use.

## Closing Assessment
Verifiable credentials remain promising, but trust is an operating model rather than a feature. Programs that treat governance, verification, and lifecycle management as first-class requirements will be better positioned for resilient adoption.
`;

const validArticleWithTitle = `# Verifiable Credentials Need Operational Trust

${validArticle}`;

const article = {
  id: 'article-1',
  title: 'Verifiable Credentials Need Operational Trust',
  section: 'innovation',
  access_tier: 'monthly',
  body_md: 'James draft about verifiable credentials, wallet support, issuer assurance, and operational trust. '.repeat(12),
};

const repositoryItem = {
  repository_id: 'repo-1',
  source_id: 'source-1',
  source_type: 'innovation',
  section: 'innovation',
  title: 'Verifiable Credentials Need Operational Trust',
  category: 'digital identity',
  priority: 'strategic',
  tags: ['identity', 'trust'],
  source_url: 'https://example.test/identity',
  summary: 'Wallet support is expanding, but operational trust requires issuer assurance and lifecycle governance.',
  normalized_data: {
    summary: 'Credential programs require governance, verification policy, and revocation controls.',
  },
};

describe('James, Jason, Rob, and Jeff Intel article pipeline brains', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTEL_EDITORIAL_BRAIN_API_KEY = 'test-intel-editorial-key';
    process.env.AGENT_JWT_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    delete process.env.INTEL_EDITORIAL_BRAIN_API_KEY;
    delete process.env.AGENT_JWT_SECRET;
  });

  test('James prompt carries repository source context', () => {
    const prompt = james.buildJamesPrompt(repositoryItem);

    expect(prompt).toContain('repo-1');
    expect(prompt).toContain('source-1');
    expect(prompt).toContain('Verifiable Credentials Need Operational Trust');
    expect(prompt).toContain('Wallet support is expanding');
  });

  test('James blocks malformed model output', () => {
    const issues = james.validateJamesDraft('Below is a short draft.');

    expect(issues).toContain('LLM article draft too short for Intel acquisition');
    expect(issues).toContain('LLM article draft contains conversational preamble');
  });

  test('James applies mocked article draft when repository item is valid', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: validArticleWithTitle }],
    });

    const result = await james.applyJamesDraft(repositoryItem);

    expect(result.issues).toEqual([]);
    expect(result.title).toBe('Verifiable Credentials Need Operational Trust');
    expect(result.body_md).toMatch(/^## Executive Summary/);
    expect(result.body_md).not.toContain('# Verifiable Credentials Need Operational Trust');
    expect(result.section).toBe('innovation');
    expect(result.source_ids).toEqual(['source-1']);
  });

  test('James candidate query casts mixed priority enums to text', async () => {
    db.pool.query.mockResolvedValueOnce({
      rows: [{
        repository_id: 'repo-threat',
        source_id: 'source-threat',
        source_type: 'threat',
        normalized_data: {},
        title: 'Threat priority candidate',
        category: 'vulnerability',
        summary: 'Threat summary',
        priority: 'immediate',
        source_data: {},
      }],
    });

    const result = await james.getNextIntelArticleCandidate();
    const [sql] = db.pool.query.mock.calls[0];

    expect(sql).toContain('THEN t.priority::text');
    expect(sql).toContain('ELSE i.priority::text');
    expect(result.priority).toBe('immediate');
  });

  test('Jason prompt carries article context and James draft', () => {
    const prompt = jason.buildJasonPrompt(article);

    expect(prompt).toContain('article-1');
    expect(prompt).toContain('Verifiable Credentials Need Operational Trust');
    expect(prompt).toContain('James draft');
    expect(prompt).toContain('innovation');
  });

  test('Jason blocks malformed model output', () => {
    const issues = jason.validateIntelArticleDraft('Here is a short draft.');

    expect(issues).toContain('LLM article draft too short for Intel developmental edit');
    expect(issues).toContain('LLM article draft contains conversational preamble');
  });

  test('Jason applies mocked developmental edit when article is valid', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: validArticle }],
    });

    const result = await jason.applyJasonEdit(article);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Operational Implications');
  });

  test('Rob prompt carries Jason draft and article context', () => {
    const prompt = rob.buildRobPrompt(article);

    expect(prompt).toContain('article-1');
    expect(prompt).toContain('Jason-edited draft');
    expect(prompt).toContain('monthly');
  });

  test('Rob applies mocked EIC review when article is valid', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: validArticle }],
    });

    const result = await rob.applyRobReview(article);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Closing Assessment');
  });

  test('Rob advances EIC-reviewed articles to eic_review so Jeff dispatch fires', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: validArticle }],
    });
    db.getArticleById.mockResolvedValueOnce({ ...article, pipeline_status: 'dev_edit' });
    db.updateTask.mockResolvedValue({});
    db.pool.query.mockResolvedValue({ rows: [{ ...article, body_md: validArticle }] });
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: article.id, from_status: 'dev_edit', to_status: 'eic_review' }),
    });

    await rob.executeRobEICReview({
      id: 'task-rob',
      content_id: article.id,
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/pipeline/articles/${article.id}/status`),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"to_status":"eic_review"'),
      })
    );
  });

  test('Jeff article QA accepts complete Intel article structure', () => {
    const result = jeff.applyArticleQAReview({ ...article, body_md: validArticle });

    expect(result.issues).toEqual([]);
  });

  test('article Markdown normalization removes a duplicated leading title', () => {
    const normalized = normalizeArticleBodyMarkdown(
      '# Verifiable Credentials Need Operational Trust\n\n## Executive Summary\nBody.',
      'Verifiable Credentials Need Operational Trust'
    );

    expect(normalized).toBe('## Executive Summary\nBody.');
  });

  test('article Markdown QA flags duplicate titles and unnumbered recommended actions', () => {
    const issues = validateArticleMarkdown(
      '# Verifiable Credentials Need Operational Trust\n\n## Recommended Actions\nReview identity controls.',
      'Verifiable Credentials Need Operational Trust'
    );

    expect(issues).toContain('body_md repeats the article title as a level-one heading');
    expect(issues).toContain('Recommended Actions must use an ordered Markdown list');
  });

  test('Jeff advances articles from eic_review to qa after QA pass', async () => {
    db.updateTask.mockResolvedValue({});
    db.pool.query.mockResolvedValueOnce({ rows: [{ ...article, pipeline_status: 'eic_review', body_md: validArticle }] });
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: article.id, from_status: 'eic_review', to_status: 'qa' }),
    });

    await jeff.executeJeffArticleQA({
      id: 'task-jeff',
      content_id: article.id,
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/pipeline/articles/${article.id}/status`),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"to_status":"qa"'),
      })
    );
  });

  test('Maya approves articles from qa stage after Jeff handoff', async () => {
    db.getArticleById.mockResolvedValueOnce({ ...article, pipeline_status: 'qa' });
    db.updateTask.mockResolvedValue({});
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: article.id, from_status: 'qa', to_status: 'maya' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: article.id, from_status: 'maya', to_status: 'approved' }),
      });

    await maya.executeMayaApproveArticle({
      id: 'task-maya',
      content_id: article.id,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`/api/pipeline/articles/${article.id}/status`),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"to_status":"maya"'),
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/pipeline/articles/${article.id}/status`),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"to_status":"approved"'),
      })
    );
  });
});
