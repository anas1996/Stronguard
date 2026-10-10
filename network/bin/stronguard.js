#!/usr/bin/env node
// Stronguard network shield command line.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, defaultDataDir, parseHostPort } from '../config.js';
import { FilterEngine } from '../engine.js';
import { StronguardService } from '../service.js';
import { pacScript } from '../proxy/server.js';
import { firewallScript } from '../windows/firewall.js';
import { policiesScript } from '../windows/policies.js';
import { hostsPath, mergeHosts, stripBlock, selectDomains } from '../windows/hosts.js';
import { LEVELS, clampLevel, levelInfo } from '../../core/levels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HELP = `Stronguard network shield

Usage: stronguard <command> [options]

Service
  run                     Start DNS sinkhole + filtering proxy + dashboard [--log <file>]
  status                  Show the running service status
  update                  Download/refresh filter lists for the current level

Protection
  level [1-5]             Show or set the protection level
  check <domain>          Is a domain blocked, and by which list?
  allow <domain>          Never block this domain        (unallow to undo)
  block <domain>          Always block this domain       (unblock to undo)

Setup / Windows integration
  init                    Create or update the configuration
                            --level N --serve-lan --local-forward <ip>
                            --upstream <url> (repeatable) --dns-port N --no-proxy
                            --windows-firewall --windows-policies (keep in sync with level)
                            --windows-ads --no-dns-adapters
  firewall                Print Windows Firewall rules (PowerShell) [--remove] [--serve-lan]
  policies                Print browser/Windows hardening policies (PowerShell)
                            [--scope machine|user] [--remove] [--windows-ads] [--no-dns]
  hosts                   Print a hosts-file block [--install | --uninstall] [--max N, default 20000]
  pac                     Print the proxy auto-config file

Options
  --data <dir>            Data directory (default: ${defaultDataDir()})
  --level <n>             Level for generators (default: configured level)
  --offline               Do not download lists
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    const value = inline !== undefined ? inline : next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (k === 'upstream') (opts.upstream ||= []).push(value);
    else opts[k] = value;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0] || 'help';
const dataDir = path.resolve(typeof opts.data === 'string' ? opts.data : defaultDataDir());
const store = new ConfigStore(dataDir);

// Appends to a log file, rotating it at 5 MB.
function fileLogger(file) {
  fsSync.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return (line) => {
    try {
      if (fsSync.existsSync(file) && fsSync.statSync(file).size > 5 * 1048576) fsSync.renameSync(file, `${file}.1`);
      fsSync.appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never crash the service */
    }
  };
}

