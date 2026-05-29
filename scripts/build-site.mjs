import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, parseFeed, readJson, slugify } from './lib/feed-utils.mjs';
import { mergeArticles, pruneArticles, splitArchive } from './lib/article-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const dataDir = path.join(distDir, 'data');
const stateDir = path.join(rootDir, 'data', 'state');
const stateFile = path.join(stateDir, 'articles.json');
const offline = process.env.NEWS_OFFLINE_FIXTURES === '1';

const site = await readJson(path.join(rootDir, 'config', 'site.json'));
const sources = await readJson(path.join(rootDir, 'config', 'sources.json'));

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'HermesSignalBot/0.1 (+https://example.invalid)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(article) {
  if (!article.summary) return '';
  const sentence = article.summary.split(/(?<=[.!?])\s+/)[0] || article.summary;
  return sentence.slice(0, 220).trim();
}

function matchesSource(item, source) {
  const terms = source.matchAny || [];
  if (terms.length === 0) return true;
  return getSourceMatchScore(item, source) > 0;
}

function getSourceMatchScore(item, source) {
  const terms = source.matchAny || [];
  const titleHaystack = `${item.title}`.toLowerCase();
  const bodyHaystack = `${item.summary} ${item.category}`.toLowerCase();
  return terms.reduce((score, term) => {
    const normalized = term.toLowerCase();
    const titleScore = titleHaystack.includes(normalized) ? 3 : 0;
    const bodyScore = bodyHaystack.includes(normalized) ? 1 : 0;
    return score + titleScore + bodyScore;
  }, 0);
}

function countTermOccurrences(haystack, term) {
  if (!term) return 0;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = haystack.match(new RegExp(escaped, 'gi'));
  return matches ? matches.length : 0;
}

function getRecencyBoost(article) {
  const published = new Date(article.publishedAt).getTime();
  if (Number.isNaN(published)) return 0;
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  if (ageHours <= 12) return 8;
  if (ageHours <= 24) return 6;
  if (ageHours <= 48) return 4;
  if (ageHours <= 72) return 2;
  return 0;
}

function scoreArticle(article) {
  const haystack = `${article.title} ${article.summary} ${article.tags.join(' ')} ${article.category}`.toLowerCase();
  const interestScore = Object.entries(site.interestWeights).reduce((score, [term, weight]) => {
    const matches = countTermOccurrences(haystack, term);
    return matches > 0 ? score + weight + (matches - 1) * Math.ceil(weight / 3) : score;
  }, 5);
  const titleBoost = Object.keys(site.interestWeights).reduce((score, term) => {
    return article.title.toLowerCase().includes(term) ? score + 2 : score;
  }, 0);
  return interestScore + titleBoost + (article.sourceMatchScore || 0) + getRecencyBoost(article);
}

