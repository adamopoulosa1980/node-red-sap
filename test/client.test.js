'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SapClient, SapError, parseError } = require('../lib/client');
const { createMockSap, json, text } = require('./helpers/mock-sap');
const { V2 } = require('./fixtures/metadata');

const SVC = '/sap/opu/odata/sap/API_TEST';

let mock;
test.before(async () => {
  mock = await createMockSap();
});
test.after(() => mock.close());
test.beforeEach(() => mock.reset());

const serviceDoc = (req, res) => json(res, 200, { d: { EntitySets: ['A'] } });

test('constructor validation', () => {
  assert.throws(() => new SapClient(), /URL is required/);
  assert.throws(() => new SapClient({}), /URL is required/);
  const c = new SapClient({ url: 'https://h:1/' });
  assert.equal(c.baseUrl, 'https://h:1');
  assert.deepEqual(c.credentials, {});
  assert.equal(c.cfg.authType, 'basic');
  assert.deepEqual(c.tls, { rejectUnauthorized: true, ca: undefined, cert: undefined, key: undefined, passphrase: undefined });
  const c2 = new SapClient({ url: 'https://h', rejectUnauthorized: false, credentials: { ca: 'CA' } });
  assert.equal(c2.tls.rejectUnauthorized, false);
  assert.equal(c2.tls.ca, 'CA');
});

test('absoluteUrl adds sap-client and sap-language once', () => {
  const c = new SapClient({ url: 'https://h', client: '100', language: 'EN' });
  assert.equal(c.absoluteUrl('/sap/x'), 'https://h/sap/x?sap-client=100&sap-language=EN');
  assert.equal(c.absoluteUrl('sap/x', '?$top=1'), 'https://h/sap/x?$top=1&sap-client=100&sap-language=EN');
  assert.equal(c.absoluteUrl('https://o/sap/x?sap-client=200&sap-language=DE'), 'https://o/sap/x?sap-client=200&sap-language=DE');
  assert.equal(c.absoluteUrl('/sap/x', 'sap-client=300&sap-language=EL'), 'https://h/sap/x?sap-client=300&sap-language=EL');
  const plain = new SapClient({ url: 'https://h' });
  assert.equal(plain.absoluteUrl('/sap/x'), 'https://h/sap/x');
  assert.equal(plain.absoluteUrl('/sap/x?a=1', 'b=2'), 'https://h/sap/x?a=1&b=2');
});

