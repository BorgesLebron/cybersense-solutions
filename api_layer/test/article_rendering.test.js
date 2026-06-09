const fs = require('fs');
const path = require('path');

function loadPublicArticleRenderer() {
  const articlePath = path.resolve(__dirname, '../../intel/article.html');
  const html = fs.readFileSync(articlePath, 'utf8');
  const start = html.indexOf('function escapeHtml');
  const end = html.indexOf('function sectionLabel');

  if (start < 0 || end < 0) {
    throw new Error('Unable to locate public article Markdown renderer');
  }

  const source = html.slice(start, end);
  return new Function(`${source}; return { mdToHtml, renderArticleBanner };`)();
}

describe('public Intel article Markdown rendering', () => {
  const { mdToHtml, renderArticleBanner } = loadPublicArticleRenderer();

  test('removes a duplicated body title already rendered in the article header', () => {
    const title = 'Field-Based Plasma Research';
    const markdown = `# ${title}

## Executive Summary
Research context.`;

    const rendered = mdToHtml(markdown, title);

    expect(rendered).not.toContain(`# ${title}`);
    expect(rendered).not.toContain(`<h2>${title}</h2>`);
    expect(rendered).toContain('<h2>Executive Summary</h2>');
  });

  test('keeps blank-line-separated recommended actions in one ordered list', () => {
    const markdown = `## Recommended Actions

1. First action.

2. Second action.

3. Third action.

4. Fourth action.

5. Fifth action.`;

    const rendered = mdToHtml(markdown, 'Operational Article');

    expect(rendered.match(/<ol>/g)).toHaveLength(1);
    expect(rendered.match(/<li>/g)).toHaveLength(5);
    expect(rendered).toContain('<li>First action.</li>');
    expect(rendered).toContain('<li>Fifth action.</li>');
  });

  test('renders a ready article banner with its committed image and alt text', () => {
    const rendered = renderArticleBanner({
      title: 'When the Source Goes Dark',
      banner_status: 'ready',
      banner_image_url: 'https://cybersense.solutions/headlineBanner/source-goes-dark.png?v=2',
      banner_alt_text: 'Illustrated article banner',
    });

    expect(rendered).toContain('class="article-banner"');
    expect(rendered).toContain('src="https://cybersense.solutions/headlineBanner/source-goes-dark.png?v=2"');
    expect(rendered).toContain('alt="Illustrated article banner"');
    expect(rendered).toContain('width="1200"');
    expect(rendered).toContain('height="630"');
  });

  test.each(['pending', 'generating', 'failed', 'skipped', null])(
    'omits banners that are not ready (%s)',
    (bannerStatus) => {
      expect(renderArticleBanner({
        title: 'Legacy Article',
        banner_status: bannerStatus,
        banner_image_url: 'https://example.com/banner.png',
      })).toBe('');
    },
  );
});
