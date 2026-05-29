import { readFile } from 'node:fs/promises';

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
};

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function decodeEntities(input = '') {
  return input.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITY_MAP[entity] || entity);
}

export function stripMarkup(input = '') {
  return decodeEntities(
    input
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function getTagValue(block, tagNames) {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return stripMarkup(match[1]);

    const attrMatch = block.match(new RegExp(`<${name}[^>]*?(?:href|url)=["']([^"']+)["'][^>]*/?>`, 'i'));
    if (attrMatch) return decodeEntities(attrMatch[1].trim());
  }
  return '';
}

function getAtomLink(block) {
  const alternate = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (alternate) return decodeEntities(alternate[1].trim());
  const direct = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return direct ? decodeEntities(direct[1].trim()) : '';
}

function extractBlocks(xml, tagName) {
  return [...xml.matchAll(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, 'gi'))].map((match) => match[0]);
}

function toIsoDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeUrl(url = '') {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const cleaned = parsed.toString().replace(/\/$/, '');
    return cleaned;
  } catch {
    return url.trim();
  }
}

export function slugify(input = '') {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function parseFeed(xml, source) {
  const rssItems = extractBlocks(xml, 'item').map((item) => ({
    id: getTagValue(item, ['guid', 'id']) || normalizeUrl(getTagValue(item, 'link')),
    title: getTagValue(item, 'title'),
    link: normalizeUrl(getTagValue(item, 'link')),
    summary: getTagValue(item, ['description', 'content:encoded']),
    publishedAt: toIsoDate(getTagValue(item, ['pubDate', 'dc:date'])),
    sourceName: source.title,
    category: source.category,
    tags: source.tags || []
  }));

  if (rssItems.length > 0) {
    return rssItems.filter((item) => item.title && item.link);
  }

  return extractBlocks(xml, 'entry').map((entry) => ({
    id: getTagValue(entry, 'id') || normalizeUrl(getAtomLink(entry)),
    title: getTagValue(entry, 'title'),
    link: normalizeUrl(getAtomLink(entry)),
    summary: getTagValue(entry, ['summary', 'content']),
    publishedAt: toIsoDate(getTagValue(entry, ['updated', 'published'])),
    sourceName: source.title,
    category: source.category,
    tags: source.tags || []
  })).filter((item) => item.title && item.link);
}
