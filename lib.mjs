import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'domcheck');
const CACHE_FILE = join(CACHE_DIR, 'dns.json');
const DAY = 86400000;

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function hostname(s) {
  try {
    const h = new URL('http://' + s).hostname;
    return HOST.test(h) ? h : null;
  } catch {
    return null;
  }
}

export function toDomains(entries, tlds, invalid = []) {
  const out = [];
  for (const raw of entries) {
    const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    if (!s || s.startsWith('#')) continue;
    const host = hostname(s);
    if (!host) invalid.push(raw.trim());
    else if (host.includes('.')) out.push(host);
    else for (const t of tlds) {
      const d = hostname(host + '.' + t);
      if (d) out.push(d);
      else invalid.push(host + '.' + t);
    }
  }
  return [...new Set(out)];
}

export function tldOf(domain) {
  return domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
}

export function serverFor(servers, domain) {
  const labels = domain.toLowerCase().split('.');
  for (let i = 1; i < labels.length; i++) {
    const base = servers.get(labels.slice(i).join('.'));
    if (base) return base;
  }
  return undefined;
}

function validBootstrap(data) {
  return Array.isArray(data?.services) && data.services.length > 0 &&
    data.services.every((s) => Array.isArray(s) && Array.isArray(s[0]) && Array.isArray(s[1]) && s[1].length > 0);
}

export function serversFor(bootstrap) {
  if (!validBootstrap(bootstrap)) throw new Error('IANA RDAP bootstrap has no usable services list');
  const map = new Map();
  for (const [tlds, urls] of bootstrap.services) {
    const url = urls.find((u) => u.startsWith('https://')) || urls[0];
    for (const t of tlds) map.set(t.toLowerCase(), url.endsWith('/') ? url : url + '/');
  }
  return map;
}

export async function loadBootstrap(fetchImpl = fetch, { refresh = false } = {}) {
  if (!refresh) {
    try {
      const st = await stat(CACHE_FILE);
      if (Date.now() - st.mtimeMs < DAY) {
        const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
        if (validBootstrap(cached)) return cached;
      }
    } catch {}
  }
  const res = await fetchImpl(BOOTSTRAP_URL);
  if (!res.ok) throw new Error('IANA RDAP bootstrap returned HTTP ' + res.status);
  const data = await res.json();
  if (!validBootstrap(data)) throw new Error('IANA RDAP bootstrap has no usable services list');
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(data));
  return data;
}

export function statusFromCode(code) {
  if (code === 404) return 'available';
  if (code === 200) return 'taken';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HostQueue {
  constructor(concurrency, gapMs) {
    this.concurrency = concurrency;
    this.gapMs = gapMs;
    this.active = 0;
    this.waiting = [];
    this.nextStart = 0;
  }
  async run(fn) {
    while (this.active >= this.concurrency) await new Promise((r) => this.waiting.push(r));
    this.active++;
    const startAt = Math.max(Date.now(), this.nextStart);
    this.nextStart = startAt + this.gapMs;
    if (startAt > Date.now()) await sleep(startAt - Date.now());
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export function createChecker({ servers, fetchImpl = fetch, concurrency = 2, gapMs = 250, retries = 6, timeoutMs = 15000 }) {
  const queues = new Map();
  const queueFor = (base) => {
    const host = new URL(base).host;
    if (!queues.has(host)) queues.set(host, new HostQueue(concurrency, gapMs));
    return queues.get(host);
  };

  return async function check(domain) {
    const base = serverFor(servers, domain);
    if (!base) return { domain, status: 'unknown', note: 'no RDAP server for .' + tldOf(domain) };
    const q = queueFor(base);
    let lastNote = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await q.run(async () => {
        try {
          return await fetchImpl(base + 'domain/' + domain, {
            headers: { accept: 'application/rdap+json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          return { status: 0, error: e };
        }
      });
      if (res.status === 404 || res.status === 200) {
        const type = res.headers?.get?.('content-type') || '';
        res.body?.cancel?.();
        if (res.status === 200 && !type.includes('json')) return { domain, status: 'unknown', note: 'HTTP 200 without an RDAP body' };
        if (res.status === 404 && type && !type.includes('json')) return { domain, status: 'unknown', note: 'HTTP 404 from a non-RDAP page' };
        return { domain, status: statusFromCode(res.status), code: res.status };
      }
      res.body?.cancel?.();
      lastNote = res.status ? 'HTTP ' + res.status : String(res.error?.name || 'network error');
      if (res.status === 429) q.gapMs = Math.min(Math.max(q.gapMs * 2, 500), 5000);
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) break;
      const after = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
    }
    return { domain, status: 'unknown', note: lastNote };
  };
}

function randomLabel() {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let s = 'zq';
  for (let i = 0; i < 18; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export async function verifyTlds(tlds, check) {
  const bad = new Map();
  await Promise.all(
    tlds.map(async (t) => {
      const r = await check(randomLabel() + '.' + t);
      if (r.status !== 'available') bad.set(t, r.note || 'registry did not answer 404 for an unregistered name');
    }),
  );
  return bad;
}

const WHOIS_FREE = /no match|not found|no data found|no entries found|status:\s*(free|available)|is available for registration|domain not registered|no object found/i;
const WHOIS_TAKEN = /^\s*(domain name|domain|registrar|creation date|created|registered on|registry domain id)\s*:/im;

function runWhois(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('whois', args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout || '')));
  });
}

export function whoisStatus(text) {
  if (text == null) return { status: 'unknown', note: 'whois failed' };
  if (WHOIS_FREE.test(text)) return { status: 'available' };
  if (WHOIS_TAKEN.test(text)) return { status: 'taken' };
  return { status: 'unknown', note: 'whois reply not recognised' };
}

export function createWhoisChecker({ gapMs = 1000, timeoutMs = 15000, run = runWhois } = {}) {
  const serverCache = new Map();
  const queues = new Map();
  const serverFor = async (tld) => {
    if (!serverCache.has(tld)) {
      serverCache.set(tld, run(['-h', 'whois.iana.org', tld], timeoutMs).then((t) => (t || '').match(/^whois:\s*(\S+)/im)?.[1] || null));
    }
    return serverCache.get(tld);
  };
  return async function check(domain) {
    const tld = tldOf(domain);
    const server = await serverFor(tld);
    if (!server) return { domain, status: 'unknown', note: 'no RDAP or whois server for .' + tld };
    if (!queues.has(server)) queues.set(server, new HostQueue(1, gapMs));
    const text = await queues.get(server).run(() => run(['-h', server, domain], timeoutMs));
    return { domain, ...whoisStatus(text), via: 'whois' };
  };
}