async function dashboardCall(config, pathname, body) {
  const { host, port } = parseHostPort(config.dashboard.listen, 8080);
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const res = await fetch(`http://${h.includes(':') ? `[${h}]` : h}:${port}${pathname}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }
    : { signal: AbortSignal.timeout(3000) });
  return res.json();
}

// The Windows DNS Client service briefly locks the hosts file while reading it.
async function writeWithRetry(file, text) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, text);
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code) || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function loadEngine(config) {
  const engine = new FilterEngine({ root: ROOT, dataDir, log: () => {} });
  await engine.load(config, { offline: !!opts.offline });
  return engine;
}

async function main() {
  switch (cmd) {
    case 'run': {
      const log = typeof opts.log === 'string' ? fileLogger(opts.log) : console.log;
      const svc = new StronguardService({ root: ROOT, dataDir, log });
      await svc.start({ offline: !!opts.offline });
      const stop = async () => {
        await svc.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }

    case 'init': {
      const config = await store.load();
      const patch = {};
      if (opts.level) patch.level = clampLevel(opts.level);
      const port = opts['dns-port'] ? Number(opts['dns-port']) : 53;
      if (opts['serve-lan']) patch.dns = { ...config.dns, listen: [`0.0.0.0:${port}`, `[::]:${port}`] };
      else if (opts['dns-port']) patch.dns = { ...config.dns, listen: [`127.0.0.1:${port}`, `[::1]:${port}`] };
      if (typeof opts['local-forward'] === 'string') {
        patch.dns = { ...(patch.dns || config.dns), localForward: { ...config.dns.localForward, upstream: opts['local-forward'] } };
      }
      if (opts.upstream) patch.dns = { ...(patch.dns || config.dns), upstreams: opts.upstream };
      if (opts['no-proxy']) patch.proxy = { ...config.proxy, enabled: false };
      if (opts['windows-firewall'] || opts['windows-policies'] || opts['serve-lan']) {
        patch.windows = {
          firewall: !!opts['windows-firewall'],
          policies: !!opts['windows-policies'],
          serveLan: !!opts['serve-lan'],
          windowsAds: !!opts['windows-ads'],
          dnsAdapters: !opts['no-dns-adapters'],
        };
      }
      const next = await store.update(patch);
      console.log(`Configuration written to ${store.file}`);
      console.log(`Level ${next.level} (${levelInfo(next.level).name}), DNS on ${next.dns.listen.join(', ')}, upstreams ${next.dns.upstreams.join(', ')}`);
      break;
    }

    case 'update': {
      const config = await store.load();
      const engine = new FilterEngine({ root: ROOT, dataDir, log: console.log });
      const r = await engine.load(config, { refresh: true });
      for (const l of r.lists) console.log(`  ${l.ok ? '✓' : '✗'} ${l.id.padEnd(22)} ${String(l.rules).padStart(8)} rules  [${l.source}]`);
      try {
        await dashboardCall(config, '/api/update', {});
        console.log('Running service reloaded.');
      } catch {
        /* not running */
      }
      break;
    }

    case 'level': {
      const config = await store.load();
      if (opts._[1] === undefined) {
        for (const l of LEVELS) console.log(`${l.level === config.level ? '▶' : ' '} ${l.level}  ${l.name.padEnd(11)} ${l.tagline}`);
        break;
      }
      const level = clampLevel(opts._[1]);
      await store.update({ level });
      try {
        await dashboardCall(config, '/api/level', { level });
      } catch {
        /* service picks the change up from the config file */
      }
      console.log(`Level set to ${level} (${levelInfo(level).name}).`);
      break;
    }

    case 'check': {
      const domain = opts._[1];
      if (!domain) throw new Error('usage: stronguard check <domain>');
      const config = await store.load();
      const engine = await loadEngine(config);
      const m = engine.match(domain);
      if (m.blocked) console.log(`BLOCKED  ${domain}  (list: ${m.list}, rule: ${m.rule})`);
      else if (m.reason) console.log(`allowed  ${domain}  (by ${m.list}: ${m.rule})`);
      else console.log(`allowed  ${domain}  (not on any list at level ${config.level})`);
      process.exitCode = m.blocked ? 1 : 0;
      break;
    }

    case 'allow':
    case 'block':
    case 'unallow':
    case 'unblock': {
      const domain = String(opts._[1] || '').toLowerCase();
      if (!domain) throw new Error(`usage: stronguard ${cmd} <domain>`);
      const config = await store.load();
      const key = cmd.endsWith('allow') ? 'allowlist' : 'blocklist';
      let list = config[key].filter((d) => d !== domain);
      if (!cmd.startsWith('un')) list.push(domain);
      await store.update({ [key]: list });
      console.log(`${key}: ${list.join(', ') || '(empty)'}`);
      break;
    }

    case 'status': {
      const config = await store.load();
      try {
        const s = await dashboardCall(config, '/api/status');
        console.log(`Running: level ${s.level} (${s.levelName})${s.paused ? ' — PAUSED' : ''}`);
        console.log(`Queries ${s.stats.queries}, blocked ${s.stats.blocked} (${s.stats.blockedPercent}%), CNAME-uncloaked ${s.stats.cnameBlocked}, proxy blocked ${s.stats.proxyBlocked}`);
        console.log(`${s.engine.domains.toLocaleString()} blocked domains from ${s.engine.lists.filter((l) => l.ok).length} lists`);
        if (s.dns) console.log(`Upstreams: ${s.dns.upstreams.map((u) => `${u.upstream}${u.healthy ? '' : ' (down)'}`).join(', ')}`);
        console.log(`Dashboard: http://${config.dashboard.listen}`);
      } catch {
        console.log(`Not running (config: ${store.file}, level ${config.level}).`);
        process.exitCode = 3;
      }
      break;
    }

    case 'firewall': {
      const config = await store.load();
      const level = opts.level ? clampLevel(opts.level) : config.level;
      process.stdout.write(firewallScript(config, level, { remove: !!opts.remove, serveLan: !!opts['serve-lan'] }));
      break;
    }

    case 'policies': {
      const config = await store.load();
      const level = opts.level ? clampLevel(opts.level) : config.level;
      const scope = opts.scope === 'user' ? 'user' : 'machine';
      process.stdout.write(policiesScript(level, { dns: !opts['no-dns'], windowsAds: !!opts['windows-ads'] }, { remove: !!opts.remove, scope }));
      break;
    }

    case 'hosts': {
      const file = typeof opts.file === 'string' ? opts.file : hostsPath();
      if (opts.uninstall) {
        const text = await fs.readFile(file, 'utf8');
        if (text.includes('Stronguard')) await writeWithRetry(file, stripBlock(text));
        console.log(`Stronguard entries removed from ${file}`);
        break;
      }
      const config = await store.load();
      if (opts.level) config.level = clampLevel(opts.level);
      const engine = await loadEngine(config);
      // Windows' DNS Client slows down noticeably with very large hosts files.
      const domains = selectDomains(engine, Number(opts.max) || 20000);
      if (opts.install) {
        let text = '';
        try {
          text = await fs.readFile(file, 'utf8');
        } catch {
          text = '';
        }
        await fs.writeFile(`${file}.stronguard.bak`, text).catch(() => {});
        await writeWithRetry(file, mergeHosts(text, domains));
        console.log(`${domains.length.toLocaleString()} domains written to ${file}`);
      } else {
        process.stdout.write(mergeHosts('', domains));
      }
      break;
    }

    case 'pac': {
      const config = await store.load();
      const { host, port } = parseHostPort(config.proxy.listen, 8118);
      process.stdout.write(pacScript(host === '0.0.0.0' ? '127.0.0.1' : host, port));
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      break;

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`stronguard: ${err.message}`);
  process.exit(1);
});
