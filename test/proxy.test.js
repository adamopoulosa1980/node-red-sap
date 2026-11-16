'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { resolveProxy, bypass, proxyHeaders, openSocket, ntlmConnect, proxyPort } = require('../lib/proxy');
const { send } = require('../lib/http');
const optional = require('../lib/optional');
const { createMockSap, json, TLS } = require('./helpers/mock-sap');
const { createMockProxy } = require('./helpers/mock-proxy');

const fakeKerberos = (token = 'TOKEN') => ({
  GSS_MECH_OID_SPNEGO: 'spnego',
  calls: [],
  async initializeClient(service, opts) {
    this.calls.push({ service, opts });
    return { step: async (challenge) => (challenge === 'empty' ? '' : token) };
  },
});

test('bypass (NO_PROXY rules)', () => {
  assert.equal(bypass('a.example.com', 443, ''), false);
  assert.equal(bypass('a.example.com', 443, undefined), false);
  assert.equal(bypass('anything', 80, '*'), true);
  assert.equal(bypass('example.com', 443, 'example.com'), true);
  assert.equal(bypass('a.example.com', 443, 'example.com'), true);
  assert.equal(bypass('badexample.com', 443, 'example.com'), false);
  assert.equal(bypass('a.example.com', 443, '.example.com'), true);
  assert.equal(bypass('A.Example.COM', 443, ' , *.example.com'), true);
  assert.equal(bypass('sap01.corp', 443, 'sap*.corp'), true);
  assert.equal(bypass('host', 8080, 'host:8080'), true);
  assert.equal(bypass('host', 443, 'host:8080'), false);
  assert.equal(bypass('10.1.2.3', 80, '10.0.0.0/8'), true);
  assert.equal(bypass('11.1.2.3', 80, '10.0.0.0/8'), false);
  assert.equal(bypass('host.name', 80, '10.0.0.0/8'), false);
  assert.equal(bypass('[fd00::1]', 80, 'fd00::/8'), true);
  assert.equal(bypass('fd00::1', 80, '[fd00::1]:80'), true);
  assert.equal(bypass('10.1.2.3', 80, 'fd00::/8'), false);
  assert.equal(bypass('10.1.2.3', 80, '10.0.0.0/99'), false); // invalid prefix
  assert.equal(bypass('::1', 80, '::1'), true);
});

test('resolveProxy: manual, environment, credentials, bypass', () => {
  assert.equal(resolveProxy('https://sap'), null);
  assert.equal(resolveProxy('https://sap', { useEnv: true }, {}), null);

  let p = resolveProxy('https://sap:44300', { url: 'proxy.corp:8080', noProxy: 'other' });
  assert.equal(p.url.href, 'http://proxy.corp:8080/');
  assert.equal(p.auth, 'none');
  assert.deepEqual(p.headers, {});
  assert.equal(resolveProxy('https://sap.corp', { url: 'http://p:1', noProxy: '.corp' }), null);
  assert.equal(resolveProxy('http://sap.corp', { url: 'http://p:1', noProxy: 'sap.corp:80' }), null);

  p = resolveProxy('https://sap', { url: 'http://u%40x:p%3Ass@p:1' });
  assert.equal(p.user, 'u@x');
  assert.equal(p.password, 'p:ss');
  assert.equal(p.auth, 'basic');
  assert.equal(p.url.username, '');
  p = resolveProxy('https://sap', { url: 'http://p:1', auth: 'ntlm', user: 'CORP\\u', password: 'pw', domain: 'D', workstation: 'W', spn: 'S', token: 'T', headers: { X: '1' } });
  assert.deepEqual({ ...p, url: p.url.href }, { url: 'http://p:1/', auth: 'ntlm', user: 'CORP\\u', password: 'pw', domain: 'D', workstation: 'W', spn: 'S', token: 'T', headers: { X: '1' } });

  const env = { HTTPS_PROXY: 'http://secure:1', http_proxy: 'http://plain:2', NO_PROXY: 'skip.me' };
  assert.equal(resolveProxy('https://sap', { useEnv: true }, env).url.host, 'secure:1');
  assert.equal(resolveProxy('http://sap', { useEnv: true }, env).url.host, 'plain:2');
  assert.equal(resolveProxy('https://skip.me', { useEnv: true }, env), null);
  assert.equal(resolveProxy('https://sap', { useEnv: true }, { ALL_PROXY: 'http://all:3', no_proxy: 'x' }).url.host, 'all:3');
  assert.equal(resolveProxy('http://sap', { useEnv: true }, { all_proxy: 'http://all:4' }).url.host, 'all:4');
  assert.equal(resolveProxy('http://sap', { useEnv: true }, { https_proxy: 'http://s:1' }), null);
  assert.equal(resolveProxy('https://sap', { useEnv: true }, { https_proxy: 'http://s:5' }).url.host, 's:5');
  assert.equal(resolveProxy('http://sap', { useEnv: true }, { HTTP_PROXY: 'http://h:6' }).url.host, 'h:6');
});

