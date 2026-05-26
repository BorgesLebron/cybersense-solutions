const request = require('supertest');
const app = require('../server'); // Assuming your express app is exported from server.js
const db = require('../db/queries');
const { postAgentStatusToActiveMeeting } = require('../services/meetings');
const jwt = require('jsonwebtoken'); // Import jsonwebtoken
const crypto = require('crypto');

jest.mock('../db/queries', () => ({
  ...jest.requireActual('../db/queries'),
  updateMeetingBriefing: jest.fn(),
  getLatestSnapshot: jest.fn(),
  getLiveMetricsDelta: jest.fn(),
  getPipelineStatus: jest.fn(),
  getActivityFeed: jest.fn(),
  getAgentHealthSummary: jest.fn(),
  getRepositorySummary: jest.fn(),
  listArticlesForPreview: jest.fn(),
  listApprovedBriefingPreviews: jest.fn(),
  listPipelineEvents: jest.fn(),
  getRecentMeeting: jest.fn(),
  getAdminRole: jest.fn(),
  getUserById: jest.fn(),
  getAgentToken: jest.fn(),
  getArticleById: jest.fn(),
  advanceArticleStatus: jest.fn(),
  logPipelineEvent: jest.fn(),
  createTask: jest.fn(),
  getPublishedArticleStats: jest.fn(),
  pool: {
    query: jest.fn(),
  },
  // Removed pool.query mock from here to prevent conflicts
}));

jest.mock('../services/agents', () => ({
  notifyAgents: jest.fn(),
  triggerEscalationCheck: jest.fn(),
}));

jest.mock('../services/scheduler', () => ({
  runJamesArticleCycle: jest.fn(),
  pollJamesTasks: jest.fn(),
}));

jest.mock('../services/jason_runtime', () => ({ pollJasonTasks: jest.fn() }));
jest.mock('../services/rob_runtime', () => ({ pollRobTasks: jest.fn() }));
jest.mock('../services/jeff_runtime', () => ({ pollJeffTasks: jest.fn() }));
jest.mock('../services/maya_runtime', () => ({ pollMayaTasks: jest.fn() }));