function dedupeArticles(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${normalizeUrl(item.link)}::${slugify(item.title)}`;
    const current = byKey.get(key);
    if (!current || item.sourceMatchScore > current.sourceMatchScore || (item.sourceMatchScore === current.sourceMatchScore && item.score > current.score)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: site.timezone
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderCards(items) {
  return items.map((item) => `
    <article class="card">
      <p class="meta">${item.category} · ${item.sourceName} · ${formatDate(item.publishedAt)}</p>
      <h3><a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h3>
      <p>${escapeHtml(item.blurb)}</p>
      <div class="chips">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <p class="score">Relevanz ${item.score}</p>
    </article>
  `).join('\n');
}

function renderSectionCards(items) {
  if (items.length === 0) {
    return `<p class="empty">Noch keine passenden Artikel im aktuellen Speicherstand.</p>`;
  }

  return `<div class="grid compact-grid">
    ${renderCards(items)}
  </div>`;
}

function renderSourceStatus(statuses) {
  return statuses.map((status) => `
    <li class="${status.ok ? 'ok' : 'error'}">
      <strong>${escapeHtml(status.title)}</strong> · ${status.ok ? `${status.count} Artikel` : `Fehler: ${escapeHtml(status.error)}`}
    </li>
  `).join('\n');
}

function escapeHtml(input = '') {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTopicOverview(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => `<span>${escapeHtml(label)} ${count}</span>`)
    .join('');
}

function matchesFeaturedSection(article, section) {
  const haystack = `${article.title} ${article.summary} ${article.tags.join(' ')} ${article.category}`.toLowerCase();
  return (section.keywords || []).some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function buildFeaturedSections(items) {
  return (site.featuredSections || []).map((section) => {
    const matches = items.filter((item) => matchesFeaturedSection(item, section)).slice(0, section.maxItems || 6);
    return {
      ...section,
      items: matches
    };
  });
}

function renderFeaturedSections(items) {
  const sections = buildFeaturedSections(items);
  if (sections.length === 0) return '';

  return sections.map((section) => `
    <section class="panel">
      <div class="panel-head stacked">
        <div>
          <p class="eyebrow">Fokus</p>
          <h2>${escapeHtml(section.title)}</h2>
        </div>
        <p class="intro">${escapeHtml(section.description || '')}</p>
      </div>
      ${renderSectionCards(section.items)}
    </section>
  `).join('\n');
}

function renderIndex({ live, archived, generatedAt, sourceStatuses, coverage }) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(site.siteName)}</title>
  <meta name="description" content="${escapeHtml(site.siteDescription)}">
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Personal News Radar</p>
      <h1>${escapeHtml(site.siteName)}</h1>
      <p class="intro">${escapeHtml(site.siteDescription)}</p>
      <div class="hero-stats">
        <span>${live.length} aktuelle Artikel</span>
        <span>${archived.length} im Archiv</span>
        <span>Update ${formatDate(generatedAt)}</span>
      </div>
      <div class="hero-stats topic-row">
        ${renderTopicOverview(live)}
      </div>
    </section>

    <section class="panel">
      <h2>Jetzt relevant</h2>
      <div class="grid">
        ${renderCards(live.slice(0, 12))}
      </div>
    </section>

    ${renderFeaturedSections(live)}

    <section class="panel">
      <h2>Archiv-Regel</h2>
      <p class="intro">Neue Artikel bleiben ${site.archiveAfterDays} Tage auf der Startseite, wandern danach automatisch ins Archiv und werden nach ${site.dropAfterDays} Tagen aus dem lokalen Speicher entfernt. Die gespeicherte Historie wird bei jedem Build fortgeschrieben.</p>
      <div class="hero-stats">
        <span>${coverage.totalStored} gespeicherte Artikel</span>
        <span>${coverage.liveSources} aktive Feeds</span>
        <span>${coverage.failedSources} Feed-Fehler</span>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Archiv</h2>
        <a href="./archive.html">Alle archivierten Artikel</a>
      </div>
      <div class="grid compact">
        ${renderCards(archived.slice(0, 8))}
      </div>
    </section>

    <section class="panel">
      <h2>Feed-Status</h2>
      <ul class="status-list">
        ${renderSourceStatus(sourceStatuses)}
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function renderArchive({ archived, generatedAt }) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Archiv · ${escapeHtml(site.siteName)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="shell">
    <section class="hero small">
      <p class="eyebrow">Archivansicht</p>
      <h1>Fruehere Meldungen</h1>
      <p class="intro">Artikel wandern nach ${site.archiveAfterDays} Tagen automatisch aus der Startseite ins Archiv.</p>
      <div class="hero-stats">
        <span>${archived.length} archivierte Artikel</span>
        <span>Stand ${formatDate(generatedAt)}</span>
        <a href="./index.html">Zur Startseite</a>
      </div>
    </section>
    <section class="panel">
      <div class="grid">
        ${renderCards(archived)}
      </div>
    </section>
  </main>
</body>
</html>`;
}

async function loadSource(source) {
  try {
    const xml = offline
      ? await readFile(path.join(rootDir, 'data', 'fixtures', source.fixture), 'utf8')
      : await fetchText(source.url);
    const items = parseFeed(xml, source).map((item) => ({
      ...item,
      tags: [...new Set([...(item.tags || []), ...(source.tags || [])])],
      blurb: summarize(item),
      score: 0,
      sourceMatchScore: getSourceMatchScore(item, source)
    })).filter((item) => matchesSource(item, source));
    return {
      ok: true,
      title: source.title,
      count: items.length,
      items
    };
  } catch (error) {
    return {
      ok: false,
      title: source.title,
      count: 0,
      error: error.message,
      items: []
    };
  }
}

async function readExistingState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const sourceResults = await Promise.all(sources.map(loadSource));

const fetchedItems = dedupeArticles(
  sourceResults
    .flatMap((result) => result.items)
    .map((item) => ({ ...item, score: scoreArticle(item) }))
    .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    })
);

const generatedAt = new Date().toISOString();
const existingState = await readExistingState();
const storedItems = pruneArticles(
  mergeArticles(existingState, fetchedItems, generatedAt),
  {
    generatedAt,
    dropAfterDays: site.dropAfterDays,
    maxStoredItems: site.maxStoredItems
  }
).map((item) => ({ ...item, score: scoreArticle(item) }));

const { live, archived } = splitArchive(
  storedItems.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  }),
  site.archiveAfterDays,
  generatedAt
);

