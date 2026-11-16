'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { SapClient, parseSapMessages } = require('../lib/client');
const { send } = require('../lib/http');
const { buildJsonBatch, parseJsonBatch } = require('../lib/batch');
const { negotiateToken, spnFor } = require('../lib/negotiate');
const optional = require('../lib/optional');
const { createMockSap, json, text } = require('./helpers/mock-sap');
const { createMockProxy } = require('./helpers/mock-proxy');

const SVC = '/sap/opu/odata/sap/API_TEST';

let mock;
test.before(async () => {
  mock = await createMockSap();
});
test.after(() => mock.close());
test.beforeEach(() => mock.reset());

const fakeKerberos = () => ({
  GSS_MECH_OID_SPNEGO: 'spnego',
  services: [],
  async initializeClient(service) {
    this.services.push(service);
    return { step: async (challenge) => (challenge === 'empty' ? '' : `TOKEN-${service}`) };
  },
});

// ------------------------------------------------------------------ optional / negotiate

test('optional.load: friendly message, overrides, other errors rethrown', () => {
  assert.throws(() => optional.load('kerberos'), /Kerberos \/ SPNEGO \(Negotiate\) authentication needs the optional package "kerberos"\. Install it .*npm install kerberos/);
  assert.throws(() => optional.load('not-installed-package-xyz'), /^Error: not-installed-package-xyz needs the optional package "not-installed-package-xyz"/);
  assert.throws(() => optional.load(path.join(__dirname, 'fixtures/modules/throws.js')), /boom while loading/);
  assert.throws(() => optional.load(path.join(__dirname, 'fixtures/modules/nested.js')), /Cannot find module 'a-dependency-that-is-not-installed-xyz'/);
  const fake = {};
  optional.set('kerberos', fake);
  assert.equal(optional.load('kerberos'), fake);
  optional.set('kerberos', undefined);
  assert.throws(() => optional.load('kerberos'), /optional package/);
});

test('negotiate: SPN per platform, token, empty token', async () => {
  assert.equal(spnFor('sap.corp', undefined, 'win32'), 'HTTP/sap.corp');
  assert.equal(spnFor('sap.corp', undefined, 'linux'), 'HTTP@sap.corp');
  assert.equal(spnFor('sap.corp', 'HTTP/other@REALM'), 'HTTP/other@REALM');
  assert.equal(spnFor('sap.corp'), process.platform === 'win32' ? 'HTTP/sap.corp' : 'HTTP@sap.corp');
  const k = fakeKerberos();
  optional.set('kerberos', k);
  try {
    assert.equal(await negotiateToken('h', { spn: 'S' }), 'TOKEN-S');
    await assert.rejects(negotiateToken('h', { spn: 'S', challenge: 'empty' }), /Kerberos returned no token for S/);
  } finally {
    optional.set('kerberos', undefined);
  }
});

// ------------------------------------------------------------------ SAP messages

test('parseSapMessages: V2 sap-message with details, V4 sap-messages, invalid JSON, none', () => {
  assert.deepEqual(parseSapMessages(undefined), []);
  assert.deepEqual(parseSapMessages({}), []);
  assert.deepEqual(
    parseSapMessages({ 'sap-message': JSON.stringify({ code: 'A/1', message: 'Saved', severity: 'success', target: 'x', longtext_url: 'L', details: [{ code: 'A/2', message: 'Note', severity: 'info' }] }) }),
    [
      { code: 'A/1', message: 'Saved', severity: 'success', target: 'x', longtextUrl: 'L' },
      { code: 'A/2', message: 'Note', severity: 'info', target: undefined, longtextUrl: undefined },
    ]
  );
  assert.deepEqual(parseSapMessages({ 'sap-messages': JSON.stringify([{ code: 'B', message: 'W', numericSeverity: 3, target: 't' }]) }), [
    { code: 'B', message: 'W', severity: 'warning', target: 't', longtextUrl: undefined },
  ]);
  assert.deepEqual(parseSapMessages({ 'sap-messages': JSON.stringify({ code: 'C', message: 'E', numericSeverity: 4 }) })[0].severity, 'error');
  assert.deepEqual(parseSapMessages({ 'sap-message': '{broken' }), [{ message: '{broken', severity: 'unknown' }]);
  assert.deepEqual(parseSapMessages({ 'sap-messages': 'nope' }), [{ message: 'nope', severity: 'unknown' }]);
  assert.deepEqual(parseSapMessages({ 'sap-message': JSON.stringify({ code: 'D', message: 'm' }) }), [{ code: 'D', message: 'm', severity: undefined, target: undefined, longtextUrl: undefined }]);
});

