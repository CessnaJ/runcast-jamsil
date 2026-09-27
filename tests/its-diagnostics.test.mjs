import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';

process.env.VERCEL = '1';
const { httpsGetText } = await import('../server.mjs');
const secretUrl = 'https://openapi.its.go.kr:9443/cctvInfo?apiKey=private-test-key&minX=127.123456';

function network(t, drive) {
  const warnings = [], info = [];
  t.mock.method(console, 'warn', line => warnings.push(line));
  t.mock.method(console, 'info', line => info.push(line));
  t.mock.method(https, 'get', (url, options, onResponse) => {
    const request = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { connecting: true, secureConnecting: true, timeout: 0, remotePort: 9443 });
    request.setTimeout = (ms, callback) => { socket.timeout = ms; request.timeoutCallback = callback; return request; };
    request.destroy = error => { request.emit('error', error); return request; };
    queueMicrotask(() => drive({ request, socket, onResponse }));
    return request;
  });
  return { warnings, info, diagnostic: () => JSON.parse(warnings[0].slice('[ITS_HTTP] '.length)) };
}

for (const phase of ['dns', 'tcp', 'tls', 'response']) {
  test(`ITS timeout identifies ${phase}, records effective timeout, and logs once without secrets`, async t => {
    const output = network(t, ({ request, socket }) => {
      request.emit('socket', socket);
      if (phase !== 'dns') socket.emit('lookup', null, '192.0.2.1', 4, 'openapi.its.go.kr');
      if (['tls', 'response'].includes(phase)) socket.emit('connect');
      if (phase === 'response') socket.emit('secureConnect');
      socket.timeout = 5000;
      request.timeoutCallback();
      request.emit('error', Object.assign(new Error(secretUrl), { code: 'ECONNRESET' }));
      for (const event of ['lookup', 'connect', 'secureConnect']) assert.equal(socket.listenerCount(event), 0);
    });
    await assert.rejects(httpsGetText(secretUrl, { headers: { Authorization: 'private-header' } }), { code: 'ITS_CONNECT_TIMEOUT' });
    assert.equal(output.warnings.length, 1);
    const log = output.diagnostic();
    assert.equal(log.phase, phase);
    assert.equal(log.configuredTimeoutMs, 12000);
    assert.equal(log.timeoutObserved.socketTimeoutMs, 5000);
    assert.equal(log.timeoutObserved.phase, phase);
    assert.equal(log.errorCode, 'ITS_CONNECT_TIMEOUT');
    assert.equal(log.remotePort, 9443);
    assert.ok(log.durationMs >= 0);
    assert.ok(log.requestId);
    assert.doesNotMatch(output.warnings.join(''), /private-test-key|private-header|127\.123456|apiKey|Authorization/);
  });
}

test('ITS response failure preserves HTTP status and Retry-After without logging response body', async t => {
  const output = network(t, ({ request, socket, onResponse }) => {
    request.emit('socket', socket);
    socket.emit('lookup', null, '192.0.2.1'); socket.emit('connect'); socket.emit('secureConnect');
    const response = Object.assign(new EventEmitter(), { statusCode: 503, headers: { 'retry-after': '30' } });
    onResponse(response);
    response.emit('data', Buffer.from('private-upstream-body'));
    response.emit('end');
  });
  await assert.rejects(httpsGetText(secretUrl), { code: 'ITS_HTTP_STATUS', statusCode: 503, retryAfterMs: 30000 });
  assert.equal(output.diagnostic().phase, 'body');
  assert.equal(output.diagnostic().statusCode, 503);
  assert.ok(output.diagnostic().timings.responseMs >= 0);
  assert.doesNotMatch(output.warnings.join(''), /private-upstream-body|private-test-key/);
});

test('ITS reused socket failure is response waiting, not DNS or TLS failure', async t => {
  const output = network(t, ({ request, socket }) => {
    request.reusedSocket = true;
    socket.connecting = false; socket.secureConnecting = false;
    request.emit('socket', socket);
    request.destroy(Object.assign(new Error(secretUrl), { code: 'ECONNRESET' }));
  });
  await assert.rejects(httpsGetText(secretUrl), { code: 'ECONNRESET' });
  const log = output.diagnostic();
  assert.equal(log.phase, 'response');
  assert.equal(log.reusedSocket, true);
  assert.equal(log.timings.dnsMs, null);
  assert.doesNotMatch(output.warnings.join(''), /private-test-key/);
});

for (const verbose of [false, true]) {
  test(`ITS successful requests log only with diagnostics enabled (${verbose})`, async t => {
    const previous = process.env.ITS_DIAGNOSTICS;
    process.env.ITS_DIAGNOSTICS = verbose ? '1' : '0';
    t.after(() => { if (previous === undefined) delete process.env.ITS_DIAGNOSTICS; else process.env.ITS_DIAGNOSTICS = previous; });
    const output = network(t, ({ request, socket, onResponse }) => {
      request.emit('socket', socket);
      socket.emit('lookup', null, '192.0.2.1'); socket.emit('connect'); socket.emit('secureConnect');
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      onResponse(response);
      response.emit('data', Buffer.from('private-success-body')); response.emit('end');
    });
    assert.equal(await httpsGetText(secretUrl), 'private-success-body');
    assert.equal(output.warnings.length, 0);
    assert.equal(output.info.length, verbose ? 1 : 0);
    if (verbose) {
      const log = JSON.parse(output.info[0].slice('[ITS_HTTP] '.length));
      assert.equal(log.phase, 'complete'); assert.equal(log.statusCode, 200);
      assert.doesNotMatch(output.info[0], /private-test-key|private-success-body/);
    }
  });
}