const liveItems = live.slice(0, site.maxLiveItems);
const archivedItems = archived.slice(0, site.maxArchiveItems);

await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(stateDir, { recursive: true })
]);

const coverage = {
  totalStored: storedItems.length,
  liveSources: sourceResults.filter((result) => result.ok).length,
  failedSources: sourceResults.filter((result) => !result.ok).length
};

await Promise.all([
  writeFile(path.join(distDir, 'index.html'), renderIndex({
    live: liveItems,
    archived: archivedItems,
    generatedAt,
    sourceStatuses: sourceResults,
    coverage
  })),
  writeFile(path.join(distDir, 'archive.html'), renderArchive({
    archived: archivedItems,
    generatedAt
  })),
  writeFile(path.join(distDir, 'styles.css'), `:root {
  --bg: #f1ede2;
  --panel: #fffdf8;
  --ink: #17211b;
  --muted: #5d675e;
  --accent: #0c6c59;
  --accent-soft: #cfe8dd;
  --warn: #8f3b1b;
  --line: #dad2c4;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(12,108,89,0.18), transparent 28%),
    linear-gradient(180deg, #ebe5d7 0%, var(--bg) 42%, #f5f0e7 100%);
}
a { color: inherit; }
.shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
.hero {
  padding: 32px;
  border: 1px solid var(--line);
  background: linear-gradient(140deg, rgba(255,255,255,0.86), rgba(255,248,232,0.96));
  box-shadow: 0 18px 40px rgba(27, 37, 31, 0.08);
}
.hero.small { padding-bottom: 24px; }
.eyebrow, .meta, .score { font-family: "Courier New", monospace; letter-spacing: 0.04em; text-transform: uppercase; }
.eyebrow { color: var(--accent); font-size: 0.85rem; }
h1, h2, h3 { margin: 0; line-height: 1.05; }
h1 { font-size: clamp(2.2rem, 8vw, 4.8rem); max-width: 10ch; margin-top: 8px; }
h2 { font-size: 1.6rem; margin-bottom: 18px; }
h3 { font-size: 1.3rem; margin: 10px 0; }
.intro { max-width: 65ch; color: var(--muted); font-size: 1.06rem; }
.hero-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
.hero-stats span, .hero-stats a, .chips span {
  border: 1px solid var(--line);
  background: var(--panel);
  padding: 8px 12px;
  text-decoration: none;
}
.panel {
  margin-top: 22px;
  padding: 24px;
  border: 1px solid var(--line);
  background: rgba(255,253,248,0.86);
}
.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: baseline;
}
.panel-head.stacked {
  align-items: start;
  flex-direction: column;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
.compact-grid .card:nth-child(n+7) { display: none; }
.compact .card:nth-child(n+9) { display: none; }
.card {
  border: 1px solid var(--line);
  background: var(--panel);
  padding: 18px;
  min-height: 220px;
}
.empty {
  margin: 0;
  padding: 18px;
  border: 1px dashed var(--line);
  color: var(--muted);
  background: rgba(255,253,248,0.7);
}
.card p { margin: 0; line-height: 1.5; }
.meta, .score { color: var(--muted); font-size: 0.8rem; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.chips span { font-size: 0.85rem; }
.status-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.status-list li {
  border-left: 4px solid var(--accent);
  background: var(--panel);
  padding: 12px 14px;
}
.status-list li.error { border-left-color: var(--warn); }
@media (max-width: 640px) {
  .shell { width: min(100% - 20px, 1120px); padding-top: 18px; }
  .hero, .panel { padding: 18px; }
  .panel-head { flex-direction: column; }
}`),
  writeFile(path.join(stateFile), JSON.stringify(storedItems, null, 2)),
  writeFile(path.join(dataDir, 'latest.json'), JSON.stringify({
    generatedAt,
    items: liveItems
  }, null, 2)),
  writeFile(path.join(dataDir, 'archive.json'), JSON.stringify({
    generatedAt,
    items: archivedItems
  }, null, 2)),
  writeFile(path.join(dataDir, 'meta.json'), JSON.stringify({
    generatedAt,
    archiveAfterDays: site.archiveAfterDays,
    dropAfterDays: site.dropAfterDays,
    totalStored: storedItems.length,
    sourceStatuses: sourceResults.map((result) => ({
      title: result.title,
      ok: result.ok,
      count: result.count,
      error: result.error || null
    }))
  }, null, 2))
]);

console.log(`Built ${liveItems.length} live and ${archivedItems.length} archived articles${offline ? ' using offline fixtures' : ''}.`);
