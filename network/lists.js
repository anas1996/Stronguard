// Filter list downloader with mirrors, on-disk cache and conditional requests.
// Used by the extension build and by the network service.

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

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

// Plain node:http(s) GET with redirects, decompression and an overall deadline.
// (Not fetch(): its bundled HTTP client can throw an uncatchable internal
// assertion on some error responses, which would take the DNS service down.)
const MAX_BYTES = 200 * 1024 * 1024;

export function httpGet(url, headers = {}, timeoutMs = 60000, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new Error(`unsupported protocol ${u.protocol}`));
      return;
    }
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    // agent:false = a fresh connection per download; reusing keep-alive sockets
    // races with servers that close them right after an error response.
    const req = mod.get(u, { agent: false, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br', ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && status !== 304 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return done(reject, new Error('too many redirects'));
        const next = new URL(res.headers.location, u).href;
        return done(resolve, httpGet(next, headers, Math.max(1000, deadline - Date.now()), redirects - 1));
      }
      if (status !== 200) {
        res.resume(); // drain so the socket is released cleanly
        return done(resolve, { status, headers: res.headers, text: '' });
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => done(resolve, { status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (err) => done(reject, err));
      res.on('error', (err) => done(reject, err));
    });
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', (err) => done(reject, err));
  });
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
      const res = await httpGet(url, headers, timeoutMs);
      if (res.status === 304 && cached) {
        const m = { ...meta, fetchedAt: Date.now() };
        await fs.writeFile(metaFile, JSON.stringify(m));
        return { ok: true, text: cached, source: 'network', url, fetchedAt: m.fetchedAt };
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const { text } = res;
      if (!looksLikeList(text)) throw new Error('response is not a filter list');
      const m = { url, fetchedAt: Date.now(), etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null, size: text.length };
      await fs.writeFile(file, text);
      await fs.writeFile(metaFile, JSON.stringify(m));
      return { ok: true, text, source: 'network', url, fetchedAt: m.fetchedAt };
    } catch (err) {
      log(`  ${entry.id}: ${url} failed (${err.code || err.message})`);
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