test('request() returns SAP messages; client certificate as PFX; proxyFor', async () => {
  mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, {}, { 'sap-message': JSON.stringify({ code: 'X', message: 'hello', severity: 'info' }) }));
  const c = new SapClient({ url: mock.url });
  const r = await c.request('GET', `${SVC}/A`);
  assert.deepEqual(r.messages, [{ code: 'X', message: 'hello', severity: 'info', target: undefined, longtextUrl: undefined }]);
  assert.equal(r.streamed, false);

  const pfx = new SapClient({ url: 'https://h', credentials: { pfx: Buffer.from('PFX').toString('base64'), passphrase: 'p' } });
  assert.equal(pfx.tls.pfx.toString(), 'PFX');
  assert.equal(pfx.tls.passphrase, 'p');

  assert.equal(c.proxyFor('https://x'), null);
  const p = new SapClient({ url: 'https://h', proxy: { url: 'http://proxy:3128', auth: 'ntlm' }, credentials: { proxyUser: 'CORP\\u', proxyPassword: 'pw' } }).proxyFor('https://x');
  assert.equal(p.url.host, 'proxy:3128');
  assert.equal(p.user, 'CORP\\u');
  assert.equal(p.password, 'pw');
  assert.equal(p.auth, 'ntlm');
});

test('requests through a proxy configured on the client (token request and data)', async () => {
  const proxy = await createMockProxy({ auth: 'basic' });
  try {
    mock.on('POST', '/oauth/token', (req, res) => json(res, 200, { access_token: 'T', expires_in: 3600 }));
    mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, { auth: req.headers.authorization }));
    mock.csrf = false;
    const c = new SapClient({
      url: mock.url,
      authType: 'oauth2',
      tokenUrl: `${mock.url}/oauth/token`,
      proxy: { url: proxy.url, auth: 'basic' },
      credentials: { clientId: 'id', clientSecret: 's', proxyUser: 'proxyuser', proxyPassword: 'proxypass' },
    });
    const r = await c.request('GET', `${SVC}/A`);
    assert.equal(r.body.auth, 'Bearer T');
    assert.deepEqual(
      proxy.log.filter((l) => l.type === 'forward').map((l) => new URL(l.url).pathname),
      ['/oauth/token', `${SVC}/A`]
    );
  } finally {
    mock.csrf = true;
    await proxy.close();
  }
});

// ------------------------------------------------------------------ Kerberos to SAP

test('Kerberos / SPNEGO authentication to SAP', async () => {
  const k = fakeKerberos();
  optional.set('kerberos', k);
  try {
    mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, { auth: req.headers.authorization }));
    const c = new SapClient({ url: mock.url, authType: 'kerberos', spn: 'HTTP/sap.corp@CORP' });
    assert.equal((await c.request('GET', `${SVC}/A`)).body.auth, 'Negotiate TOKEN-HTTP/sap.corp@CORP');
    const d = new SapClient({ url: mock.url, authType: 'kerberos' });
    await d.request('GET', `${SVC}/A`);
    assert.equal(k.services[1], spnFor('127.0.0.1'));
  } finally {
    optional.set('kerberos', undefined);
  }
});

// ------------------------------------------------------------------ OAuth 2.0 grants

