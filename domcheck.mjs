#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createChecker, createWhoisChecker, loadBootstrap, serverFor, serversFor, tldOf, toDomains, verifyTlds } from './lib.mjs';

const HELP = `Usage: domcheck [options] <name|domain>...

Checks whether domains are registered, using RDAP (the registries' own public lookup service),
and whois for the country TLDs that have no RDAP server.
Bare names are tried against every TLD in --tlds. Names can also come from --file or stdin.

Options:
  -t, --tlds <list>        TLDs for bare names, comma separated (default: com)
  -f, --file <path>        Read names or domains from a file, one per line (# for comments)
  -c, --concurrency <n>    Requests in flight per registry (default: 2)
  -a, --available          Print only available domains
      --json               Print JSON
      --no-verify          Skip the per-TLD check that an unregistered name really returns "available"
      --refresh            Re-download the IANA RDAP server list
  -h, --help               Show this help

"available" means the registry has no record of the domain. Some registries hold back reserved
or premium names, so a registrar can still refuse or price one differently.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tlds: { type: 'string', short: 't', default: 'com' },
    file: { type: 'string', short: 'f' },
    concurrency: { type: 'string', short: 'c', default: '2' },
    available: { type: 'boolean', short: 'a', default: false },
    json: { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const entries = [...positionals];
if (values.file) entries.push(...(await readFile(values.file, 'utf8')).split(/\r?\n/));
if (!entries.some((e) => e.trim()) && !process.stdin.isTTY) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  entries.push(...input.split(/\r?\n/));
}
const fail = (msg) => {
  console.error(msg);
  process.exit(2);
};

if (!entries.some((e) => e.trim())) fail(HELP);

const tlds = values.tlds.split(',').map((t) => t.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
if (!tlds.length) fail('--tlds needs at least one TLD');
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fail('--concurrency must be a whole number from 1 to 32');

const invalid = [];
const domains = toDomains(entries, tlds, invalid);
for (const s of invalid) console.error('skipped, not a valid domain: ' + s);
if (!domains.length) fail('No valid domains to check.');

const servers = serversFor(await loadBootstrap(fetch, { refresh: values.refresh }));
const rdapCheck = createChecker({ servers, concurrency });
const whoisCheck = createWhoisChecker();
const check = (d) => (serverFor(servers, d) ? rdapCheck(d) : whoisCheck(d));

const usedTlds = [...new Set(domains.map(tldOf))];
const unreliable = !values['no-verify'] ? await verifyTlds(usedTlds, check) : new Map();

const results = await Promise.all(
  domains.map(async (d) => {
    if (unreliable.has(tldOf(d))) return { domain: d, status: 'unknown', note: '.' + tldOf(d) + ' failed the control check: ' + unreliable.get(tldOf(d)) };
    return check(d);
  }),
);

const shown = values.available ? results.filter((r) => r.status === 'available') : results;
if (values.json) {
  console.log(JSON.stringify(shown, null, 2));
} else {
  const width = shown.reduce((m, r) => Math.max(m, r.domain.length), 6);
  for (const r of shown) console.log(r.status.padEnd(10) + r.domain.padEnd(width + 2) + (r.note || ''));
  const count = (s) => results.filter((r) => r.status === s).length;
  console.error(`\n${results.length} checked: ${count('available')} available, ${count('taken')} taken, ${count('unknown')} unknown`);
}
process.exitCode = results.some((r) => r.status === 'unknown') ? 1 : 0;
