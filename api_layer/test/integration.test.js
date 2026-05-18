const request = require('supertest');
const app = require('../server'); // Assuming your express app is exported from server.js
const db = require('../db/queries');
const { postAgentStatusToActiveMeeting } = require('../services/meetings');
const jwt = require('jsonwebtoken'); // Import jsonwebtoken

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
  // Removed pool.query mock from here to prevent conflicts
}));

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
});