describe('Agent Status and Command Center Integration', () => {
  let adminToken;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_JWT_SECRET = 'test_agent_secret';
    process.env.INTERNAL_SECRET = 'test_internal_secret';
    process.env.JWT_SECRET = 'test_jwt_secret';

    adminToken = jwt.sign({ type: 'admin', user_id: 'user-admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    db.getAdminRole.mockResolvedValue({ user_id: 'user-admin', role: 'gm' });
    db.getUserById.mockResolvedValue({ id: 'user-admin', email: 'admin@test.com', tier: 'enterprise' });

    db.getLatestSnapshot.mockResolvedValue({
      total_subscribers: 0,
      paid_subscribers: 0,
      enterprise_accounts: 0,
      mrr_cents: 0,
      open_risks: 0
    });
    db.getLiveMetricsDelta.mockResolvedValue({});
    db.getPipelineStatus.mockResolvedValue([]);
    db.getActivityFeed.mockResolvedValue([]);
    db.getAgentHealthSummary.mockResolvedValue([]);
    db.getRepositorySummary.mockResolvedValue([]);
    db.listArticlesForPreview.mockResolvedValue([]);
    db.listApprovedBriefingPreviews.mockResolvedValue([]);
    db.listPipelineEvents.mockResolvedValue([]);
    db.getRecentMeeting.mockResolvedValue(null);
    db.listArticlesForPreview.mockResolvedValue([]);
    db.getPublishedArticleStats.mockResolvedValue({
      total_published: 0,
      month_to_date: 0,
      avg_publish_hours: 0,
      avg_views: 0,
      threat_count: 0,
      policy_count: 0,
      innovation_count: 0,
      growth_count: 0,
      training_count: 0,
    });
    db.pool.query.mockResolvedValue({ rows: [] });
  });

  // Test case for postAgentStatusToActiveMeeting
  test('should post agent status to active meeting', async () => {
    db.getRecentMeeting.mockResolvedValueOnce({ // Mock getRecentMeeting for this test
      id: 'meeting-123',
      title: 'Daily Sync',
      type: 'operational',
      created_at: new Date()
    });
    db.updateMeetingBriefing.mockResolvedValueOnce({
      id: 'meeting-123',
      department: 'training',
      briefings: { training: { agent: 'Kirby', event: 'TRAINING_BYTE_PUBLISHED' } }
    });

    await postAgentStatusToActiveMeeting('Kirby', 'training', {
      event: 'TRAINING_BYTE_PUBLISHED',
      title: 'New Byte',
      byte_id: 'byte-456'
    });

    expect(db.getRecentMeeting).toHaveBeenCalledWith({ hours: 12 });
    expect(db.updateMeetingBriefing).toHaveBeenCalledWith(
      'meeting-123',
      'training',
      expect.objectContaining({
        agent: 'Kirby',
        event: 'TRAINING_BYTE_PUBLISHED',
        title: 'New Byte',
        byte_id: 'byte-456',
        timestamp: expect.any(String)
      })
    );
  });

  // Test case for /api/admin/command-center/summary endpoint
  test('GET /api/admin/command-center/summary should return meeting data', async () => {
    db.getRecentMeeting.mockResolvedValue({
      id: 'meeting-789',
      title: 'Executive Briefing',
      type: 'management',
      created_at: new Date(),
      briefings: { acquisition: { agent: 'Rick', event: 'THREAT_INGEST_COMPLETE' } }
    });

    const res = await request(app)
      .get('/api/admin/command-center/summary')
      .set('Authorization', `Bearer ${adminToken}`); // Use the generated admin token

    expect(res.statusCode).toEqual(200);
    expect(db.getRecentMeeting).toHaveBeenCalledWith({ hours: 24 });
    expect(res.body.meeting).toBeDefined();
    expect(res.body.meeting.id).toEqual('meeting-789');
    expect(res.body.meeting.title).toEqual('Executive Briefing');
    expect(res.body.meeting.briefings.acquisition.agent).toEqual('Rick');
  });

  test('GET /api/admin/articles/status returns the Articles Report contract', async () => {
    db.listArticlesForPreview.mockResolvedValueOnce([
      {
        id: 'article-1',
        title: 'Ivanti Endpoint Manager Mobile Improper Input Validation',
        slug: 'ivanti-epmm-improper-input-validation',
        type: 'threat',
        stage: 'qa',
        summary: 'Ivanti EPMM has a high-impact validation issue requiring operational attention.',
        updated: '2026-05-19T09:07:30.000Z',
      },
    ]);
    db.getPublishedArticleStats.mockResolvedValueOnce({
      total_published: 10,
      month_to_date: 4,
      avg_publish_hours: 2.5,
      avg_views: 18,
      threat_count: 6,
      policy_count: 1,
      innovation_count: 2,
      growth_count: 1,
      training_count: 0,
    });
    db.pool.query
      .mockResolvedValueOnce({
        rows: [{
          content_id: 'article-1',
          content_title: 'Ivanti Endpoint Manager Mobile Improper Input Validation',
          from_status: 'eic_review',
          to_status: 'qa',
          agent_name: 'Rob',
          notes: 'EIC review complete',
          created_at: '2026-05-19T09:07:30.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          content_id: 'article-1',
          agent_name: 'Jeff',
          task_type: 'qa_article',
          status: 'queued',
          error_message: null,
          started_at: '2026-05-19T09:07:30.000Z',
          completed_at: null,
        }],
      });

    const res = await request(app)
      .get('/api/admin/articles/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.pipeline_summary).toMatchObject({
      total_in_pipeline: 1,
      in_production: 1,
      blocked: 0,
      ready_for_hitl: 0,
      by_stage: expect.objectContaining({ qa: 1 }),
    });
    expect(res.body.published_stats).toMatchObject({
      total: 10,
      month_to_date: 4,
      avg_publish_hours: 2.5,
      avg_views: 18,
    });
    expect(res.body.articles[0]).toMatchObject({
      id: 'article-1',
      section: 'threat',
      pipeline_status: 'qa',
      stage: 'QA review',
      owner: 'Jeff',
      next_owner: 'Maya',
      stage_index: 4,
      stage_total: 7,
      progress_pct: 57,
      status_label: 'In production',
      datetime_group: '202605190907',
      public_url: '/intel/article.html?slug=ivanti-epmm-improper-input-validation',
      current_task: expect.objectContaining({
        agent_name: 'Jeff',
        task_type: 'qa_article',
        status: 'queued',
      }),
    });
    expect(res.body.events[0]).toMatchObject({
      content_id: 'article-1',
      to_status: 'qa',
      agent_name: 'Rob',
    });
    expect(res.body.generated_at).toEqual(expect.any(String));
  });

  test('POST /api/admin/trigger/article-james runs the guarded James article cycle', async () => {
    const scheduler = require('../services/scheduler');
    scheduler.runJamesArticleCycle.mockResolvedValueOnce();
    scheduler.pollJamesTasks.mockResolvedValueOnce();

    const res = await request(app)
      .post('/api/admin/trigger/article-james')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(scheduler.runJamesArticleCycle).toHaveBeenCalledTimes(1);
    expect(scheduler.pollJamesTasks).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      triggered: true,
      agent: 'James',
    });
  });

  test('POST /api/admin/trigger/article-jason refreshes stale article tasks before polling', async () => {
    const { pollJasonTasks } = require('../services/jason_runtime');
    db.pool.query.mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'task-1' }, { id: 'task-2' }] });
    pollJasonTasks.mockResolvedValueOnce();

    const res = await request(app)
      .post('/api/admin/trigger/article-jason')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(db.pool.query).toHaveBeenCalledWith(expect.stringContaining("t.agent_name = $1"), ['Jason', 'dev_edit', ['draft']]);
    expect(pollJasonTasks).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      triggered: true,
      agent: 'Jason',
      refreshed: 2,
    });
  });

  test('PATCH /api/pipeline/articles/:id/status dispatches Rob after Jason reaches dev_edit', async () => {
    const agentToken = jwt.sign(
      { type: 'agent', agent_name: 'Jason', agent_team: 'intel' },
      process.env.AGENT_JWT_SECRET,
      { expiresIn: '1h' }
    );
    db.getAgentToken.mockResolvedValueOnce({
      token_hash: crypto.createHash('sha256').update(agentToken).digest('hex'),
    });
    db.getArticleById.mockResolvedValueOnce({
      id: 'article-1',
      title: 'GlassWorm Campaign',
      pipeline_status: 'draft',
      qa_passed_at: null,
      maya_approved_at: null,
    });
    db.advanceArticleStatus.mockResolvedValueOnce({
      id: 'article-1',
      pipeline_status: 'dev_edit',
      updated_at: '2026-05-21T23:00:00.000Z',
    });
    db.logPipelineEvent.mockResolvedValueOnce({});
    db.createTask.mockResolvedValueOnce({ id: 'task-rob' });

    const res = await request(app)
      .patch('/api/pipeline/articles/article-1/status')
      .set('Authorization', `Agent ${agentToken}`)
      .send({
        to_status: 'dev_edit',
        agent_name: 'Jason',
        notes: 'Developmental edit complete.',
      });

    expect(res.statusCode).toEqual(200);
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agent_name: 'Rob',
      task_type: 'eic_review_article',
      content_type: 'article',
      content_id: 'article-1',
    }));
  });
});
