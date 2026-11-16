'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CookieJar, send } = require('../lib/http');
const { createMockSap, json, TLS } = require('./helpers/mock-sap');

test('CookieJar - parsing, attributes, expiry and path matching', () => {
  const jar = new CookieJar();
  jar.store(undefined);
  jar.store('SAP_SESSIONID_ABC_100=s1; path=/; HttpOnly; secure');
  jar.store([
    'sap-usercontext=sap-client=100; path=/',
    'noequals',
    '=novalue',
    'scoped=1; Path=/sap/opu',
    'emptypath=1; path=',
    'maxage=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'badmaxage=1; max-age=abc',
    'future=1; expires=Fri, 01 Jan 2100 00:00:00 GMT',
    'badexpires=1; expires=notadate',
  ]);
  assert.equal(jar.size, 8);
  assert.equal(
    jar.header('/sap/opu/odata/sap/X'),
    'SAP_SESSIONID_ABC_100=s1; sap-usercontext=sap-client=100; scoped=1; emptypath=1; maxage=1; badmaxage=1; future=1; badexpires=1'
  );
  assert.equal(jar.header('/other'), 'SAP_SESSIONID_ABC_100=s1; sap-usercontext=sap-client=100; emptypath=1; maxage=1; badmaxage=1; future=1; badexpires=1');

  // server deletes a cookie by sending it already expired
  jar.store('future=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
  jar.store('maxage=; Max-Age=0');
  assert.doesNotMatch(jar.header('/'), /(^|; )future=/);
  assert.doesNotMatch(jar.header('/'), /(^|; )maxage=/);

  // expiry while stored
  jar.cookies.set('old|/', { name: 'old', value: '1', path: '/', expires: Date.now() - 1 });
  assert.ok(!jar.header('/').includes('old='));
  assert.equal(jar.cookies.has('old|/'), false);

  jar.clear();
  assert.equal(jar.size, 0);
  assert.equal(jar.header('/'), '');
});

test('send - http with string, Buffer and empty bodies', async () => {
  const mock = await createMockSap({ csrf: false });
  try {
    mock.on('*', '/echo', (req, res) => json(res, 200, { method: req.method, body: req.body, length: req.headers['content-length'] }));
    let r = await send({ method: 'POST', url: `${mock.url}/echo`, body: 'äb' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.statusMessage, 'OK');
    assert.deepEqual(JSON.parse(r.body.toString()), { method: 'POST', body: 'äb', length: '3' });
    assert.equal(r.url, `${mock.url}/echo`);

    r = await send({ method: 'PUT', url: `${mock.url}/echo`, body: Buffer.from('xy'), headers: { 'Content-Length': 2 } });
    assert.deepEqual(JSON.parse(r.body.toString()), { method: 'PUT', body: 'xy', length: '2' });

    r = await send({ method: 'GET', url: `${mock.url}/echo`, body: null });
    assert.equal(JSON.parse(r.body.toString()).body, '');
    r = await send({ method: 'GET', url: `${mock.url}/echo` });
    assert.equal(JSON.parse(r.body.toString()).method, 'GET');
  } finally {
    await mock.close();
  }
});

test('send - https with CA, rejection of unknown CA and rejectUnauthorized=false', async () => {
  const mock = await createMockSap({ secure: true, csrf: false });
  try {
    mock.on('GET', '/x', (req, res) => json(res, 200, { ok: true }));
    const url = `${mock.url}/x`;
    const r = await send({ method: 'GET', url, tls: { ca: TLS.cert } });
    assert.equal(r.statusCode, 200);
    await assert.rejects(send({ method: 'GET', url }), /self[- ]signed|unable to verify/i);
    const r2 = await send({ method: 'GET', url, tls: { rejectUnauthorized: false, cert: TLS.cert, key: TLS.key, passphrase: 'unused' } });
    assert.equal(r2.statusCode, 200);
  } finally {
    await mock.close();
  }
});

test('send - request target is sent verbatim (OData literals keep their quotes), IPv6 hosts, host-only URLs', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '::1', r));
  const { port } = server.address();
  try {
    await send({ method: 'GET', url: `http://[::1]:${port}/sap/A('1')?$filter=Name%20eq%20'O''Neil'` });
    await send({ method: 'GET', url: `http://[::1]:${port}` });
    assert.deepEqual(seen, ["/sap/A('1')?$filter=Name%20eq%20'O''Neil'", '/']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('send - compressed responses (gzip, x-gzip, deflate, br, identity) and corrupt bodies', async () => {
  const zlib = require('node:zlib');
  const payload = Buffer.from('{"d":{"ok":true}}');
  const encoders = { gzip: zlib.gzipSync, 'x-gzip': zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, identity: (b) => b, ' GZIP ': zlib.gzipSync };
  let acceptEncoding;
  const server = http.createServer((req, res) => {
    acceptEncoding = req.headers['accept-encoding'];
    const enc = decodeURIComponent(req.url.slice(1));
    if (enc === 'corrupt') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('not gzip');
      return;
    }
    res.writeHead(200, { 'content-encoding': enc });
    res.end(encoders[enc](payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const enc of Object.keys(encoders)) {
      const r = await send({ method: 'GET', url: `${base}/${encodeURIComponent(enc)}` });
      assert.equal(r.body.toString(), payload.toString(), enc);
    }
    assert.equal(acceptEncoding, 'gzip, deflate, br');
    await send({ method: 'GET', url: `${base}/identity`, headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(acceptEncoding, 'identity');
    await assert.rejects(send({ method: 'GET', url: `${base}/corrupt` }), /Could not decode gzip response from GET/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('send - timeout and connection errors', async () => {
  const server = http.createServer(() => {
    /* never answers */
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await assert.rejects(send({ method: 'GET', url: `http://127.0.0.1:${port}/slow`, timeout: 50 }), /timed out after 50 ms: GET/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(send({ method: 'GET', url: `http://127.0.0.1:${port}/gone` }), /ECONNREFUSED/);
});
