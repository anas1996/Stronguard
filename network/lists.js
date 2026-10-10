// Filter list downloader with mirrors, on-disk cache and conditional requests.
// Used by the extension build and by the network service.

import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'Stronguard/1.0 (+https://github.com/anas1996/stronguard)';

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function looksLikeList(text) {
  if (!text || text.length < 20) return false;
  const head = text.slice(0, 300).trimStart().toLowerCase();
  return !head.startsWith('<!doctype html') && !head.startsWith('<html');
}

async function fetchWithTimeout(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// entry: catalog entry. Returns { ok, text, source, url, fetchedAt }.
export async function loadList(entry, { root, cacheDir, offline = false, maxAgeHours = 24, timeoutMs = 60000, log = () => {} } = {}) {
  if (entry.builtin) {
    const text = await fs.readFile(path.join(root, entry.builtin), 'utf8');
    return { ok: true, text, source: 'builtin', url: entry.builtin, fetchedAt: Date.now() };
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${entry.id}.txt`);
  const metaFile = path.join(cacheDir, `${entry.id}.json`);
  const meta = (await readJSON(metaFile)) || {};
  let cached = null;
  try {
    cached = await fs.readFile(file, 'utf8');
  } catch {
    cached = null;
  }
  const fresh = cached && meta.fetchedAt && Date.now() - meta.fetchedAt < maxAgeHours * 3600e3;
  if (cached && (fresh || offline)) return { ok: true, text: cached, source: 'cache', url: meta.url, fetchedAt: meta.fetchedAt };
  if (offline) return { ok: false, text: '', source: 'missing' };

  for (const url of entry.urls || []) {
    try {
      const headers = {};
      if (cached && meta.url === url) {
        if (meta.etag) headers['If-None-Match'] = meta.etag;
        if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
      }
      const res = await fetchWithTimeout(url, headers, timeoutMs);
      if (res.status === 304 && cached) {
        const m = { ...meta, fetchedAt: Date.now() };
        await fs.writeFile(metaFile, JSON.stringify(m));
        return { ok: true, text: cached, source: 'network', url, fetchedAt: m.fetchedAt };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!looksLikeList(text)) throw new Error('response is not a filter list');
      const m = { url, fetchedAt: Date.now(), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), size: text.length };
      await fs.writeFile(file, text);
      await fs.writeFile(metaFile, JSON.stringify(m));
      return { ok: true, text, source: 'network', url, fetchedAt: m.fetchedAt };
    } catch (err) {
      log(`  ${entry.id}: ${url} failed (${err.cause?.code || err.message})`);
    }
  }
  if (cached) return { ok: true, text: cached, source: 'stale-cache', url: meta.url, fetchedAt: meta.fetchedAt };
  return { ok: false, text: '', source: 'missing' };
}

// Loads many lists with limited parallelism.
export async function loadLists(entries, opts, concurrency = 4) {
  const results = new Map();
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const e = entries[i++];
      results.set(e.id, await loadList(e, opts));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}
