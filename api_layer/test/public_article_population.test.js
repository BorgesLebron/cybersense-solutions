jest.mock('../db/queries', () => ({
  createIntelItem: jest.fn(),
  processIntoRepository: jest.fn(),
  logPipelineEvent: jest.fn(),
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

const db = require('../db/queries');
const {
  slugFor,
  readTimeMin,
  ensurePublishedArticle,
} = require('../populate_public_intel_articles');

describe('public Intel article population', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes titles into public article slugs', () => {
    expect(slugFor('NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control'))
      .toBe('nist-csf-20-makes-governance-a-daily-cybersecurity-control');
  });

  test('calculates a minimum one-minute read time', () => {
    expect(readTimeMin('# Short article')).toBe(1);
  });

  test('inserts and publishes a missing policy article with source linkage', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', framework: 'NIST Cybersecurity Framework', version: '2.0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'article-1',
          title: 'NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control',
          slug: 'nist-csf-20-makes-governance-a-daily-cybersecurity-control',
          section: 'policy',
          pipeline_status: 'published',
          published_at: '2026-05-20T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    db.logPipelineEvent.mockResolvedValueOnce({});

    const article = await ensurePublishedArticle({
      title: 'NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control',
      section: 'policy',
      access_tier: 'freemium',
      policy_framework: 'NIST Cybersecurity Framework',
      policy_version: '2.0',
      body_md: '# NIST CSF 2.0\n\nGovernance matters.',
    });

    expect(article).toMatchObject({
      id: 'article-1',
      section: 'policy',
      pipeline_status: 'published',
      existing: false,
    });
    expect(db.pool.query).toHaveBeenCalledWith(
      'UPDATE policy_updates SET article_id=$1 WHERE id = ANY($2::uuid[])',
      ['article-1', ['policy-1']]
    );
    expect(db.logPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      content_type: 'article',
      content_id: 'article-1',
      agent_name: 'Gwen',
      to_status: 'published',
    }));
  });

  test('publishes an existing non-published article without duplicating it', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', framework: 'NIST Cybersecurity Framework', version: '2.0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'article-1',
          title: 'NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control',
          slug: 'nist-csf-20-makes-governance-a-daily-cybersecurity-control',
          section: 'policy',
          pipeline_status: 'approved',
          published_at: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const article = await ensurePublishedArticle({
      title: 'NIST CSF 2.0 Makes Governance a Daily Cybersecurity Control',
      section: 'policy',
      access_tier: 'freemium',
      policy_framework: 'NIST Cybersecurity Framework',
      policy_version: '2.0',
      body_md: '# NIST CSF 2.0\n\nGovernance matters.',
    });

    expect(article).toMatchObject({
      id: 'article-1',
      pipeline_status: 'published',
      existing: true,
    });
    expect(db.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET pipeline_status='published'"),
      ['article-1']
    );
    expect(db.logPipelineEvent).not.toHaveBeenCalled();
  });
});