test('authHeader for each auth type', async () => {
  assert.equal(await new SapClient({ url: 'h', credentials: { user: 'u', password: 'p' } }).authHeader(), `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(await new SapClient({ url: 'h', credentials: { user: 'u' } }).authHeader(), `Basic ${Buffer.from('u:').toString('base64')}`);
  assert.equal(await new SapClient({ url: 'h' }).authHeader(), undefined);
  assert.equal(await new SapClient({ url: 'h', authType: 'bearer', credentials: { token: 't' } }).authHeader(), 'Bearer t');
  assert.equal(await new SapClient({ url: 'h', authType: 'bearer' }).authHeader(), undefined);
  assert.equal(await new SapClient({ url: 'h', authType: 'cert' }).authHeader(), undefined);
  assert.equal(await new SapClient({ url: 'h', authType: 'none' }).authHeader(), undefined);
});

test('parseError - SAP V2 JSON with errordetails', () => {
  const body = JSON.stringify({
    error: {
      code: 'SY/530',
      message: { lang: 'en', value: 'Business partner 1 not found' },
      innererror: { errordetails: [{ code: 'R1/001', message: 'detail', severity: 'error', propertyref: 'Partner' }] },
    },
  });
  assert.deepEqual(parseError(404, { 'content-type': 'application/json' }, body), {
    code: 'SY/530',
    message: 'Business partner 1 not found',
    details: [{ code: 'R1/001', message: 'detail', severity: 'error', target: 'Partner' }],
    body: JSON.parse(body),
  });
});

test('parseError - V4 JSON, XML, text and empty bodies', () => {
  const v4 = parseError(400, {}, JSON.stringify({ error: { code: 'X', message: 'Bad', details: [{ code: 'D', message: { value: 'dm' }, target: 'f' }] } }));
  assert.equal(v4.message, 'Bad');
  assert.deepEqual(v4.details, [{ code: 'D', message: 'dm', severity: undefined, target: 'f' }]);
  assert.equal(parseError(500, {}, '{"message":"top level"}').message, 'top level');
  assert.equal(parseError(500, {}, '{"error":{"message":null}}').message, '{"error":{"message":null}}');
  assert.equal(parseError(500, {}, '{"error":{"details":[{"message":null}]}}').details[0].message, null);
  assert.equal(parseError(500, { 'content-type': 'application/json' }, 'not json').message, 'not json');

  const xml = '<?xml version="1.0"?><error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><code>/IWBEP/CM_MGW_RT/020</code><message xml:lang="en">Resource not found</message></error>';
  assert.deepEqual(parseError(404, { 'content-type': 'application/xml' }, xml), { code: '/IWBEP/CM_MGW_RT/020', message: 'Resource not found', details: [], body: xml });
  assert.equal(parseError(404, {}, '<m:error><m:code>C</m:code><m:message>M</m:message></m:error>').message, 'M');
  assert.equal(parseError(500, {}, '<html><body><h1>Internal   error</h1></body></html>').message, 'Internal error');
  assert.equal(parseError(403, { 'content-type': 'text/plain' }, 'CSRF token validation failed').message, 'CSRF token validation failed');
  assert.equal(parseError(502, undefined, '').message, 'HTTP 502');
  assert.equal(parseError(502, undefined, undefined).message, 'HTTP 502');
  assert.equal(parseError(500, {}, 'x'.repeat(400)).message.length, 300);
});

test('SapError', () => {
  const e = new SapError('m');
  assert.deepEqual(e.details, []);
  const e2 = new SapError('m', { statusCode: 400, code: 'C', details: [1], body: {}, url: 'u', method: 'GET' });
  assert.deepEqual(e2.toJSON(), { message: 'm', statusCode: 400, code: 'C', details: [1], url: 'u', method: 'GET' });
  assert.equal(e2.name, 'SapError');
});

test('GET: basic auth, sap-client, extra headers, JSON parsing', async () => {
  mock.on('GET', `${SVC}/A`, (req, res) => json(res, 200, { d: { results: [{ Id: '1' }] } }));
  const c = new SapClient({ url: mock.url, client: '100', credentials: { user: 'u', password: 'p' }, headers: { 'X-Custom': '1' } });
  const r = await c.request('get', `${SVC}/A`, { query: '$top=1' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { d: { results: [{ Id: '1' }] } });
  const req = mock.last();
  assert.equal(req.url, `${SVC}/A?$top=1&sap-client=100`);
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(req.headers.accept, 'application/json');
  assert.equal(req.headers['x-custom'], '1');
  assert.equal(req.headers['x-csrf-token'], undefined);
});

test('POST: CSRF token fetched with session cookies and reused', async () => {
  mock.on('GET', `${SVC}/`, serviceDoc);
  mock.on('POST', `${SVC}/A`, (req, res) => json(res, 201, { d: { Id: '2', body: JSON.parse(req.body) } }));
  mock.on('DELETE', `${SVC}/A`, (req, res) => json(res, 204));
  const c = new SapClient({ url: mock.url, authType: 'none' });
  const r = await c.request('POST', `${SVC}/A`, { body: { Name: 'x' }, servicePath: SVC });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.body.d.body, { Name: 'x' });
  const [fetch, post] = mock.requests;
  assert.equal(fetch.method, 'GET');
  assert.equal(fetch.headers['x-csrf-token'], 'Fetch');
  assert.equal(fetch.path, `${SVC}/`);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.match(post.headers.cookie, /SAP_SESSIONID_ABC_100=/);
  assert.match(post.headers.cookie, /sap-usercontext=/);
  assert.equal(post.headers.authorization, undefined);

  await c.request('DELETE', `${SVC}/A`, { servicePath: SVC });
  assert.equal(mock.requests.length, 3, 'token is cached');
});

test('CSRF: concurrent requests share one fetch; expired token refreshed once', async () => {
  mock.on('GET', `${SVC}/`, serviceDoc);
  mock.on('POST', `${SVC}/A`, (req, res) => json(res, 201, { d: {} }));
  const c = new SapClient({ url: mock.url });
  await Promise.all([c.request('POST', `${SVC}/A`, { servicePath: SVC }), c.request('POST', `${SVC}/A`, { servicePath: SVC })]);
  assert.equal(mock.requests.filter((r) => r.headers['x-csrf-token'] === 'Fetch').length, 1);

  mock.expireTokens();
  mock.requests.length = 0;
  const r = await c.request('POST', `${SVC}/A`, { servicePath: SVC });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(
    mock.requests.map((x) => `${x.method} ${x.headers['x-csrf-token'] === 'Fetch' ? 'fetch' : ''}`),
    ['POST ', 'GET fetch', 'POST ']
  );
});

test('CSRF: default fetch target is the catalog service; failures are reported', async () => {
  mock.on('GET', '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/', serviceDoc);
  mock.on('POST', '/x', (req, res) => json(res, 204));
  const c = new SapClient({ url: mock.url });
  const r = await c.request('POST', '/x', { body: 'raw', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.statusCode, 204);
  assert.equal(r.body, '');
  assert.equal(mock.last().headers['content-type'], 'text/plain');

  // fetch denied
  mock.reset();
  mock.on('GET', `${SVC}/`, (req, res) => json(res, 401, { error: { code: 'AUTH', message: { value: 'Logon failed' } } }));
  const c2 = new SapClient({ url: mock.url });
  await assert.rejects(c2.request('POST', `${SVC}/A`, { servicePath: SVC }), (e) => e instanceof SapError && e.statusCode === 401 && /CSRF token fetch failed: Logon failed/.test(e.message));

  // no token returned
  mock.reset();
  mock.csrf = false;
  mock.on('GET', `${SVC}/`, serviceDoc);
  await assert.rejects(new SapClient({ url: mock.url }).request('POST', `${SVC}/A`, { servicePath: SVC }), /did not return an X-CSRF-Token/);

  // token "Required" returned on fetch (CSRF protection mis-configured)
  mock.reset();
  mock.on('GET', `${SVC}/`, (req, res) => json(res, 200, {}, { 'x-csrf-token': 'Required' }));
  await assert.rejects(new SapClient({ url: mock.url }).request('POST', `${SVC}/A`, { servicePath: SVC }), /did not return an X-CSRF-Token/);
  mock.csrf = true;
});

test('CSRF: second 403 Required is an error; 403 without Required is not retried', async () => {
  mock.on('GET', `${SVC}/`, serviceDoc);
  const c = new SapClient({ url: mock.url });
  let calls = 0;
  mock.on('POST', `${SVC}/A`, (req, res) => {
    calls += 1;
    text(res, 403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' });
  });
  await assert.rejects(c.request('POST', `${SVC}/A`, { servicePath: SVC }), (e) => e.statusCode === 403 && e.method === 'POST');
  assert.equal(calls, 2);

  calls = 0;
  mock.on('POST', `${SVC}/B`, (req, res) => {
    calls += 1;
    json(res, 403, { error: { code: 'AUTH', message: { value: 'No authorization' } } });
  });
  await assert.rejects(c.request('POST', `${SVC}/B`, { servicePath: SVC }), /No authorization/);
  assert.equal(calls, 1);
});

test('errors, raw responses, non-JSON bodies, cookie merging, preset Authorization, Buffer bodies', async () => {
  mock.on('GET', `${SVC}/err`, (req, res) => json(res, 404, { error: { code: 'NF', message: { value: 'Not found' } } }));
  mock.on('GET', `${SVC}/bad`, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{broken');
  });
  mock.on('GET', `${SVC}/bin`, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([1, 2, 3]));
  });
  mock.on('GET', `${SVC}/json`, (req, res) => json(res, 200, { a: 1 }));
  mock.on('GET', `${SVC}/noct`, (req, res) => {
    res.removeHeader('content-type');
    res.end('{"a":1}');
  });
  mock.on('GET', `${SVC}/`, serviceDoc);
  mock.on('PUT', `${SVC}/$value`, (req, res) => json(res, 200, { got: req.body, cookie: req.headers.cookie, auth: req.headers.authorization }));

  const c = new SapClient({ url: mock.url, credentials: { user: 'u', password: 'p' } });
  await assert.rejects(c.request('GET', `${SVC}/err`), (e) => e.code === 'NF' && e.statusCode === 404 && e.url.endsWith('/err'));
  assert.equal((await c.request('GET', `${SVC}/bad`)).body, '{broken');
  const bin = await c.request('GET', `${SVC}/bin`, { raw: true });
  assert.deepEqual([...bin.body], [1, 2, 3]);
  const rawJson = await c.request('GET', `${SVC}/json`, { raw: true });
  assert.ok(Buffer.isBuffer(rawJson.body));
  assert.equal(rawJson.text, '{"a":1}');
  assert.equal((await c.request('GET', `${SVC}/bin`)).body, '\u0001\u0002\u0003');
  assert.equal((await c.request('GET', `${SVC}/noct`)).body, '{"a":1}', 'no Content-Type -> no JSON parsing');

  const r = await c.request('PUT', `${SVC}/$value`, { body: Buffer.from('BIN'), headers: { Cookie: 'mine=1', Authorization: 'Custom x' }, servicePath: SVC });
  assert.equal(r.body.got, 'BIN');
  assert.match(r.body.cookie, /^mine=1; SAP_SESSIONID_ABC_100=/);
  assert.equal(r.body.auth, 'Custom x');
});

test('API key auth (sandbox.api.sap.com)', async () => {
  mock.on('GET', '/s4hanacloud/sap/opu/odata/sap/API_X/A', (req, res) => json(res, 200, { key: req.headers.apikey, auth: req.headers.authorization }));
  const c = new SapClient({ url: mock.url, authType: 'apikey', credentials: { token: 'KEY' } });
  const r = await c.request('GET', '/s4hanacloud/sap/opu/odata/sap/API_X/A');
  assert.deepEqual(r.body, { key: 'KEY' });
});

test('OAuth2 client credentials: token fetch, caching, refresh on 401, errors', async () => {
  let issued = 0;
  mock.on('POST', '/oauth/token', (req, res) => {
    issued += 1;
    const params = new URLSearchParams(req.body);
    json(res, 200, { access_token: `tok${issued}`, expires_in: issued === 1 ? 3600 : undefined, scope: params.get('scope'), auth: req.headers.authorization, grant: params.get('grant_type') });
  });
  let seen = [];
  mock.on('GET', `${SVC}/A`, (req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer tok1' && seen.length === 2) return json(res, 401, { error: { message: 'expired' } });
    json(res, 200, { ok: true });
  });
  mock.csrf = false;
  const c = new SapClient({ url: mock.url, authType: 'oauth2', tokenUrl: `${mock.url}/oauth/token`, scope: 'API', credentials: { clientId: 'id', clientSecret: 's' } });
  await c.request('GET', `${SVC}/A`);
  const tokenReq = mock.requests.find((r) => r.path === '/oauth/token');
  assert.equal(tokenReq.headers.authorization, `Basic ${Buffer.from('id:s').toString('base64')}`);
  assert.equal(tokenReq.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(tokenReq.body).get('grant_type'), 'client_credentials');
  assert.equal(new URLSearchParams(tokenReq.body).get('scope'), 'API');

  await c.request('GET', `${SVC}/A`); // 401 -> new token -> retry
  assert.deepEqual(seen, ['Bearer tok1', 'Bearer tok1', 'Bearer tok2']);
  assert.equal(issued, 2);
  assert.ok(c.oauth.expires > Date.now());

  // a second 401 is an error
  seen = [];
  mock.on('GET', `${SVC}/B`, (req, res) => json(res, 401, { error: { message: 'nope' } }));
  await assert.rejects(c.request('GET', `${SVC}/B`), (e) => e.statusCode === 401);
  assert.equal(issued, 3);

  // no scope, no client credentials
  const c2 = new SapClient({ url: mock.url, authType: 'oauth2', tokenUrl: `${mock.url}/oauth/token` });
  await c2.oauthToken();
  const last = mock.requests.filter((r) => r.path === '/oauth/token').pop();
  assert.equal(new URLSearchParams(last.body).has('scope'), false);
  assert.equal(last.headers.authorization, `Basic ${Buffer.from(':').toString('base64')}`);

  await assert.rejects(new SapClient({ url: mock.url, authType: 'oauth2' }).request('GET', `${SVC}/A`), /token URL is not configured/);

  mock.on('POST', '/oauth/bad', (req, res) => text(res, 401, 'invalid_client'));
  await assert.rejects(new SapClient({ url: mock.url, authType: 'oauth2', tokenUrl: `${mock.url}/oauth/bad` }).oauthToken(), /OAuth2 token request failed: HTTP 401 invalid_client/);

  // 401 with basic auth is not retried
  await assert.rejects(new SapClient({ url: mock.url, credentials: { user: 'u' } }).request('GET', `${SVC}/B`), (e) => e.statusCode === 401);
  mock.csrf = true;
});

test('metadata: parsed, cached, forced refresh, failures not cached', async () => {
  let calls = 0;
  mock.on('GET', `${SVC}/$metadata`, (req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(V2);
  });
  const c = new SapClient({ url: mock.url });
  const m = await c.metadata(SVC);
  assert.equal(m.model.version, 'v2');
  assert.equal(m.xml, V2);
  assert.equal(mock.last().headers.accept, 'application/xml');
  await c.metadata(SVC);
  assert.equal(calls, 1);
  await c.metadata(SVC, { force: true });
  assert.equal(calls, 2);

  const expired = new SapClient({ url: mock.url, metadataTtl: -1 });
  await expired.metadata(SVC);
  await expired.metadata(SVC);
  assert.equal(calls, 4);

  mock.on('GET', '/bad/$metadata', (req, res) => text(res, 500, 'dump'));
  await assert.rejects(c.metadata('/bad'), /dump/);
  assert.equal(c.metadataCache.has('/bad'), false);
});

test('catalog: V2 + V4 service lists', async () => {
  mock.on('GET', '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection', (req, res) =>
    json(res, 200, {
      d: {
        results: [
          { ID: 'ZA_0001', TechnicalServiceName: 'ZA', TechnicalServiceVersion: 1, Title: 'ZA', Description: 'A', ServiceUrl: 'https://h:1/sap/opu/odata/sap/ZA/' },
          { ID: 'ZB_0001', TechnicalServiceName: 'ZB', TechnicalServiceVersion: 1, Title: 'ZB', Description: 'B', ServiceUrl: '/sap/opu/odata/sap/ZB' },
          { ID: 'ZC_0001' },
        ],
      },
    })
  );
  mock.on('GET', '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups', (req, res) =>
    json(res, 200, {
      value: [
        {
          GroupId: 'API_PRODUCT',
          DefaultSystem: { Services: [{ ServiceId: 'API_PRODUCT', ServiceVersion: '0001', Description: 'Product', ServiceUrl: '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001/?sap-client=100' }, { ServiceId: 'X' }] },
        },
        { GroupId: 'EMPTY' },
      ],
    })
  );
  const c = new SapClient({ url: mock.url });
  const r = await c.catalog();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.services.map((s) => [s.version, s.name, s.path]),
    [
      ['v2', 'ZA', '/sap/opu/odata/sap/ZA'],
      ['v2', 'ZB', '/sap/opu/odata/sap/ZB'],
      ['v2', undefined, ''],
      ['v4', 'API_PRODUCT', '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001'],
      ['v4', 'X', ''],
    ]
  );
  assert.equal(r.services[3].id, 'API_PRODUCT/API_PRODUCT/0001');
  assert.equal(mock.requests.find((x) => x.path.includes('ServiceGroups')).query.get('$expand'), 'DefaultSystem($expand=Services)');

  const onlyV2 = await c.catalog({ v4: false });
  assert.equal(onlyV2.services.length, 3);
});

test('catalog: errors and empty responses are collected', async () => {
  const c = new SapClient({ url: mock.url });
  const r = await c.catalog();
  assert.deepEqual(
    r.errors.map((e) => e.catalog),
    ['v2', 'v4']
  );
  mock.on('GET', /ServiceCollection|ServiceGroups/, (req, res) => json(res, 200, {}));
  assert.deepEqual(await c.catalog(), { services: [], errors: [] });
  mock.on('GET', /ServiceCollection|ServiceGroups/, (req, res) => json(res, 200, { d: {} }));
  assert.deepEqual(await c.catalog(), { services: [], errors: [] });
});

test('reset clears session state', async () => {
  mock.on('GET', `${SVC}/`, serviceDoc);
  mock.on('POST', `${SVC}/A`, (req, res) => json(res, 201, {}));
  const c = new SapClient({ url: mock.url });
  await c.request('POST', `${SVC}/A`, { servicePath: SVC });
  assert.ok(c.csrfToken);
  assert.ok(c.jar.size > 0);
  c.oauth = { token: 't', expires: 0 };
  c.reset();
  assert.equal(c.csrfToken, null);
  assert.equal(c.jar.size, 0);
  assert.equal(c.oauth, null);
  assert.equal(c.metadataCache.size, 0);
});