test('OAuth2 grants: password, SAML 2.0 bearer, JWT bearer; client authentication variants', async () => {
  mock.csrf = false;
  const seen = [];
  mock.on('POST', '/token', (req, res) => {
    seen.push({ form: Object.fromEntries(new URLSearchParams(req.body)), auth: req.headers.authorization });
    json(res, 200, { access_token: `T${seen.length}`, expires_in: 3600 });
  });
  const make = (extra, credentials) => new SapClient({ url: mock.url, authType: 'oauth2', tokenUrl: `${mock.url}/token`, ...extra, credentials });

  await make({ grantType: 'password' }, { clientId: 'c i', clientSecret: 's:x', user: 'U', password: 'P' }).oauthToken();
  assert.deepEqual(seen[0].form, { grant_type: 'password', username: 'U', password: 'P' });
  assert.equal(seen[0].auth, `Basic ${Buffer.from('c%20i:s%3Ax').toString('base64')}`, 'RFC 6749 2.3.1: id and secret form-encoded first');
  await make({ grantType: 'password' }, {}).oauthToken();
  assert.deepEqual(seen[1].form, { grant_type: 'password', username: '', password: '' });

  const xml = '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">?></saml2:Assertion>';
  await make({ grantType: 'saml2-bearer', clientAuth: 'body', scope: 'S' }, { clientId: 'id', clientSecret: 'sec', assertion: `  ${xml} ` }).oauthToken();
  assert.equal(seen[2].form.grant_type, 'urn:ietf:params:oauth:grant-type:saml2-bearer');
  assert.equal(seen[2].form.assertion, Buffer.from(xml).toString('base64url'));
  assert.equal(seen[2].form.client_id, 'id');
  assert.equal(seen[2].form.client_secret, 'sec');
  assert.equal(seen[2].form.scope, 'S');
  assert.equal(seen[2].auth, undefined);

  await make({ grantType: 'jwt-bearer', clientAuth: 'none' }, { clientId: 'id', assertion: 'eyJ.a.b' }).oauthToken();
  assert.deepEqual(seen[3].form, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'eyJ.a.b', client_id: 'id' });
  await make({ grantType: 'saml2-bearer', clientAuth: 'body' }, { assertion: 'already-encoded' }).oauthToken();
  assert.deepEqual(seen[4].form, { grant_type: 'urn:ietf:params:oauth:grant-type:saml2-bearer', assertion: 'already-encoded', client_id: '', client_secret: '' });

  await assert.rejects(make({ grantType: 'jwt-bearer' }, {}).oauthToken(), /jwt-bearer grant needs an assertion/);
  await assert.rejects(make({ grantType: 'implicit' }, {}).oauthToken(), /Unsupported OAuth2 grant type "implicit"/);
  mock.csrf = true;
});

test('OAuth2 refresh token: used when the access token expires, full grant when refresh fails', async () => {
  mock.csrf = false;
  const forms = [];
  let refreshOk = true;
  mock.on('POST', '/token', (req, res) => {
    const form = Object.fromEntries(new URLSearchParams(req.body));
    forms.push(form.grant_type);
    if (form.grant_type === 'refresh_token' && !refreshOk) return json(res, 400, { error: 'invalid_grant' });
    json(res, 200, { access_token: `T${forms.length}`, expires_in: 1, refresh_token: `R${forms.length}` });
  });
  const c = new SapClient({ url: mock.url, authType: 'oauth2', grantType: 'password', tokenUrl: `${mock.url}/token`, credentials: { user: 'u', password: 'p' } });
  assert.equal(await c.oauthToken(), 'T1');
  c.oauth.expires = 0;
  assert.equal(await c.oauthToken(), 'T2');
  assert.equal(c.oauth.refreshToken, 'R2');
  refreshOk = false;
  c.oauth.expires = 0;
  assert.equal(await c.oauthToken(), 'T4');
  assert.deepEqual(forms, ['password', 'refresh_token', 'refresh_token', 'password']);
  mock.csrf = true;
});

// ------------------------------------------------------------------ BTP destinations

function fakeSdk(destinations, headers = {}) {
  const calls = [];
  return {
    calls,
    async getDestination(opts) {
      calls.push(opts);
      return destinations[opts.destinationName] || null;
    },
    async buildHeadersForDestination(dest) {
      return { ...(headers[dest.name] || {}) };
    },
  };
}

