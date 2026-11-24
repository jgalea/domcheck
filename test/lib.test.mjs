import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker, createWhoisChecker, serverFor, serversFor, statusFromCode, toDomains, verifyTlds, whoisStatus } from '../lib.mjs';

test('bare names expand to each TLD, full domains pass through', () => {
  assert.deepEqual(toDomains(['Foo', 'bar.io', '# note', '', 'https://Baz.app/path'], ['com', 'app']), [
    'foo.com', 'foo.app', 'bar.io', 'baz.app',
  ]);
});

test('IDN names become punycode', () => {
  assert.deepEqual(toDomains(['münchen'], ['de']), ['xn--mnchen-3ya.de']);
});

test('bootstrap maps each TLD to an https server with a trailing slash', () => {
  const m = serversFor({ services: [[['com', 'net'], ['http://a.example/v1', 'https://a.example/v1']], [['app'], ['https://b.example/rdap/']]] });
  assert.equal(m.get('com'), 'https://a.example/v1/');
  assert.equal(m.get('app'), 'https://b.example/rdap/');
});

test('status codes map to results', () => {
  assert.equal(statusFromCode(404), 'available');
  assert.equal(statusFromCode(200), 'taken');
  assert.equal(statusFromCode(400), 'unknown');
});

const servers = new Map([['com', 'https://rdap.example/']]);
const fakeFetch = (codes) => {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const code = codes.shift();
    const h = code === 429 ? { 'retry-after': '0' } : code === 200 || code === 404 ? { 'content-type': 'application/rdap+json' } : {};
    return { status: code, headers: new Headers(h), body: null };
  };
  fn.calls = calls;
  return fn;
};

test('retries a 429 and then reports the real answer', async () => {
  const f = fakeFetch([429, 404]);
  const check = createChecker({ servers, fetchImpl: f, gapMs: 0, retries: 2 });
  const r = await check('free.com');
  assert.equal(r.status, 'available');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0], 'https://rdap.example/domain/free.com');
});

test('gives up as unknown after the retries run out', async () => {
  const check = createChecker({ servers, fetchImpl: fakeFetch([503, 503]), gapMs: 0, retries: 1 });
  const r = await check('x.com');
  assert.equal(r.status, 'unknown');
  assert.equal(r.note, 'HTTP 503');
});

test('a TLD with no RDAP server is unknown, not available', async () => {
  const check = createChecker({ servers, fetchImpl: fakeFetch([]), gapMs: 0 });
  assert.equal((await check('x.zz')).status, 'unknown');
});

test('verify flags a registry that does not answer 404 for a random name', async () => {
  const check = createChecker({ servers, fetchImpl: fakeFetch([200]), gapMs: 0 });
  const bad = await verifyTlds(['com'], check);
  assert.equal(bad.size, 1);
});

test('bad entries are skipped and reported, not fatal', () => {
  const invalid = [];
  assert.deepEqual(toDomains(['hello world', '%', 'ok', 'a.com?x=1'], ['com'], invalid), ['ok.com', 'a.com']);
  assert.deepEqual(invalid, ['hello world', '%']);
});

test('longest matching suffix picks the server', () => {
  const m = new Map([['za', 'https://za.example/'], ['co.za', 'https://coza.example/']]);
  assert.equal(serverFor(m, 'shop.co.za'), 'https://coza.example/');
  assert.equal(serverFor(m, 'shop.org.za'), 'https://za.example/');
});

test('an HTML 200 is not read as taken', async () => {
  const f = async () => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: null });
  const check = createChecker({ servers, fetchImpl: f, gapMs: 0 });
  assert.equal((await check('x.com')).status, 'unknown');
});

test('the queue never runs more than its concurrency at once', async () => {
  let live = 0, peak = 0;
  const f = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { status: 404, headers: new Headers({ 'content-type': 'application/rdap+json' }), body: null }; };
  const check = createChecker({ servers, fetchImpl: f, gapMs: 0, concurrency: 2 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => check('n' + i + '.com')));
  assert.ok(peak <= 2, 'peak was ' + peak);
});

test('a malformed bootstrap is rejected', () => {
  assert.throws(() => serversFor({ services: null }));
  assert.throws(() => serversFor({}));
});

test('whois replies are read conservatively', () => {
  assert.equal(whoisStatus('NOT FOUND').status, 'available');
  assert.equal(whoisStatus('Domain Name: foo.io\nRegistrar: X').status, 'taken');
  assert.equal(whoisStatus('Query rate limit exceeded').status, 'unknown');
  assert.equal(whoisStatus(null).status, 'unknown');
});

test('whois checker finds the server through IANA, then asks it', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args.join(' ')); return args[1] === 'whois.iana.org' ? 'whois:        whois.nic.example' : 'No match for domain'; };
  const check = createWhoisChecker({ run, gapMs: 0 });
  const r = await check('foo.zz');
  assert.equal(r.status, 'available');
  assert.deepEqual(calls, ['-h whois.iana.org zz', '-h whois.nic.example foo.zz']);
});

test('a 429 slows that registry down for the rest of the run', async () => {
  const times = [];
  const codes = [429, 404, 404];
  const f = async () => { times.push(Date.now()); const c = codes.shift(); return { status: c, headers: new Headers(c === 429 ? { 'retry-after': '0' } : { 'content-type': 'application/rdap+json' }), body: null }; };
  const check = createChecker({ servers, fetchImpl: f, gapMs: 0, concurrency: 1 });
  await check('a.com');
  await check('b.com');
  assert.ok(times[2] - times[1] >= 450, 'gap after a 429 was ' + (times[2] - times[1]));
});
