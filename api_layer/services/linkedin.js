'use strict';

const LINKEDIN_API = 'https://api.linkedin.com/rest';
const PERSON_URN = process.env.LINKEDIN_PERSON_URN;
const ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;

async function postToLinkedIn({ post_body, briefing_id }) {
  if (!ACCESS_TOKEN || !PERSON_URN) {
    throw new Error('LinkedIn credentials not configured');
  }

  const payload = {
    author: PERSON_URN,
    commentary: post_body,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };

  const res = await fetch(`${LINKEDIN_API}/posts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202501'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${error}`);
  }

  // LinkedIn returns the post URN in the header
  const postUrn = res.headers.get('x-restli-id');
  return { post_urn: postUrn, status: res.status };
}

module.exports = { postToLinkedIn };