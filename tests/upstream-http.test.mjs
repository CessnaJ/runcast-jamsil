import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../lib/upstream-http.mjs';

const url = 'https://api.open-meteo.com/v1/forecast?apikey=private-test-key&latitude=37.123456';
function warnings(t) {
  const lines = [];
  t.mock.method(console, 'warn', line => lines.push(line));
  return { lines, log: () => JSON.parse(lines[0].slice('[UPSTREAM_HTTP] '.length)) };
}

for (const [code, failure] of [['UND_ERR_CONNECT_TIMEOUT', 'connect-timeout'], ['ENOTFOUND', 'dns'], ['CERT_HAS_EXPIRED', 'tls'], ['ECONNRESET', 'network']]) {
  test(`upstream ${code} logs one redacted cause chain and preserves the exception`, async t => {
    const output = warnings(t);
    const error = Object.assign(new TypeError(`fetch failed ${url}`), {
      cause: Object.assign(new Error('private-test-key'), { code, cause: { code: 'ETIMEDOUT' } }),
    });
    t.mock.method(globalThis, 'fetch', async () => { throw error; });
    await assert.rejects(fetchJson(url, { timeout: 15000, dataset: 'weekly', headers: { Authorization: 'private-header' } }), value => value === error);
    assert.equal(output.lines.length, 1);
    const log = output.log();
    assert.equal(log.failure, failure);
    assert.equal(log.phase, 'headers');
    assert.equal(log.statusCode, null);
    assert.equal(log.errorCode, code);
    assert.deepEqual(log.causeCodes, [code, 'ETIMEDOUT']);
    assert.equal(log.provider, 'open-meteo');
    assert.equal(log.dataset, 'weekly');
    assert.equal(log.configuredTimeoutMs, 15000);
    assert.ok(log.durationMs >= 0 && log.requestId);
    assert.doesNotMatch(output.lines.join(''), /private-test-key|private-header|37\.123456|apikey|latitude|fetch failed/);
  });
}

test('aggregated address failures are bounded and do not serialize messages or cycles', async t => {
  const output = warnings(t);
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([Object.assign(new Error(url), { code: 'ENETUNREACH' }), Object.assign(new Error(url), { code: 'ETIMEDOUT' })]),
  });
  error.cause.cause = error;
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  await assert.rejects(fetchJson(url));
  assert.deepEqual(output.log().causeCodes, ['ENETUNREACH', 'ETIMEDOUT']);
  assert.doesNotMatch(output.lines[0], /private-test-key|37\.123456/);
});

test('HTTP 429 logs status, preserves retry metadata and discards the secret error body', async t => {
  const output = warnings(t);
  let response;
  t.mock.method(globalThis, 'fetch', async () => response = new Response('private-response', { status: 429, headers: { 'Retry-After': '120' } }));
  await assert.rejects(fetchJson(url), { statusCode: 429, retryAfterMs: 120000 });
  assert.equal(output.log().failure, 'http');
  assert.equal(output.log().statusCode, 429);
  assert.ok(response.body.locked === false);
  assert.doesNotMatch(output.lines[0], /private-response/);
});

test('JSON parse errors and deadline errors can be distinguished from connection failures', async t => {
  const output = warnings(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('private-invalid-json'));
  await assert.rejects(fetchJson(url), SyntaxError);
  assert.equal(output.log().phase, 'body');
  assert.equal(output.log().failure, 'invalid-json');
  assert.equal(output.log().statusCode, 200);
  assert.doesNotMatch(output.lines[0], /private-invalid-json/);
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('private-timeout-message', 'TimeoutError'); });
  await assert.rejects(fetchJson(url));
  assert.equal(JSON.parse(output.lines[1].slice('[UPSTREAM_HTTP] '.length)).failure, 'deadline');
});

test('healthy upstream calls remain silent and internal diagnostic options are not sent to fetch', async t => {
  const output = warnings(t);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(input, url);
    assert.equal(options.timeout, undefined);
    assert.equal(options.dataset, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('{"ok":true}');
  });
  assert.deepEqual(await fetchJson(url, { dataset: 'weekly' }), { ok: true });
  assert.deepEqual(output.lines, []);
});
