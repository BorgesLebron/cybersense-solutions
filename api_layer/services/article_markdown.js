function canonicalTitle(value) {
  return String(value || '')
    .replace(/[*_`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeArticleBodyMarkdown(bodyMd, title) {
  const body = String(bodyMd || '').replace(/\r\n?/g, '\n').trim();
  const heading = body.match(/^#\s+(.+?)\s*(?:\n+|$)/);
  if (!heading) return body;

  if (canonicalTitle(heading[1]) !== canonicalTitle(title)) return body;
  return body.slice(heading[0].length).trimStart();
}

function recommendedActionsBlock(bodyMd) {
  const body = String(bodyMd || '').replace(/\r\n?/g, '\n');
  const match = body.match(
    /^##\s+Recommended Actions\s*\n([\s\S]*?)(?=^##\s+|\s*$)/mi
  );
  return match?.[1]?.trim() || '';
}

function validateArticleMarkdown(bodyMd, title) {
  const issues = [];
  const body = String(bodyMd || '').replace(/\r\n?/g, '\n').trim();
  const leadingHeading = body.match(/^#\s+(.+?)\s*(?:\n+|$)/);

  if (leadingHeading && canonicalTitle(leadingHeading[1]) === canonicalTitle(title)) {
    issues.push('body_md repeats the article title as a level-one heading');
  }

  const actions = recommendedActionsBlock(body);
  if (actions && !/^\d+\.\s+\S+/m.test(actions)) {
    issues.push('Recommended Actions must use an ordered Markdown list');
  }

  return issues;
}

module.exports = {
  canonicalTitle,
  normalizeArticleBodyMarkdown,
  recommendedActionsBlock,
  validateArticleMarkdown,
};
