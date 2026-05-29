import { normalizeUrl, slugify } from './feed-utils.mjs';

function toTimestamp(value, fallback = 0) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function makeArticleKey(item) {
  const normalizedLink = normalizeUrl(item.link);
  if (normalizedLink) return normalizedLink;
  return `${slugify(item.title)}::${item.publishedAt || 'undated'}`;
}

export function mergeArticles(previousItems, incomingItems, generatedAt) {
  const merged = new Map();

  for (const item of previousItems) {
    const key = makeArticleKey(item);
    merged.set(key, {
      ...item,
      key,
      firstSeenAt: item.firstSeenAt || generatedAt,
      lastSeenAt: item.lastSeenAt || item.firstSeenAt || generatedAt,
      seenCount: item.seenCount || 1
    });
  }

  for (const item of incomingItems) {
    const key = makeArticleKey(item);
    const existing = merged.get(key);
    merged.set(key, {
      ...existing,
      ...item,
      key,
      firstSeenAt: existing?.firstSeenAt || generatedAt,
      lastSeenAt: generatedAt,
      seenCount: (existing?.seenCount || 0) + 1
    });
  }

  return [...merged.values()];
}

export function pruneArticles(items, { generatedAt, dropAfterDays, maxStoredItems }) {
  const cutoff = toTimestamp(generatedAt) - dropAfterDays * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => {
      const publishedAt = toTimestamp(item.publishedAt, toTimestamp(item.lastSeenAt, Date.now()));
      return publishedAt >= cutoff;
    })
    .sort((left, right) => {
      const freshnessDiff = toTimestamp(right.publishedAt, toTimestamp(right.lastSeenAt))
        - toTimestamp(left.publishedAt, toTimestamp(left.lastSeenAt));
      if (freshnessDiff !== 0) return freshnessDiff;
      return (right.score || 0) - (left.score || 0);
    })
    .slice(0, maxStoredItems);
}

export function splitArchive(items, archiveAfterDays, nowIso) {
  const archiveCutoff = toTimestamp(nowIso) - archiveAfterDays * 24 * 60 * 60 * 1000;
  const live = [];
  const archived = [];

  for (const item of items) {
    const itemTime = toTimestamp(item.publishedAt, toTimestamp(item.lastSeenAt, toTimestamp(nowIso)));
    if (itemTime < archiveCutoff) archived.push(item);
    else live.push(item);
  }

  return { live, archived };
}
