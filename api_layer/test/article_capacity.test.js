jest.mock('../db/queries', () => ({
  createTask: jest.fn(),
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../services/agents', () => ({
  checkAwarenessPipelineHealth: jest.fn(),
  notifyAgents: jest.fn(),
}));

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(() => Promise.resolve()),
}));

jest.mock('../services/ruth_runtime', () => ({ pollRuthTasks: jest.fn() }));
jest.mock('../services/peter_runtime', () => ({ pollPeterTasks: jest.fn() }));
jest.mock('../services/ed_runtime', () => ({ pollEdTasks: jest.fn() }));
jest.mock('../services/james_runtime', () => ({ pollJamesTasks: jest.fn() }));
jest.mock('../services/jason_runtime', () => ({ pollJasonTasks: jest.fn() }));
jest.mock('../services/rob_runtime', () => ({ pollRobTasks: jest.fn() }));
jest.mock('../services/jeff_runtime', () => ({ pollJeffTasks: jest.fn() }));
jest.mock('../services/lucy_runtime', () => ({ pollLucyTasks: jest.fn() }));
jest.mock('../services/rick_runtime', () => ({ pollRickTasks: jest.fn() }));
jest.mock('../services/ivan_charlie_runtime', () => ({ pollIvanCharlieTasks: jest.fn() }));
jest.mock('../services/barbara_runtime', () => ({ pollBarbaraTasks: jest.fn() }));
jest.mock('../services/kirby_runtime', () => ({ pollKirbyTasks: jest.fn() }));
jest.mock('../services/maya_runtime', () => ({ pollMayaTasks: jest.fn() }));
jest.mock('../services/sendgrid', () => ({ sendBriefingEmail: jest.fn() }));

const db = require('../db/queries');
const { notifyAgents } = require('../services/agents');
const {
  runJamesArticleCycle,
  getArticlePipelineCapacityLimit,
  ACTIVE_ARTICLE_STATUSES,
} = require('../services/scheduler');

describe('James article pipeline capacity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARTICLE_PIPELINE_CAPACITY_LIMIT;
  });

  test('uses a configurable capacity limit with a safe default', () => {
    expect(getArticlePipelineCapacityLimit()).toBe(5);

    process.env.ARTICLE_PIPELINE_CAPACITY_LIMIT = '7';
    expect(getArticlePipelineCapacityLimit()).toBe(7);

    process.env.ARTICLE_PIPELINE_CAPACITY_LIMIT = '0';
    expect(getArticlePipelineCapacityLimit()).toBe(5);
  });

  test('counts only active editorial article statuses against capacity', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce((sql, params) => {
        expect(params).toEqual([ACTIVE_ARTICLE_STATUSES]);
        return Promise.resolve({ rows: [{ count: 4 }] });
      })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] });
    db.createTask.mockResolvedValueOnce({ id: 'task-james' });

    await runJamesArticleCycle();

    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agent_name: 'James',
      task_type: 'draft_article',
      content_type: 'system',
    }));
    expect(notifyAgents).toHaveBeenCalledWith(['James'], expect.objectContaining({
      type: 'INTEL_ARTICLE_DRAFT_REQUESTED',
      task_id: 'task-james',
    }));
  });

  test('skips when active editorial articles reach capacity', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    await runJamesArticleCycle();

    expect(db.createTask).not.toHaveBeenCalled();
    expect(notifyAgents).not.toHaveBeenCalledWith(['James'], expect.any(Object));
  });
});
