// Hosts-file layer: a capped, prioritised block of 0.0.0.0 entries inside
// markers, so it can be updated or removed without touching user entries.
// Works even when the Stronguard service is not running.

import path from 'node:path';

export const BEGIN = '# >>> Stronguard (managed block - do not edit) >>>';
export const END = '# <<< Stronguard <<<';

export function hostsPath() {
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  return '/etc/hosts';
}

export function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(END, start);
  const tail = end === -1 ? '' : text.slice(end + END.length);
  return (text.slice(0, start).replace(/\s*$/, '') + tail.replace(/^\r?\n/, '')).replace(/\s*$/, '\n');
}

export function buildBlock(domains, eol = '\r\n') {
  const lines = [BEGIN, `# ${domains.length} domains, generated ${new Date().toISOString()}`];
  for (const d of domains) lines.push(`0.0.0.0 ${d}`);
  lines.push(END);
  return lines.join(eol);
}

export function mergeHosts(existing, domains) {
  const eol = existing.includes('\r\n') || process.platform === 'win32' ? '\r\n' : '\n';
  const base = stripBlock(existing).replace(/\s*$/, '');
  return `${base}${eol}${eol}${buildBlock(domains, eol)}${eol}`;
}

// Picks domains from the engine's matcher, earlier (lower-level, popup/malware-first) lists first.
export function selectDomains(engine, max = 100000) {
  const bySource = new Map();
  for (const [host, src] of engine.matcher.block) {
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(host);
  }
  const order = [...bySource.keys()].sort((a, b) => a - b);
  const out = [];
  for (const src of order) {
    for (const h of bySource.get(src).sort()) {
      if (out.length >= max) return out;
      out.push(h);
    }
  }
  return out;
}