test('BTP destination: URL, auth headers, sap-client, cache, errors', async () => {
  assert.throws(() => new SapClient({ authType: 'destination' }), /destination name is required/);
  mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, { auth: req.headers.authorization, client: req.query.get('sap-client'), proxy: req.headers['proxy-authorization'] || null }));
  const sdk = fakeSdk(
    {
      S4: { name: 'S4', url: `${mock.url}/`, authentication: 'BasicAuthentication', sapClient: '200' },
      LEGACY: { name: 'LEGACY', url: mock.url, 'sap-client': '300' },
      NOURL: { name: 'NOURL' },
    },
    { S4: { authorization: 'Basic QQ==', 'Proxy-Authorization': 'Bearer x' } }
  );
  optional.set('@sap-cloud-sdk/connectivity', sdk);
  try {
    const c = new SapClient({ authType: 'destination', destinationName: 'S4', credentials: { userJwt: 'JWT' } });
    let r = await c.request('GET', `${SVC}/A`);
    assert.deepEqual(r.body, { auth: 'Basic QQ==', client: '200', proxy: null });
    assert.deepEqual(sdk.calls[0], { destinationName: 'S4', jwt: 'JWT', useCache: true });
    await c.request('GET', `${SVC}/A`);
    assert.equal(sdk.calls.length, 1, 'destination cached');
    c.destination.expires = 0;
    await c.request('GET', `${SVC}/A`);
    assert.equal(sdk.calls.length, 2, 'refreshed after destinationTtl');

    r = await new SapClient({ authType: 'destination', destinationName: 'LEGACY', client: '100' }).request('GET', `${SVC}/A`);
    assert.equal(r.body.client, '100', 'the connection sap-client wins');
    r = await new SapClient({ authType: 'destination', destinationName: 'LEGACY' }).request('GET', `${SVC}/A`);
    assert.equal(r.body.client, '300');
    assert.equal(sdk.calls.at(-1).jwt, undefined);

    await assert.rejects(new SapClient({ authType: 'destination', destinationName: 'MISSING' }).request('GET', '/x'), /BTP destination "MISSING" not found/);
    await assert.rejects(new SapClient({ authType: 'destination', destinationName: 'NOURL' }).request('GET', '/x'), /BTP destination "NOURL" has no URL/);
  } finally {
    optional.set('@sap-cloud-sdk/connectivity', undefined);
  }
});

test('BTP destination: on-premise through the Connectivity proxy (Cloud Connector location), client certificates', async () => {
  const proxy = await createMockProxy({ auth: 'bearer', token: 'CONN' });
  const port = new URL(proxy.url).port;
  mock.csrf = false;
  mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, { ok: true }));
  const sdk = fakeSdk({
    ONPREM: {
      name: 'ONPREM',
      url: mock.url,
      proxyType: 'OnPremise',
      cloudConnectorLocationId: 'LOC1',
      proxyConfiguration: { host: '127.0.0.1', port, protocol: 'http', headers: { 'Proxy-Authorization': 'Bearer CONN' } },
    },
    NOPROTO: { name: 'NOPROTO', url: mock.url, proxyConfiguration: { host: '127.0.0.1', port } },
    CERT: { name: 'CERT', url: mock.url, authentication: 'ClientCertificateAuthentication', keyStoreName: 'ks.p12', keyStorePassword: 'pw', certificates: [{ name: 'ks.p12', content: Buffer.from('P12').toString('base64') }] },
    BADCERT: { name: 'BADCERT', url: mock.url, authentication: 'ClientCertificateAuthentication', keyStoreName: 'missing.p12' },
  });
  optional.set('@sap-cloud-sdk/connectivity', sdk);
  try {
    const r = await new SapClient({ authType: 'destination', destinationName: 'ONPREM' }).request('GET', `${SVC}/A`);
    assert.deepEqual(r.body, { ok: true });
    assert.ok(proxy.log.some((l) => l.type === 'forward'), 'through the Connectivity proxy');
    const fwd = proxy.log.find((l) => l.type === 'request');
    assert.equal(fwd.headers['sap-connectivity-scc-location_id'], 'LOC1');

    const np = new SapClient({ authType: 'destination', destinationName: 'NOPROTO' });
    await np.resolveDestination();
    assert.equal(np.destination.proxy.url.protocol, 'http:');
    assert.deepEqual(np.destination.proxy.headers, {});

    const cert = new SapClient({ authType: 'destination', destinationName: 'CERT' });
    await cert.resolveDestination();
    assert.equal(cert.destination.tls.pfx.toString(), 'P12');
    assert.equal(cert.destination.tls.passphrase, 'pw');
    assert.deepEqual((await cert.request('GET', `${SVC}/A`)).body, { ok: true }, 'http target: the PFX is not used');

    await assert.rejects(new SapClient({ authType: 'destination', destinationName: 'BADCERT' }).request('GET', '/x'), /key store "missing.p12" not found/);
  } finally {
    mock.csrf = true;
    optional.set('@sap-cloud-sdk/connectivity', undefined);
    await proxy.close();
  }
});

