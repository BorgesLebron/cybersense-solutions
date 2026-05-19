jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => jest.fn(() => ({ model: 'mock-gemini' }))),
}));

const { generateText } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const jason = require('../services/jason_runtime');
const rob = require('../services/rob_runtime');

const validArticle = `
# Verifiable Credentials Need Operational Trust

## Executive Summary
Recent digital identity activity shows that wallet support alone does not create durable institutional trust. Security leaders need governance, issuer verification, lifecycle controls, and practical operating models before credentials can support sensitive workflows.

## What Happened
Several public and private sector programs are expanding verifiable credential pilots for identity, workforce, and compliance use cases. The technology is maturing, but deployment quality remains uneven across issuers, relying parties, and verification surfaces.

## Why It Matters
For practitioners, the relevant risk is not whether a credential can be stored in a wallet. The operational question is whether the credential can be trusted, revoked, audited, and interpreted consistently across real business processes.

## Operational Implications
Organizations adopting credentials should define issuer assurance levels, verification policy, monitoring expectations, and exception handling. Without those controls, wallet adoption may increase complexity while leaving accountability unclear.

## Recommended Actions
Security and identity teams should map credential use cases to risk tiers, validate revocation mechanics, document relying-party obligations, and test user recovery paths before expanding production use.

## Closing Assessment
Verifiable credentials remain promising, but trust is an operating model rather than a feature. Programs that treat governance, verification, and lifecycle management as first-class requirements will be better positioned for resilient adoption.
`.repeat(2);

const article = {
  id: 'article-1',
  title: 'Verifiable Credentials Need Operational Trust',
  section: 'innovation',
  access_tier: 'monthly',
  body_md: 'James draft about verifiable credentials, wallet support, issuer assurance, and operational trust. '.repeat(12),
};

describe('Jason and Rob Intel editorial brains', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTEL_EDITORIAL_BRAIN_API_KEY = 'test-intel-editorial-key';
  });

  afterEach(() => {
    delete process.env.INTEL_EDITORIAL_BRAIN_API_KEY;
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
    generateText.mockResolvedValueOnce({ text: validArticle });

    const result = await jason.applyJasonEdit(article);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Operational Implications');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'test-intel-editorial-key' });
  });

  test('Rob prompt carries Jason draft and article context', () => {
    const prompt = rob.buildRobPrompt(article);

    expect(prompt).toContain('article-1');
    expect(prompt).toContain('Jason-edited draft');
    expect(prompt).toContain('monthly');
  });

  test('Rob applies mocked EIC review when article is valid', async () => {
    generateText.mockResolvedValueOnce({ text: validArticle });

    const result = await rob.applyRobReview(article);

    expect(result.issues).toEqual([]);
    expect(result.body_md).toContain('Closing Assessment');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'test-intel-editorial-key' });
  });
});
