jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => jest.fn(() => ({ model: 'mock-gemini' }))),
}));

const { generateText } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const peter = require('../services/peter_runtime');
const ed = require('../services/ed_runtime');

const validEdition = `
# The Infrastructure Vulnerability Surge

## Opening Brief
Opening context that frames the threat landscape for institutional leaders and practitioners with disciplined language.

## Opening Notes
Additional continuity for the daily brief and its resilient workforce theme.

## Situational Awareness
Three threat actor developments are covered with proportional detail and workforce relevance.

## Training Byte
Practical mitigation guidance explains session integrity, privilege limits, and operational discipline.

## Career Development
The professional growth item connects identity governance skill development with measurable workforce value.

## Modernization and AI Insight
Two modernization items explain strategic implications for AI-enabled security operations and enterprise risk.

## Final Thought
Bridging the gap requires continuous validation, identity-aware controls, and a resilient workforce.
`.repeat(2);

const briefing = {
  id: 'briefing-1',
  edition_date: '2026-05-19',
  subject_line: 'Infrastructure Vulnerability Surge',
  body_md: 'Ruth outline '.repeat(20),
  threat_item_ids: ['t1', 't2', 't3'],
  innovation_item_ids: ['i1', 'i2'],
  growth_item_id: 'g1',
  training_byte_id: 'tb1',
};

describe('Peter and Ed editorial brains', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EDITORIAL_BRAIN_API_KEY = 'test-editorial-key';
  });

  afterEach(() => {
    delete process.env.EDITORIAL_BRAIN_API_KEY;
  });

  test('Peter prompt carries edition context and Ruth draft', () => {
    const prompt = peter.buildPeterPrompt(briefing);

    expect(prompt).toContain('2026-05-19');
    expect(prompt).toContain('Infrastructure Vulnerability Surge');
    expect(prompt).toContain('t1, t2, t3');
    expect(prompt).toContain('Ruth draft or outline');
  });

  test('Peter blocks malformed model output', () => {
    const issues = peter.validateEditedDraft('Here is a short draft.');

    expect(issues).toContain('LLM draft too short for publication-quality developmental edit');
    expect(issues).toContain('LLM draft contains conversational preamble');
  });

  test('Peter applies mocked developmental edit when composition is valid', async () => {
    generateText.mockResolvedValueOnce({ text: validEdition });

    const result = await peter.applyDevEdit(briefing);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Situational Awareness');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'test-editorial-key' });
  });

  test('Ed prompt carries Peter draft and lineage context', () => {
    const prompt = ed.buildEdPrompt(briefing);

    expect(prompt).toContain('Peter draft');
    expect(prompt).toContain('Threat source IDs: t1, t2, t3');
    expect(prompt).toContain('Training byte ID: tb1');
  });

  test('Ed applies mocked final review when composition is valid', async () => {
    generateText.mockResolvedValueOnce({ text: validEdition });

    const result = await ed.applyEICReview(briefing);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Final Thought');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'test-editorial-key' });
  });
});