test('proxyHeaders and proxyPort', async () => {
  const base = { url: new URL('http://p:1'), headers: { 'SAP-Connectivity-SCC-Location_ID': 'LOC' } };
  assert.deepEqual(await proxyHeaders({ ...base, auth: 'none' }), { 'SAP-Connectivity-SCC-Location_ID': 'LOC' });
  assert.equal((await proxyHeaders({ ...base, auth: 'basic', user: 'u', password: 'p' }))['Proxy-Authorization'], `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal((await proxyHeaders({ ...base, auth: 'bearer', token: 'T' }))['Proxy-Authorization'], 'Bearer T');
  const k = fakeKerberos('NEG');
  optional.set('kerberos', k);
  try {
    assert.equal((await proxyHeaders({ ...base, auth: 'negotiate' }))['Proxy-Authorization'], 'Negotiate NEG');
    assert.match(k.calls[0].service, /^HTTP[/@]p$/);
    assert.equal(k.calls[0].opts.mechOID, 'spnego');
    await proxyHeaders({ ...base, auth: 'negotiate', spn: 'HTTP/proxy.corp@CORP' });
    assert.equal(k.calls[1].service, 'HTTP/proxy.corp@CORP');
  } finally {
    optional.set('kerberos', undefined);
  }
  assert.equal(proxyPort(new URL('http://p')), 80);
  assert.equal(proxyPort(new URL('https://p')), 443);
  assert.equal(proxyPort(new URL('http://p:3128')), 3128);
});

// ---------------------------------------------------------------- end-to-end

let sap;
let sapTls;
test.before(async () => {
  sap = await createMockSap({ csrf: false });
  sapTls = await createMockSap({ secure: true, csrf: false });
  for (const m of [sap, sapTls]) {
    m.on('*', /.*/, (req, res) => json(res, 200, { method: req.method, url: req.url, body: req.body, auth: req.headers.authorization, proxyAuth: req.headers['proxy-authorization'] || null }));
  }
});
test.after(async () => {
  await sap.close();
  await sapTls.close();
});

const PATH = "/sap/opu/odata/sap/X/A('1')?$filter=N%20eq%20'O''N'";
const tlsOpts = { ca: TLS.cert };

async function viaProxy(proxyOptions, targetUrl, extra = {}, sendOpts = {}) {
  const proxy = await createMockProxy(proxyOptions);
  try {
    const p = resolveProxy(targetUrl, { url: proxy.url, ...extra });
    const res = await send({ method: 'POST', url: targetUrl, body: 'payload', tls: { ...tlsOpts, ...(sendOpts.tls || {}) }, proxy: p, timeout: 5000 });
    // the request really travelled through the proxy (no silent direct connection)
    const expected = targetUrl.startsWith('https') ? 'tunnel' : 'forward';
    assert.ok(proxy.log.some((l) => l.type === expected), `request did not go through the proxy (${expected})`);
    return { res, body: JSON.parse(res.body.toString()), log: proxy.log };
  } finally {
    await proxy.close();
  }
}

test('http target via HTTP proxy: absolute-form request, path sent verbatim, Basic auth', async () => {
  const { body, log } = await viaProxy({ auth: 'basic' }, `${sap.url}${PATH}`, { auth: 'basic', user: 'proxyuser', password: 'proxypass' });
  assert.equal(body.url, PATH);
  assert.equal(body.body, 'payload');
  assert.equal(body.proxyAuth, null, 'Proxy-Authorization is not forwarded');
  assert.equal(log[0].url, `${sap.url}${PATH}`);
});

test('https target via HTTP proxy: CONNECT tunnel (https-proxy-agent) with Basic, Bearer + extra headers', async () => {
  let r = await viaProxy({ auth: 'basic' }, `${sapTls.url}${PATH}`, { auth: 'basic', user: 'proxyuser', password: 'proxypass' });
  assert.equal(r.body.url, PATH);
  assert.equal(r.log[0].type, 'connect');
  assert.equal(r.log[0].url, `127.0.0.1:${new URL(sapTls.url).port}`);

  r = await viaProxy({ auth: 'bearer', token: 'BTP' }, `${sapTls.url}/x`, { auth: 'bearer', token: 'BTP', headers: { 'SAP-Connectivity-SCC-Location_ID': 'LOC1' } });
  assert.equal(r.log[0].headers['sap-connectivity-scc-location_id'], 'LOC1');
});

test('proxy authentication failure is reported, credentials are not leaked to the target', async () => {
  const proxy = await createMockProxy({ auth: 'basic' });
  try {
    const p = resolveProxy(`${sap.url}/x`, { url: proxy.url });
    const res = await send({ method: 'GET', url: `${sap.url}/x`, proxy: p });
    assert.equal(res.statusCode, 407);
    const p2 = resolveProxy(`${sapTls.url}/x`, { url: proxy.url });
    const res2 = await send({ method: 'GET', url: `${sapTls.url}/x`, proxy: p2, tls: tlsOpts });
    assert.equal(res2.statusCode, 407);
  } finally {
    await proxy.close();
  }
});

test('HTTPS proxy (TLS to the proxy) for http and https targets', async () => {
  let r = await viaProxy({ secure: true }, `${sap.url}/plain`);
  assert.equal(r.body.url, '/plain');
  r = await viaProxy({ secure: true }, `${sapTls.url}/tls`);
  assert.equal(r.body.url, '/tls');
});

test('Negotiate (Kerberos) proxy authentication', async () => {
  const k = fakeKerberos('KRB');
  optional.set('kerberos', k);
  try {
    let r = await viaProxy({ auth: 'negotiate', token: 'KRB' }, `${sapTls.url}/n`, { auth: 'negotiate' });
    assert.equal(r.body.url, '/n');
    r = await viaProxy({ auth: 'negotiate', token: 'KRB' }, `${sap.url}/n`, { auth: 'negotiate' });
    assert.equal(r.body.url, '/n');
  } finally {
    optional.set('kerberos', undefined);
  }
});

test('NTLMv2 proxy authentication: CONNECT tunnel and absolute-form, verified by the proxy', async () => {
  const creds = { auth: 'ntlm', user: 'CORP\\proxyuser', password: 'proxypass' };
  let r = await viaProxy({ auth: 'ntlm' }, `${sapTls.url}${PATH}`, creds);
  assert.equal(r.body.url, PATH);
  assert.deepEqual(
    r.log.map((l) => l.type),
    ['connect', 'connect', 'tunnel']
  );
  r = await viaProxy({ auth: 'ntlm' }, `${sap.url}${PATH}`, { auth: 'ntlm', user: 'proxyuser', password: 'proxypass', domain: 'CORP', workstation: 'WS1' });
  assert.equal(r.body.url, PATH);
  assert.equal(r.body.body, 'payload');
  assert.deepEqual(
    r.log.filter((l) => l.type === 'request').map((l) => l.method),
    ['HEAD', 'POST']
  );
  // over an HTTPS proxy
  r = await viaProxy({ auth: 'ntlm', secure: true }, `${sap.url}/s`, creds);
  assert.equal(r.body.url, '/s');
  r = await viaProxy({ auth: 'ntlm', secure: true }, `${sapTls.url}/s`, { ...creds, headers: { 'X-Extra': '1' } });
  assert.equal(r.body.url, '/s');
});

test('NTLM failures: wrong password, no challenge, bad challenge, closed connection, refused CONNECT', async () => {
  await assert.rejects(viaProxy({ auth: 'ntlm' }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'CORP\\proxyuser', password: 'wrong' }), /Proxy CONNECT 127\.0\.0\.1:\d+ failed: HTTP 407/);
  await assert.rejects(viaProxy({ auth: 'none' }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'u', password: 'p' }), /did not answer with an NTLM challenge/);
  await assert.rejects(viaProxy({ auth: 'basic' }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'u', password: 'p' }), /did not answer with an NTLM challenge \(HTTP 407/);
  await assert.rejects(viaProxy({ auth: 'ntlm', badChallenge: true }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'u', password: 'p' }), /Invalid NTLM challenge \(type 2\) from proxy/);
  await assert.rejects(viaProxy({ auth: 'ntlm', closeAfter407: true }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'CORP\\proxyuser', password: 'proxypass' }), /closed the connection|ECONNRESET|socket hang up/);
  await assert.rejects(viaProxy({ rejectConnect: true }, `${sapTls.url}/x`, { auth: 'ntlm', user: 'u', password: 'p' }), /HTTP 403/);
});

test('openSocket: connection refused, timeout, IP and host names for TLS proxies', async () => {
  const free = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
  await assert.rejects(openSocket({ url: new URL(`http://127.0.0.1:${free}`) }, 1000, {}), /ECONNREFUSED/);

  const accepted = [];
  const silent = net.createServer((s) => accepted.push(s)); // accepts TCP but never speaks TLS
  await new Promise((r) => silent.listen(0, 'localhost', r));
  try {
    await assert.rejects(openSocket({ url: new URL(`https://localhost:${silent.address().port}`) }, 100, { rejectUnauthorized: false }), /timed out after 100 ms/);
  } finally {
    accepted.forEach((s) => s.destroy());
    await new Promise((r) => silent.close(r));
  }
});

test('ntlmConnect error path destroys the socket', async () => {
  const proxy = await createMockProxy({ auth: 'none' });
  try {
    const p = resolveProxy('https://x', { url: proxy.url, auth: 'ntlm', user: 'u', password: 'p' });
    await assert.rejects(ntlmConnect(p, { mode: 'http', host: 'x', port: 80, url: 'http://127.0.0.1:1/' }, 1000, {}), /did not answer with an NTLM challenge/);
  } finally {
    await proxy.close();
  }
});

test('NTLM tunnel to a host name: TLS with SNI (servername) and certificate check by name', async () => {
  const proxy = await createMockProxy({ auth: 'ntlm' });
  try {
    const target = `https://localhost:${new URL(sapTls.url).port}/sni`;
    const p = resolveProxy(target, { url: proxy.url, auth: 'ntlm', user: 'CORP\\proxyuser', password: 'proxypass' });
    const res = await send({ method: 'GET', url: target, tls: tlsOpts, proxy: p, timeout: 5000 });
    assert.equal(JSON.parse(res.body.toString()).url, '/sni');
    assert.ok(proxy.log.some((l) => l.type === 'tunnel'));
  } finally {
    await proxy.close();
  }
});
