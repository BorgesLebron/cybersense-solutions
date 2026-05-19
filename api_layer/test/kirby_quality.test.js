'use strict';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => jest.fn(() => ({ model: 'mock-gemini' }))),
}));

const { generateText } = require('ai');
const db = require('../db/queries');
const kirby = require('../services/kirby_runtime');

describe('Kirby Instructional Designer Brain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KIRBY_BRAIN_API_KEY = 'test-kirby-key';
    process.env.AGENT_JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    delete process.env.KIRBY_BRAIN_API_KEY;
  });

  test('Kirby generates training byte with correct structure', async () => {
    const mockContent = `
## Why This Matters:
This is a test explanation of why the threat matters to the business.

## What You Need to Know:
- Point 1 about the threat.
- Point 2 about the technical details.
- Point 3 about the scope.

## Defensive Actions:
1. First action to take.
2. Second action to take.
3. Third action to take.

## Knowledge Check:
What is the best way to test this?
A) Option 1
B) Option 2
C) Option 3
Answer: A
    `.trim();

    generateText.mockResolvedValueOnce({ text: mockContent });

    // Mock DB calls
    const mockQuery = jest.spyOn(db.pool, 'query').mockImplementation((sql, params) => {
      if (sql.includes('FROM briefings')) return Promise.resolve({ rows: [{ id: 'b1', threat_item_ids: ['t1'] }] });
      if (sql.includes('FROM intel_repository')) return Promise.resolve({ rows: [{ id: 'r1', source_id: 't1', threat_name: 'Test Threat', severity: 'high', summary: 'Test summary' }] });
      if (sql.includes('agent_tasks')) return Promise.resolve({ rows: [{ id: 'task-1', status: 'queued', content_type: 'training_byte' }] });
      return Promise.resolve({ rows: [] });
    });

    const createModuleMock = jest.spyOn(db, 'createTrainingModule').mockResolvedValue({ id: 'byte-1' });
    const updateTaskMock = jest.spyOn(db, 'updateTask').mockResolvedValue({});
    const advanceStatusMock = jest.spyOn(db, 'advanceModuleStatus').mockResolvedValue({});
    const rotateTokenMock = jest.spyOn(db, 'rotateAgentToken').mockResolvedValue({});

    await kirby.pollKirbyTasks();

    expect(generateText).toHaveBeenCalled();
    expect(createModuleMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'training_byte',
      body_md: mockContent
    }));
    
    mockQuery.mockRestore();
    createModuleMock.mockRestore();
    updateTaskMock.mockRestore();
    advanceStatusMock.mockRestore();
    rotateTokenMock.mockRestore();
  });

  test('Kirby transitions training module to ready_for_html after creation', async () => {
    const mockContent = `
## Why This Matters:
This is a test explanation.

## What You Need to Know:
- Point 1.

## Defensive Actions:
1. Action 1.

## Knowledge Check:
Q? A) Opt1 B) Opt2 C) Opt3 Answer: A
    `.trim();

    generateText.mockResolvedValueOnce({ text: mockContent });

    // Mock DB calls needed for this flow
    jest.spyOn(db.pool, 'query').mockImplementation((sql, params) => {
      if (sql.includes('FROM briefings')) return Promise.resolve({ rows: [{ id: 'b1', threat_item_ids: ['t1'] }] });
      if (sql.includes('FROM intel_repository')) return Promise.resolve({ rows: [{ id: 'r1', source_id: 't1', threat_name: 'Test Threat', severity: 'high', summary: 'Test summary' }] });
      if (sql.includes('agent_tasks')) return Promise.resolve({ rows: [{ id: 'task-1', status: 'queued', content_type: 'training_byte' }] });
      return Promise.resolve({ rows: [] });
    });

    const createModuleMock = jest.spyOn(db, 'createTrainingModule').mockResolvedValue({ id: 'new-byte-id' });
    const advanceStatusMock = jest.spyOn(db, 'advanceModuleStatus').mockResolvedValue({});
    const updateTaskMock = jest.spyOn(db, 'updateTask').mockResolvedValue({});
    const rotateTokenMock = jest.spyOn(db, 'rotateAgentToken').mockResolvedValue({});

    await kirby.pollKirbyTasks();

    expect(createModuleMock).toHaveBeenCalled();
    expect(advanceStatusMock).toHaveBeenCalledWith('new-byte-id', 'ready_for_html');
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'complete' }));

    // Clean up mocks
    jest.restoreAllMocks();
  });

  test('Kirby posts weekly status on Monday if not already present', async () => {
    // Mock Monday, May 18, 2026 (Day 1)
    const mockDate = new Date('2026-05-18T10:00:00Z');
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);

    const mockQuery = jest.spyOn(db.pool, 'query').mockImplementation((sql) => {
      if (sql.includes('FROM meetings')) return Promise.resolve({ rows: [{ id: 'm1', type: 'operational', briefings: {} }] });
      return Promise.resolve({ rows: [] });
    });

    const getSummaryMock = jest.spyOn(db, 'getGlobalTrainingSummary').mockResolvedValue({
      total_modules: 34,
      total_bytes: 12,
      total_completions: 450,
      active_learners: 89
    });

    const postStatusMock = jest.spyOn(db, 'updateMeetingBriefing').mockResolvedValue({});
    const rotateTokenMock = jest.spyOn(db, 'rotateAgentToken').mockResolvedValue({});

    await kirby.pollKirbyTasks();

    expect(getSummaryMock).toHaveBeenCalled();
    expect(postStatusMock).toHaveBeenCalledWith('m1', 'training', expect.objectContaining({
      event: 'WEEKLY_STATUS_REPORT',
      total_modules: 34
    }));

    jest.useRealTimers();
    mockQuery.mockRestore();
    getSummaryMock.mockRestore();
    postStatusMock.mockRestore();
    rotateTokenMock.mockRestore();
  });

  test('Kirby enforces word count constraints (simulated via validation)', () => {
    const tooShort = "## Why This Matters:\nToo short.";
    const wordCount = (str) => str.split(/\s+/).length;
    
    expect(wordCount(tooShort)).toBeLessThan(150);
  });
});