// ------------------------------------------------------------------ streaming

class Sink extends Writable {
  constructor(fail) {
    super();
    this.chunks = [];
    this.fail = fail;
  }

  _write(chunk, enc, cb) {
    if (this.fail) return cb(new Error('disk full'));
    this.chunks.push(chunk);
    cb();
  }

  get text() {
    return Buffer.concat(this.chunks).toString();
  }
}

test('streaming: response into a sink (identity and gzip), errors stay buffered, upload from a stream factory', async () => {
  mock.on('GET', '/plain', (req, res) => text(res, 200, 'hello stream'));
  mock.on('GET', '/gz', (req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/octet-stream' });
    res.end(zlib.gzipSync(Buffer.from('zipped stream')));
  });
  mock.on('GET', '/missing', (req, res) => json(res, 404, { error: { message: { value: 'gone' } } }));
  for (const [route, enc, fn] of [['/df', 'deflate', zlib.deflateSync], ['/br', 'br', zlib.brotliCompressSync]]) {
    mock.on('GET', route, (req, res) => {
      res.writeHead(200, { 'content-encoding': enc });
      res.end(fn(Buffer.from(`${enc} stream`)));
    });
  }
  mock.on('PUT', '/upload', (req, res) => json(res, 200, { got: req.body, len: req.headers['content-length'] || null, te: req.headers['transfer-encoding'] || null }));
  mock.csrf = false;
  try {
    let sink = new Sink();
    let r = await send({ method: 'GET', url: `${mock.url}/plain`, sink });
    assert.equal(r.streamed, true);
    assert.equal(r.body.length, 0);
    assert.equal(sink.text, 'hello stream');

    sink = new Sink();
    await send({ method: 'GET', url: `${mock.url}/gz`, sink });
    assert.equal(sink.text, 'zipped stream');

    for (const enc of ['df', 'br']) {
      sink = new Sink();
      await send({ method: 'GET', url: `${mock.url}/${enc}`, sink });
      assert.equal(sink.text, `${enc === 'df' ? 'deflate' : 'br'} stream`);
    }

    sink = new Sink();
    r = await send({ method: 'GET', url: `${mock.url}/missing`, sink });
    assert.equal(r.statusCode, 404);
    assert.equal(r.streamed, undefined);
    assert.match(r.body.toString(), /gone/);
    assert.equal(sink.text, '');

    await assert.rejects(send({ method: 'GET', url: `${mock.url}/plain`, sink: new Sink(true) }), /disk full/);

    r = await send({ method: 'PUT', url: `${mock.url}/upload`, body: () => Readable.from([Buffer.from('a'), Buffer.from('b')]) });
    assert.deepEqual(JSON.parse(r.body), { got: 'ab', len: null, te: 'chunked' });
    r = await send({ method: 'PUT', url: `${mock.url}/upload`, body: () => 'from factory' });
    assert.deepEqual(JSON.parse(r.body), { got: 'from factory', len: '12', te: null });

    const broken = new Readable({ read() {} });
    const p = send({ method: 'PUT', url: `${mock.url}/upload`, body: broken });
    setImmediate(() => broken.destroy(new Error('source failed')));
    await assert.rejects(p, /source failed/);
  } finally {
    mock.csrf = true;
  }
});

