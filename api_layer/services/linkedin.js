'use strict';

const LINKEDIN_API = 'https://api.linkedin.com/rest';
const PERSON_URN = process.env.LINKEDIN_PERSON_URN;

let currentAccessToken = process.env.LINKEDIN_ACCESS_TOKEN;

async function refreshLinkedInToken() {
  const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REFRESH_TOKEN } = process.env;
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET || !LINKEDIN_REFRESH_TOKEN) {
    throw new Error('LinkedIn OAuth credentials not fully configured (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN required)');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: LINKEDIN_REFRESH_TOKEN,
    client_id: LINKEDIN_CLIENT_ID,
    client_secret: LINKEDIN_CLIENT_SECRET,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn token refresh failed ${res.status}: ${error}`);
  }

  const data = await res.json();
  currentAccessToken = data.access_token;
  return { access_token: data.access_token, expires_in: data.expires_in };
}

async function postToLinkedIn({ post_body, briefing_id }) {
  if (!currentAccessToken || !PERSON_URN) {
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
      'Authorization': `Bearer ${currentAccessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202601'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${error}`);
  }

  const postUrn = res.headers.get('x-restli-id');
  return { post_urn: postUrn, status: res.status };
}

module.exports = { postToLinkedIn, refreshLinkedInToken };
