'use strict';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_REPO = process.env.GITHUB_CONTENT_REPO || 'BorgesLebron/cybersense-solutions';

async function commitBufferToGithub({
  filePath,
  content,
  commitMessage,
  token,
  userAgent = 'cybersense-content-runtime',
}) {
  if (!token) throw new Error('GitHub content token not configured');
  if (!filePath) throw new Error('GitHub content file path is required');
  if (!Buffer.isBuffer(content)) throw new Error('GitHub content must be a Buffer');

  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };

  let sha;
  const getRes = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (getRes.ok) {
    sha = (await getRes.json()).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET failed: ${getRes.status}`);
  }

  const putRes = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: commitMessage,
      content: content.toString('base64'),
      ...(sha ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => '');
    throw new Error(`GitHub commit failed: ${putRes.status} - ${detail.slice(0, 200)}`);
  }

  return putRes.json();
}

module.exports = { commitBufferToGithub };
