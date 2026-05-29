import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeUrl, parseFeed, slugify } from '../scripts/lib/feed-utils.mjs';
import { mergeArticles, splitArchive } from '../scripts/lib/article-store.mjs';

const execFileAsync = promisify(execFile);

test('parseFeed reads RSS items', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>ChatGPT update</title><link>https://example.com/x</link><pubDate>Thu, 29 May 2026 09:00:00 GMT</pubDate><description>New model notes.</description></item></channel></rss>`;
  const items = parseFeed(xml, { title: 'AI Feed', category: 'AI', tags: ['ChatGPT'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'ChatGPT update');
  assert.equal(items[0].category, 'AI');
});

test('parseFeed reads Atom entries', () => {
  const xml = `<?xml version="1.0"?><feed><entry><title>Repo trend</title><link rel="alternate" href="https://example.com/repo" /><updated>2026-05-29T09:00:00Z</updated><summary>AI repo summary.</summary></entry></feed>`;
  const items = parseFeed(xml, { title: 'GitHub', category: 'AI Repos', tags: ['GitHub'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://example.com/repo');
});

test('normalizeUrl strips trailing slash and fragment', () => {
  assert.equal(normalizeUrl('https://example.com/path/#section'), 'https://example.com/path');
});

test('slugify creates safe ids', () => {
  assert.equal(slugify('Claude Code & Gemini'), 'claude-code-gemini');
});

test('mergeArticles keeps first seen metadata and updates last seen', () => {
  const previous = [{
    title: 'Hermes Agent update',
    link: 'https://example.com/hermes',
    publishedAt: '2026-05-20T10:00:00.000Z',
    firstSeenAt: '2026-05-20T10:05:00.000Z',
    lastSeenAt: '2026-05-20T10:05:00.000Z',
    seenCount: 1,
    score: 10
  }];
  const incoming = [{
    title: 'Hermes Agent update',
    link: 'https://example.com/hermes',
    publishedAt: '2026-05-20T10:00:00.000Z',
    score: 22
  }];

  const merged = mergeArticles(previous, incoming, '2026-05-29T09:00:00.000Z');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].firstSeenAt, '2026-05-20T10:05:00.000Z');
  assert.equal(merged[0].lastSeenAt, '2026-05-29T09:00:00.000Z');
  assert.equal(merged[0].seenCount, 2);
  assert.equal(merged[0].score, 22);
});

test('splitArchive moves older items out of live feed', () => {
  const { live, archived } = splitArchive([
    { title: 'Fresh', link: 'https://example.com/fresh', publishedAt: '2026-05-28T09:00:00.000Z' },
    { title: 'Old', link: 'https://example.com/old', publishedAt: '2026-05-20T09:00:00.000Z' }
  ], 4, '2026-05-29T09:00:00.000Z');

  assert.equal(live.length, 1);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].title, 'Old');
});

test('offline build renders featured focus sections', async () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  await execFileAsync('node', ['scripts/build-site.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NEWS_OFFLINE_FIXTURES: '1'
    }
  });

  const html = await readFile(path.join(rootDir, 'dist', 'index.html'), 'utf8');
  assert.match(html, /AI Prioritaeten/);
  assert.match(html, /Hamburg und Norderstedt/);
});