test('client.request: streamed download, upload stream re-created for the CSRF retry', async () => {
  mock.on('GET', `${SVC}/`, (req, res) => json(res, 200, {}));
  mock.on('GET', `${SVC}/file/$value`, (req, res) => text(res, 200, 'FILE'));
  mock.on('PUT', `${SVC}/file/$value`, (req, res) => json(res, 204));
  const c = new SapClient({ url: mock.url });
  const sink = new Sink();
  const r = await c.request('GET', `${SVC}/file/$value`, { sink });
  assert.equal(r.streamed, true);
  assert.equal(sink.text, 'FILE');

  let made = 0;
  await c.fetchCsrfToken(SVC);
  c.csrfToken = 'expired';
  await c.request('PUT', `${SVC}/file/$value`, {
    servicePath: SVC,
    body: () => {
      made += 1;
      return Readable.from([Buffer.from('DATA')]);
    },
  });
  assert.equal(made, 2, 'a fresh stream for the retried request');
  assert.equal(mock.last().body, 'DATA');
});

// ------------------------------------------------------------------ JSON batch

test('buildJsonBatch: ids, atomicity groups, dependsOn, bodies, validation', () => {
  const b = buildJsonBatch([
    { url: "/Travel('1')" },
    { method: 'post', url: 'Travel', body: { Memo: 'x' } },
    { method: 'PATCH', url: "Travel('1')", body: 'raw', headers: { 'Content-Type': 'text/plain' }, contentId: 'p', dependsOn: '2' },
    { method: 'GET', url: 'Agency', body: { ignored: true } },
    { method: 'DELETE', url: "Travel('2')", dependsOn: ['p', 2] },
  ]);
  assert.equal(b.contentType, 'application/json');
  assert.deepEqual(JSON.parse(b.body), {
    requests: [
      { id: '1', method: 'GET', url: "Travel('1')", headers: { accept: 'application/json' } },
      { id: '2', method: 'POST', url: 'Travel', headers: { accept: 'application/json', 'content-type': 'application/json' }, atomicityGroup: 'g2', body: { Memo: 'x' } },
      { id: 'p', method: 'PATCH', url: "Travel('1')", headers: { accept: 'application/json', 'Content-Type': 'text/plain' }, atomicityGroup: 'g2', dependsOn: ['2'], body: 'raw' },
      { id: '4', method: 'GET', url: 'Agency', headers: { accept: 'application/json' } },
      { id: '5', method: 'DELETE', url: "Travel('2')", headers: { accept: 'application/json' }, atomicityGroup: 'g4', dependsOn: ['p', '2'] },
    ],
  });
  assert.deepEqual(b.layout, [{ id: '1', group: undefined }, { id: '2', group: 'g2' }, { id: 'p', group: 'g2' }, { id: '4', group: undefined }, { id: '5', group: 'g4' }]);
  assert.throws(() => buildJsonBatch([{ method: 'GET' }]), /needs a "url"/);
  assert.throws(() => buildJsonBatch([]), /non-empty array/);
});

test('parseJsonBatch: aligned by id, failed atomicity group, missing responses', () => {
  const layout = [{ id: '1' }, { id: '2', group: 'g2' }, { id: '3', group: 'g2' }, { id: '4' }, { id: '5', group: 'g5' }, { id: '6', group: 'g5' }];
  const body = {
    responses: [
      { id: '1', status: 200, headers: { 'Content-Type': 'application/json', 'SAP-Messages': '[]' }, body: { value: [] } },
      { id: '2', status: 400, body: { error: { message: 'bad' } } },
      { id: '5', status: 204 },
    ],
  };
  const r = parseJsonBatch(JSON.stringify(body), layout);
  assert.deepEqual(r[0], { status: 200, statusText: '', headers: { 'content-type': 'application/json', 'sap-messages': '[]' }, body: { value: [] }, ok: true });
  assert.equal(r[1].ok, false);
  assert.equal(r[2], r[1], 'the failed group answers for its other requests');
  assert.equal(r[3], null);
  assert.equal(r[4].body, null);
  assert.equal(r[5], null, 'a group that did not fail does not lend a response');
  assert.equal(parseJsonBatch(Buffer.from('{"responses":[{"id":"1","status":"201"}]}'), [{ id: '1' }])[0].status, 201);
  assert.deepEqual(parseJsonBatch({}, [{ id: '1' }]), [null]);
});

// ------------------------------------------------------------------ files

test('temporary files are cleaned up by the node tests', () => {
  // the sap-odata upload/download tests write into the OS temp directory
  assert.ok(fs.existsSync(os.tmpdir()));
});
