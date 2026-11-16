'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const connectionNode = require('../nodes/sap-connection');
const odataNode = require('../nodes/sap-odata');
const { createMockSap, json, text } = require('./helpers/mock-sap');
const { V2, V4 } = require('./fixtures/metadata');

helper.init(require.resolve('node-red'));

const V2SVC = '/sap/opu/odata/sap/GWSAMPLE_BASIC';
const V4SVC = '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001';

let mock;
test.before(async () => {
  mock = await createMockSap();
  await new Promise((r) => helper.startServer(r));
});
test.after(async () => {
  await new Promise((r) => helper.stopServer(r));
  await mock.close();
});
test.afterEach(async () => {
  await helper.unload();
});
test.beforeEach(() => {
  mock.reset();
  mock.csrf = true;
  const xml = (body) => (req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(body);
  };
  mock.on('GET', `${V2SVC}/$metadata`, xml(V2));
  mock.on('GET', `${V4SVC}/$metadata`, xml(V4));
  mock.on('GET', `${V2SVC}/`, (req, res) => json(res, 200, { d: { EntitySets: [] } }));
  mock.on('GET', `${V4SVC}/`, (req, res) => json(res, 200, { value: [] }));
});

/** Loads connection + sap-odata + helper; returns a function that sends a msg and resolves with {msg} or {error}. */
async function setup(props = {}, { conn = {}, creds = { user: 'u', password: 'p' }, withConnection = true } = {}) {
  const flow = [
    { id: 'n1', type: 'sap-odata', connection: withConnection ? 'c1' : '', service: 'GWSAMPLE_BASIC', wires: [['h1']], ...props },
    { id: 'h1', type: 'helper' },
  ];
  if (withConnection) flow.push({ id: 'c1', type: 'sap-connection', url: mock.url, client: '100', ...conn });
  await helper.load([connectionNode, odataNode], flow, creds ? { c1: creds } : undefined);
  const n1 = helper.getNode('n1');
  const h1 = helper.getNode('h1');
  const warnings = [];
  n1.on('call:warn', (call) => warnings.push(call.args[0]));
  const send = (msg = {}) =>
    new Promise((resolve) => {
      const onOut = (out) => {
        cleanup();
        resolve({ msg: out, warnings });
      };
      const onErr = (call) => {
        cleanup();
        resolve({ error: call.args[0], msg: call.args[1], warnings });
      };
      const cleanup = () => {
        h1.removeListener('input', onOut);
        n1.removeListener('call:error', onErr);
      };
      h1.on('input', onOut);
      n1.on('call:error', onErr);
      n1.receive(msg);
    });
  send.node = n1;
  return send;
}

const lastOf = (method, re) => mock.requests.filter((r) => r.method === method && re.test(r.url)).pop();

// ---------------------------------------------------------------- connection

test('sap-connection: client configuration and close()', async () => {
  await helper.load(
    [connectionNode],
    [{ id: 'c1', type: 'sap-connection', url: 'https://h:1', authType: 'oauth2', tokenUrl: 't', scope: 's', rejectUnauthorized: false, timeout: 'x', metadataTtl: 10, language: 'EL' }],
    { c1: { clientId: 'id' } }
  );
  const c = helper.getNode('c1');
  assert.equal(c.client.cfg.authType, 'oauth2');
  assert.equal(c.client.cfg.rejectUnauthorized, false);
  assert.equal(c.client.cfg.timeout, 60000);
  assert.equal(c.client.cfg.metadataTtl, 10000);
  assert.equal(c.client.cfg.language, 'EL');
  assert.equal(c.client.credentials.clientId, 'id');
  c.client.csrfToken = 'x';
  await helper.unload();
  assert.equal(c.client.csrfToken, null);

  await helper.load([connectionNode], [{ id: 'c2', type: 'sap-connection', url: 'https://h', timeout: 5, metadataTtl: '' }]);
  const c2 = helper.getNode('c2');
  assert.equal(c2.client.cfg.authType, 'basic');
  assert.equal(c2.client.cfg.rejectUnauthorized, true);
  assert.equal(c2.client.cfg.timeout, 5);
  assert.equal(c2.client.cfg.metadataTtl, 3600000);
  assert.deepEqual(c2.client.credentials, {});
});

test('sap-connection: admin endpoints for the editor', async () => {
  await setup();
  mock.on('GET', /ServiceCollection/, (req, res) => json(res, 200, { d: { results: [{ ID: 'A', TechnicalServiceName: 'A', ServiceUrl: '/sap/opu/odata/sap/A' }] } }));
  mock.on('GET', /ServiceGroups/, (req, res) => json(res, 200, { value: [] }));
  let r = await helper.request().get('/sap-connection/c1/services').expect(200);
  assert.equal(r.body.services[0].path, '/sap/opu/odata/sap/A');

  r = await helper.request().get('/sap-connection/c1/metadata').query({ service: 'GWSAMPLE_BASIC' }).expect(200);
  assert.equal(r.body.version, 'v2');
  assert.ok(r.body.entitySets.some((s) => s.name === 'BusinessPartnerSet'));
  const calls = mock.requests.filter((x) => x.path.endsWith('$metadata')).length;
  await helper.request().get('/sap-connection/c1/metadata').query({ service: 'GWSAMPLE_BASIC', refresh: 'true' }).expect(200);
  assert.equal(mock.requests.filter((x) => x.path.endsWith('$metadata')).length, calls + 1);

  r = await helper.request().get('/sap-connection/c1/metadata').query({ service: 'MISSING' }).expect(502);
  assert.equal(r.body.statusCode, 404);
  r = await helper.request().get('/sap-connection/c1/metadata').expect(502);
  assert.match(r.body.error, /No OData service/);
  r = await helper.request().get('/sap-connection/nope/services').expect(404);
  assert.match(r.body.error, /deploy the sap-connection first/);
  // a node that exists but is not a connection
  await helper.request().get('/sap-connection/n1/services').expect(404);
});

// ---------------------------------------------------------------- basics

test('sap-odata: no connection configured', async () => {
  const send = await setup({}, { withConnection: false });
  const r = await send({});
  assert.match(r.error.message, /No sap-connection configured/);
});

test('sap-odata: unknown operation and missing key', async () => {
  const send = await setup({ operation: 'query', entitySet: 'BusinessPartnerSet' });
  let r = await send({ operation: 'nope' });
  assert.match(r.error.message, /Unknown operation "nope"/);
  assert.deepEqual(r.msg.error, { message: 'Unknown operation "nope"' });
  for (const operation of ['get', 'update', 'delete']) {
    r = await send({ operation });
    assert.match(r.error.message, new RegExp(`${operation}: an entity key is required`));
  }
  r = await send({ operation: 'get', key: '' });
  assert.match(r.error.message, /key is required/);
});

test('sap-odata: default operation is query; SAP errors are attached to msg.error', async () => {
  mock.on('GET', `${V2SVC}/BusinessPartnerSet`, (req, res) => json(res, 400, { error: { code: 'X/1', message: { value: 'Invalid filter' } } }));
  const send = await setup({ operation: '', entitySet: 'BusinessPartnerSet' });
  const r = await send({});
  assert.equal(r.error.message, 'Invalid filter');
  assert.equal(r.msg.error.statusCode, 400);
  assert.equal(r.msg.error.code, 'X/1');
});

// ---------------------------------------------------------------- read

test('query V2: options from node + msg.query, inline count, date conversion', async () => {
  mock.on('GET', `${V2SVC}/BusinessPartnerSet`, (req, res) =>
    json(res, 200, { d: { __count: '2', results: [{ __metadata: { uri: 'u' }, BusinessPartnerID: '1', CreatedAt: '/Date(0)/' }], __next: 'BusinessPartnerSet?$skiptoken=1' } })
  );
  const send = await setup({ entitySet: 'BusinessPartnerSet', filter: "CompanyName eq 'SAP'", select: 'BusinessPartnerID', top: '5', count: true, custom: 'sap-statistics=true&flag&=x' });
  const r = await send({ query: { top: 2, orderby: 'CompanyName' }, headers: { 'Accept-Language': 'el' } });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.msg.payload, [{ __metadata: { uri: 'u' }, BusinessPartnerID: '1', CreatedAt: '1970-01-01T00:00:00.000Z' }]);
  assert.equal(r.msg.odata.count, 2);
  assert.equal(r.msg.odata.nextLink, 'BusinessPartnerSet?$skiptoken=1');
  assert.equal(r.msg.odata.version, 'v2');
  assert.equal(r.msg.odata.operation, 'query');
  const req = mock.last();
  assert.equal(req.query.get('$filter'), "CompanyName eq 'SAP'");
  assert.equal(req.query.get('$select'), 'BusinessPartnerID');
  assert.equal(req.query.get('$top'), '2');
  assert.equal(req.query.get('$orderby'), 'CompanyName');
  assert.equal(req.query.get('$inlinecount'), 'allpages');
  assert.equal(req.query.get('sap-statistics'), 'true');
  assert.equal(req.query.get('sap-client'), '100');
  assert.equal(req.headers['accept-language'], 'el');
});

test('query: fetchAll follows next links up to maxPages; options off', async () => {
  mock.on('GET', `${V2SVC}/BusinessPartnerSet`, (req, res) => {
    const page = Number(req.query.get('$skiptoken') || 0);
    json(res, 200, { d: { results: [{ n: page, at: '/Date(0)/' }], __next: page < 3 ? `${mock.url}${V2SVC}/BusinessPartnerSet?$skiptoken=${page + 1}` : undefined } });
  });
  let send = await setup({ entitySet: 'BusinessPartnerSet', fetchAll: true, convertDates: false, stripMetadata: true });
  let r = await send({});
  assert.deepEqual(r.msg.payload.map((x) => x.n), [0, 1, 2, 3]);
  assert.equal(r.msg.payload[0].at, '/Date(0)/');
  assert.equal(r.msg.odata.pages, 4);
  assert.equal(r.msg.odata.nextLink, undefined);
  r = await send({ fetchAll: false });
  assert.equal(r.msg.payload.length, 1);
  await helper.unload();

  send = await setup({ entitySet: 'BusinessPartnerSet', maxPages: 2 });
  r = await send({ fetchAll: true });
  assert.equal(r.msg.payload.length, 2);
  assert.match(r.msg.odata.nextLink, /skiptoken=2/);
});

test('get V2: typed key from $metadata, navigation, etag; metadata disabled; metadata failure warns', async () => {
  mock.on('GET', /ContactSet\(ContactGuid=guid'abc'\)$|ContactSet\(guid'abc'\)/, (req, res) => json(res, 200, { d: { __metadata: { etag: 'W/"1"' }, ContactGuid: 'abc' } }));
  mock.on('GET', /SalesOrderLineItemSet\(SalesOrderID='1',ItemPosition='10'\)\/ToX/, (req, res) => json(res, 200, { d: { ok: 1 } }));
  let send = await setup({ operation: 'get', entitySet: 'ContactSet' });
  let r = await send({ key: 'abc' });
  assert.equal(r.msg.odata.etag, 'W/"1"');
  assert.match(mock.last().url, /ContactSet\(guid'abc'\)/);
  r = await send({ entitySet: 'SalesOrderLineItemSet', key: { SalesOrderID: '1', ItemPosition: '10' }, navigation: 'ToX' });
  assert.deepEqual(r.msg.payload, { ok: 1 });
  r = await send({ entitySet: 'NotInMetadata', key: '1' });
  assert.equal(r.error.statusCode, 404);
  assert.match(mock.last().url, /NotInMetadata\('1'\)/);
  await helper.unload();

  send = await setup({ operation: 'get', entitySet: 'ContactSet', key: 'abc', useMetadata: false });
  r = await send({});
  assert.equal(r.error.statusCode, 404); // without metadata the key is a string literal ('abc')
  assert.match(mock.last().url, /ContactSet\('abc'\)/);
  await helper.unload();

  send = await setup({ operation: 'get', entitySet: 'X', key: '1', service: 'NO_METADATA' });
  mock.on('GET', /NO_METADATA\/X/, (req, res) => json(res, 200, { d: { ok: true } }));
  r = await send({});
  assert.deepEqual(r.msg.payload, { ok: true });
  assert.match(r.warnings[0], /Could not load \$metadata/);
});

test('query V4: $count=true, $search, nextLink relative, date conversion only for V2', async () => {
  mock.on('GET', `${V4SVC}/Product`, (req, res) =>
    json(res, 200, { '@odata.context': '$metadata#Product', '@odata.count': 1, value: [{ Product: 'P1', d: '/Date(0)/', '@odata.etag': 'W/"x"' }] })
  );
  const send = await setup({ service: V4SVC, version: 'auto', entitySet: 'Product', count: true, search: 'pump', stripMetadata: true });
  const r = await send({});
  assert.equal(r.msg.odata.version, 'v4');
  assert.deepEqual(r.msg.payload, [{ Product: 'P1', d: '/Date(0)/' }]);
  assert.equal(r.msg.odata.count, 1);
  assert.equal(mock.last().query.get('$count'), 'true');
  assert.equal(mock.last().query.get('$search'), 'pump');
});

test('version: explicit node setting and msg.odataVersion override', async () => {
  mock.on('GET', /\/custom\/srv\/A/, (req, res) => json(res, 200, { value: [{ a: 1 }] }));
  const send = await setup({ service: '/custom/srv', entitySet: 'A', version: 'v4' });
  let r = await send({});
  assert.deepEqual(r.msg.payload, [{ a: 1 }]);
  r = await send({ odataVersion: 'v2' });
  assert.deepEqual(r.msg.payload, { value: [{ a: 1 }] });
});

test('count: /$count with filter and search only', async () => {
  mock.on('GET', `${V2SVC}/BusinessPartnerSet/$count`, (req, res) => text(res, 200, '42\n'));
  const send = await setup({ operation: 'count', entitySet: 'BusinessPartnerSet', filter: "A eq 'b'", select: 'X', top: 1 });
  let r = await send({ query: { search: 's' } });
  assert.equal(r.msg.payload, 42);
  const req = mock.last();
  assert.equal(req.query.get('$filter'), "A eq 'b'");
  assert.equal(req.query.get('search'), 's');
  assert.equal(req.query.get('$select'), null);
  assert.equal(req.query.get('$top'), null);
  assert.equal(req.headers.accept, 'text/plain');
  r = await send({ query: { filter: undefined }, entitySet: 'BusinessPartnerSet' });
  assert.equal(r.msg.payload, 42);
});

// ---------------------------------------------------------------- write

test('create: POST with CSRF, location and etag', async () => {
  mock.on('POST', `${V2SVC}/BusinessPartnerSet`, (req, res) =>
    json(res, 201, { d: { __metadata: { etag: 'E1' }, ...JSON.parse(req.body) } }, { location: `${mock.url}${V2SVC}/BusinessPartnerSet('9')` })
  );
  const send = await setup({ operation: 'create', entitySet: 'BusinessPartnerSet' });
  const r = await send({ payload: { CompanyName: 'ACME' } });
  assert.equal(r.msg.odata.statusCode, 201);
  assert.equal(r.msg.odata.etag, 'E1');
  assert.match(r.msg.odata.location, /BusinessPartnerSet\('9'\)$/);
  assert.equal(r.msg.payload.CompanyName, 'ACME');
  const post = lastOf('POST', /BusinessPartnerSet/);
  assert.ok(post.headers['x-csrf-token']);
  assert.notEqual(post.headers['x-csrf-token'], 'Fetch');
});

test('update V2: MERGE by default, etag auto-read, 204 echoes payload', async () => {
  mock.on('GET', /BusinessPartnerSet\('1'\)$|BusinessPartnerSet\('1'\)\?/, (req, res) => json(res, 200, { d: { __metadata: { etag: 'W/"datetime\'2024\'"' } } }));
  mock.on('MERGE', /BusinessPartnerSet\('1'\)/, (req, res) => {
    res.writeHead(204);
    res.end();
  });
  const send = await setup({ operation: 'update', entitySet: 'BusinessPartnerSet' });
  const r = await send({ key: '1', payload: { CompanyName: 'X' } });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.msg.payload, { CompanyName: 'X' });
  assert.equal(r.msg.odata.method, 'MERGE');
  assert.equal(r.msg.odata.statusCode, 204);
  assert.equal(lastOf('MERGE', /./).headers['if-match'], `W/"datetime'2024'"`);
});

test('update V2: entity without ETag sends no If-Match; tunnelling; PUT; etag from payload / msg', async () => {
  mock.on('GET', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 200, { d: { CompanyName: 'old' } }));
  mock.on('POST', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 204));
  mock.on('PUT', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 200, { d: { CompanyName: 'new', CreatedAt: '/Date(0)/' } }, { etag: 'E2' }));
  mock.on('MERGE', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 204));
  let send = await setup({ operation: 'update', entitySet: 'BusinessPartnerSet', key: '1', tunnel: true });
  let r = await send({ payload: {} });
  let req = lastOf('POST', /BusinessPartnerSet/);
  assert.equal(req.headers['x-http-method'], 'MERGE');
  assert.equal(req.headers['if-match'], undefined);
  assert.equal(r.msg.odata.method, 'MERGE');

  r = await send({ method: 'PUT', payload: { __metadata: { etag: 'P1' } } });
  req = lastOf('PUT', /./);
  assert.equal(req.headers['if-match'], 'P1');
  assert.equal(req.headers['x-http-method'], undefined);
  assert.equal(r.msg.odata.etag, 'E2');
  assert.deepEqual(r.msg.payload, { CompanyName: 'new', CreatedAt: '1970-01-01T00:00:00.000Z' });
  await helper.unload();

  send = await setup({ operation: 'update', entitySet: 'BusinessPartnerSet', key: '1', updateMethod: 'PUT', etag: 'msg' });
  r = await send({ etag: 'M1', payload: {} });
  assert.equal(lastOf('PUT', /./).headers['if-match'], 'M1');
  mock.requests.length = 0;
  r = await send({ payload: {} });
  assert.equal(lastOf('PUT', /./).headers['if-match'], undefined);
  assert.equal(mock.requests.filter((x) => x.method === 'GET' && /BusinessPartnerSet/.test(x.url)).length, 0, 'msg mode never reads');
});

test('update V4: PATCH with @odata.etag, wildcard and none', async () => {
  mock.on('PATCH', /Product\('P1'\)/, (req, res) => json(res, 200, { '@odata.etag': 'W/"2"', Product: 'P1' }));
  let send = await setup({ service: V4SVC, operation: 'update', entitySet: 'Product', key: 'P1' });
  let r = await send({ payload: { '@odata.etag': 'W/"1"', Name: 'x' } });
  assert.equal(r.msg.odata.method, 'PATCH');
  assert.equal(r.msg.odata.etag, 'W/"2"');
  assert.equal(lastOf('PATCH', /./).headers['if-match'], 'W/"1"');
  await helper.unload();

  send = await setup({ service: V4SVC, operation: 'update', entitySet: 'Product', key: 'P1', etag: 'wildcard', updateMethod: 'auto' });
  await send({ payload: {} });
  assert.equal(lastOf('PATCH', /./).headers['if-match'], '*');
  await helper.unload();

  send = await setup({ service: V4SVC, operation: 'update', entitySet: 'Product', key: 'P1', etag: 'none' });
  await send({ payload: { '@odata.etag': 'ignored' } });
  assert.equal(lastOf('PATCH', /./).headers['if-match'], undefined);
});

test('delete: etag read from ETag header', async () => {
  mock.on('GET', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 200, { d: {} }, { etag: 'H1' }));
  mock.on('DELETE', /BusinessPartnerSet\('1'\)/, (req, res) => json(res, 204));
  const send = await setup({ operation: 'delete', entitySet: 'BusinessPartnerSet', key: '1' });
  const r = await send({});
  assert.equal(r.msg.payload, null);
  assert.equal(r.msg.odata.statusCode, 204);
  assert.equal(lastOf('DELETE', /./).headers['if-match'], 'H1');
  await helper.unload();

  const send2 = await setup({ operation: 'delete', entitySet: 'BusinessPartnerSet', key: '1', etag: 'none' });
  await send2({});
  assert.equal(lastOf('DELETE', /./).headers['if-match'], undefined);
});

// ---------------------------------------------------------------- operations

test('function V2: function import with typed parameters and HTTP method from $metadata', async () => {
  mock.on('POST', /SalesOrder_Confirm\?SalesOrderID='1'/, (req, res) => json(res, 200, { d: { SalesOrderID: '1', Status: 'C' } }));
  mock.on('GET', /GetDate\?Day=datetime'2024-01-01T00:00:00'/, (req, res) => json(res, 200, { d: { GetDate: '/Date(1704067200000)/' } }));
  mock.on('GET', /Unknown\?a=1/, (req, res) => json(res, 200, { d: { results: [] } }));
  const send = await setup({ operation: 'function', functionName: 'SalesOrder_Confirm' });
  let r = await send({ params: { SalesOrderID: '1' } });
  assert.deepEqual(r.msg.payload, { SalesOrderID: '1', Status: 'C' });
  r = await send({ functionName: 'GetDate', payload: { Day: '2024-01-01T00:00:00' } });
  assert.deepEqual(r.msg.payload, { GetDate: '2024-01-01T00:00:00.000Z' });
  r = await send({ functionName: 'Unknown', payload: { a: 1 } });
  assert.deepEqual(r.msg.payload, []);
  mock.on('GET', /\/Unknown(\?|$)/, (req, res) => json(res, 200, { d: { ok: req.url.includes('?') } }));
  r = await send({ functionName: 'Unknown', payload: [1, 2] });
  assert.deepEqual(r.msg.payload, { ok: true }); // only sap-client
  r = await send({ functionName: 'Unknown', payload: 'text' });
  assert.equal(r.error, undefined);
  r = await send({ functionName: 'Unknown', payload: null });
  assert.equal(r.error, undefined);
});

test('function V4: unbound function, action import and bound action', async () => {
  mock.on('GET', /GetByDate\(Date=2024-01-01\)/, (req, res) => json(res, 200, { '@odata.context': 'c', value: [{ Product: 'P1' }] }));
  mock.on('POST', /\/ResetAll$|\/ResetAll\?/, (req, res) => json(res, 204));
  mock.on('POST', /Product\('P1'\)\/com\.sap\.gateway\.srvd_a2x\.api_product\.v0001\.Activate/, (req, res) => json(res, 200, { Product: 'P1', body: JSON.parse(req.body) }));
  const send = await setup({ service: V4SVC, operation: 'function' });
  let r = await send({ functionName: 'GetByDate', params: { Date: '2024-01-01' } });
  assert.deepEqual(r.msg.payload, [{ Product: 'P1' }]);
  r = await send({ functionName: 'ResetAll', params: { Reason: 'x' } });
  assert.equal(r.msg.payload, null);
  assert.deepEqual(JSON.parse(lastOf('POST', /ResetAll/).body), { Reason: 'x' });
  // a bound action is conditional: the ETag is read from the bound entity and sent as If-Match (SAP RAP requires it)
  mock.on('GET', /Product\('P1'\)(\?|$)/, (req, res) => json(res, 200, { '@odata.etag': 'W/"7"', Product: 'P1' }));
  r = await send({ functionName: 'com.sap.gateway.srvd_a2x.api_product.v0001.Activate', bindingPath: "Product('P1')", params: { Force: true } });
  assert.deepEqual(r.msg.payload.body, { Force: true });
  assert.equal(lastOf('POST', /Activate/).headers['if-match'], 'W/"7"');
  // explicit ETag, and a bound function (GET) is never conditional
  r = await send({ functionName: 'com.sap.gateway.srvd_a2x.api_product.v0001.Activate', bindingPath: "/Product('P1')", params: {}, etag: 'W/"9"' });
  assert.equal(lastOf('POST', /Activate/).headers['if-match'], 'W/"9"');
});

test('function V4: RAP messages of the body (SAP__Messages) and the header (sap-messages) in msg.odata.messages', async () => {
  mock.on('POST', /Product\('P1'\)\/.*Activate/, (req, res) =>
    json(
      res,
      200,
      { Product: 'P1', SAP__Messages: [{ code: 'ZMSG/001', message: 'Activated', numericSeverity: 1, target: 'Product', longtextUrl: 'u' }] },
      { 'sap-messages': JSON.stringify([{ code: 'ZMSG/002', message: 'Check stock', numericSeverity: 3 }]) }
    )
  );
  mock.on('GET', /Product\('P1'\)(\?|$)/, (req, res) => json(res, 200, { Product: 'P1' }));
  const send = await setup({ service: V4SVC, operation: 'function', etag: 'none' });
  const r = await send({ functionName: 'com.sap.gateway.srvd_a2x.api_product.v0001.Activate', bindingPath: "Product('P1')" });
  assert.deepEqual(r.msg.odata.messages, [
    { code: 'ZMSG/002', message: 'Check stock', severity: 'warning', target: undefined, longtextUrl: undefined },
    { code: 'ZMSG/001', message: 'Activated', severity: 'success', target: 'Product', longtextUrl: 'u' },
  ]);
  assert.equal(lastOf('POST', /Activate/).headers['if-match'], undefined);
});

test('function: method override for operations unknown to $metadata', async () => {
  mock.on('POST', /\/Custom/, (req, res) => json(res, 200, { d: { ok: 1 } }));
  const send = await setup({ operation: 'function', functionName: 'Custom', method: 'POST', useMetadata: false });
  const r = await send({});
  assert.deepEqual(r.msg.payload, { ok: 1 });
});

// ---------------------------------------------------------------- batch

function batchResponder(parts) {
  return (req, res) => {
    const b = 'batch_resp';
    const body = parts.map((p) => `--${b}\r\n${p}`).join('\r\n') + `\r\n--${b}--\r\n`;
    res.writeHead(202, { 'content-type': `multipart/mixed; boundary=${b}` });
    res.end(body);
  };
}

const httpPart = (status, body) =>
  `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${body ? JSON.stringify(body) : ''}\r\n`;

test('batch: builds multipart request (typed keys, query) and maps responses', async () => {
  mock.on(
    'POST',
    `${V2SVC}/$batch`,
    batchResponder([
      httpPart('200 OK', { d: { results: [{ CreatedAt: '/Date(0)/' }] } }),
      `Content-Type: multipart/mixed; boundary=cs\r\n\r\n--cs\r\n${httpPart('201 Created', { d: { Id: 'N' } })}--cs\r\n${httpPart('204 No Content')}--cs--\r\n`,
      httpPart('404 Not Found', { error: { message: { value: 'nf' } } }),
    ])
  );
  const send = await setup({ operation: 'batch' });
  const r = await send({
    payload: [
      { entitySet: 'BusinessPartnerSet', query: { top: 1 } },
      { method: 'POST', entitySet: 'BusinessPartnerSet', body: { CompanyName: 'A' } },
      { method: 'MERGE', entitySet: 'ContactSet', key: 'abc', body: {}, headers: { 'If-Match': '*' } },
      { method: 'GET', url: "BusinessPartnerSet('x')" },
    ],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.msg.odata.errors, 1);
  assert.equal(r.msg.odata.statusCode, 202);
  assert.deepEqual(r.msg.payload[0].data, [{ CreatedAt: '1970-01-01T00:00:00.000Z' }]);
  assert.deepEqual(r.msg.payload[1].data, { Id: 'N' });
  assert.equal(r.msg.payload[2].status, 204);
  assert.equal(r.msg.payload[3].ok, false);
  assert.equal(r.msg.payload[3].data, undefined);

  const req = lastOf('POST', /\$batch/);
  assert.match(req.headers['content-type'], /^multipart\/mixed; boundary=batch_/);
  assert.equal(req.headers.accept, 'multipart/mixed');
  assert.ok(req.headers['x-csrf-token']);
  assert.match(req.body, /GET BusinessPartnerSet\?\$top=1 HTTP\/1\.1/);
  assert.match(req.body, /MERGE ContactSet\(guid'abc'\) HTTP\/1\.1/);
  assert.equal((req.body.match(/boundary=changeset_/g) || []).length, 1, 'POST + MERGE in one atomic change set');
});

test('batch: non-atomic via msg and config, without metadata lookups', async () => {
  mock.on('POST', `${V2SVC}/$batch`, batchResponder([httpPart('204 No Content'), httpPart('204 No Content')]));
  let send = await setup({ operation: 'batch', atomic: false });
  const payload = [
    { method: 'DELETE', url: "A('1')" },
    { method: 'DELETE', url: "A('2')" },
  ];
  await send({ payload });
  let req = lastOf('POST', /\$batch/);
  assert.equal((req.body.match(/boundary=changeset_/g) || []).length, 2);
  assert.equal(mock.requests.filter((x) => x.path.endsWith('$metadata')).length, 0);
  await send({ payload, atomic: true });
  req = lastOf('POST', /\$batch/);
  assert.equal((req.body.match(/boundary=changeset_/g) || []).length, 1);
  await helper.unload();

  send = await setup({ operation: 'batch' });
  await send({ payload, atomic: false });
  req = lastOf('POST', /\$batch/);
  assert.equal((req.body.match(/boundary=changeset_/g) || []).length, 2);
  await send({ payload: [{ method: 'DELETE', entitySet: 'Unknown', key: '1' }] });
  req = lastOf('POST', /\$batch/);
  assert.match(req.body, /DELETE Unknown\('1'\) HTTP/);

  const r = await send({ payload: {} });
  assert.match(r.error.message, /must be an array/);
});

// ---------------------------------------------------------------- metadata / catalog / raw

test('metadata and catalog operations', async () => {
  mock.on('GET', /ServiceCollection/, (req, res) => json(res, 200, { d: { results: [] } }));
  mock.on('GET', /ServiceGroups/, (req, res) => json(res, 200, { value: [] }));
  const send = await setup({ operation: 'metadata' });
  let r = await send({});
  assert.equal(r.msg.payload.version, 'v2');
  assert.equal(r.msg.metadataXml, V2);
  const n = mock.requests.filter((x) => x.path.endsWith('$metadata')).length;
  await send({});
  assert.equal(mock.requests.filter((x) => x.path.endsWith('$metadata')).length, n);
  await send({ refresh: true });
  assert.equal(mock.requests.filter((x) => x.path.endsWith('$metadata')).length, n + 1);
  r = await send({ operation: 'catalog' });
  assert.deepEqual(r.msg.payload, { services: [], errors: [] });
  assert.equal(r.msg.odata.operation, 'catalog');
});

test('raw request: relative, /sap/ absolute, full URL; body only for non-GET', async () => {
  mock.on('GET', `${V2SVC}/BusinessPartnerSet('1')/$value`, (req, res) => text(res, 200, 'BINARY'));
  mock.on('PUT', `${V2SVC}/BusinessPartnerSet('1')/$links/ToSalesOrders`, (req, res) => json(res, 204));
  mock.on('GET', '/sap/bc/ping', (req, res) => text(res, 200, 'pong'));
  mock.on('GET', '/full', (req, res) => json(res, 200, { d: { at: '/Date(0)/' } }));
  const send = await setup({ operation: 'request', path: "BusinessPartnerSet('1')/$value" });
  let r = await send({ payload: 'ignored for GET' });
  assert.equal(r.msg.payload, 'BINARY');
  assert.equal(mock.last().body, '');
  r = await send({ method: 'put', path: "/BusinessPartnerSet('1')/$links/ToSalesOrders", payload: { uri: 'x' } });
  assert.equal(r.msg.odata.statusCode, 204);
  assert.deepEqual(JSON.parse(lastOf('PUT', /./).body), { uri: 'x' });
  r = await send({ path: '/sap/bc/ping' });
  assert.equal(r.msg.payload, 'pong');
  r = await send({ path: `${mock.url}/full` });
  assert.deepEqual(r.msg.payload, { d: { at: '1970-01-01T00:00:00.000Z' } });
  await helper.unload();

  const send2 = await setup({ operation: 'request', method: 'GET' });
  mock.on('GET', `${V2SVC}/`, (req, res) => json(res, 200, { d: { EntitySets: ['x'] } }));
  r = await send2({});
  assert.deepEqual(r.msg.payload, { d: { EntitySets: ['x'] } });
});

test('status indicator on errors without HTTP status', async () => {
  const send = await setup({ operation: 'request', service: 'X' }, { conn: { url: 'http://127.0.0.1:1' } });
  const r = await send({});
  assert.match(r.error.message, /ECONNREFUSED/);
  assert.deepEqual(Object.keys(r.msg.error), ['message']);
});

// ---------------------------------------------------------------- proxy settings, files, binary, JSON batch

test('sap-connection: proxy modes are passed to the client', async () => {
  const flow = [
    { id: 'm', type: 'sap-connection', url: 'https://h', proxyMode: 'manual', proxyUrl: 'http://p:3128', noProxy: 'localhost', proxyAuth: 'ntlm', proxyDomain: 'CORP', proxyWorkstation: 'WS', proxySpn: 'HTTP/p' },
    { id: 'm2', type: 'sap-connection', url: 'https://h', proxyMode: 'manual', proxyUrl: 'http://p:3128' },
    { id: 'e', type: 'sap-connection', url: 'https://h', proxyMode: 'env', proxyAuth: 'negotiate' },
    { id: 'e2', type: 'sap-connection', url: 'https://h', proxyMode: 'env' },
    { id: 'n', type: 'sap-connection', url: 'https://h' },
    { id: 'd', type: 'sap-connection', authType: 'destination', destinationName: 'S4', grantType: 'saml2-bearer', clientAuth: 'body', spn: 'HTTP/sap' },
  ];
  await helper.load([connectionNode], flow, { m: { proxyUser: 'u', proxyPassword: 'p' } });
  assert.deepEqual(helper.getNode('m').client.cfg.proxy, { url: 'http://p:3128', auth: 'ntlm', noProxy: 'localhost', domain: 'CORP', workstation: 'WS', spn: 'HTTP/p' });
  assert.equal(helper.getNode('m').client.proxyFor('https://sap').user, 'u');
  assert.deepEqual(helper.getNode('m2').client.cfg.proxy, { url: 'http://p:3128', auth: 'none', noProxy: undefined, domain: undefined, workstation: undefined, spn: undefined });
  assert.deepEqual(helper.getNode('e').client.cfg.proxy, { useEnv: true, auth: 'negotiate', domain: undefined, workstation: undefined, spn: undefined });
  assert.equal(helper.getNode('e2').client.cfg.proxy.auth, undefined);
  assert.equal(helper.getNode('n').client.cfg.proxy, undefined);
  const d = helper.getNode('d').client.cfg;
  assert.deepEqual([d.authType, d.destinationName, d.grantType, d.clientAuth, d.spn], ['destination', 'S4', 'saml2-bearer', 'body', 'HTTP/sap']);
});

test('request: streaming upload from msg.uploadFile and download into msg.downloadFile', async () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'node-red-sap-'));
  try {
    const up = path.join(dir, 'in.bin');
    const down = path.join(dir, 'out.bin');
    fsx.writeFileSync(up, Buffer.from([0, 1, 2, 255]));
    mock.on('PUT', /\/Attachment\('1'\)\/\$value/, (req, res) => json(res, 204, undefined, { 'x-got': Buffer.from(req.body, 'latin1').length, 'x-ct': req.headers['content-type'], 'x-len': req.headers['content-length'] }));
    mock.on('GET', /\/Attachment\('1'\)\/\$value/, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.7 bytes'));
    });
    const send = await setup({ operation: 'request', path: "Attachment('1')/$value" });
    let r = await send({ method: 'PUT', uploadFile: up });
    assert.equal(r.msg.odata.statusCode, 204);
    assert.equal(r.msg.odata.headers['x-ct'], 'application/octet-stream');
    assert.equal(r.msg.odata.headers['x-len'], '4');
    r = await send({ method: 'PUT', uploadFile: up, headers: { 'Content-Type': 'application/pdf' } });
    assert.equal(r.msg.odata.headers['x-ct'], 'application/pdf');

    r = await send({ downloadFile: down });
    assert.deepEqual(r.msg.payload, { file: down, bytes: 14 });
    assert.equal(fsx.readFileSync(down, 'utf8'), '%PDF-1.7 bytes');

    r = await send({});
    assert.ok(Buffer.isBuffer(r.msg.payload), 'binary content is returned as a Buffer');
    assert.equal(r.msg.payload.toString(), '%PDF-1.7 bytes');

    r = await send({ method: 'PUT', uploadFile: path.join(dir, 'missing.bin') });
    assert.match(r.error.message, /ENOENT/);
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('request: answers without Content-Type, XML and text', async () => {
  mock.on('GET', /\/raw\/none/, (req, res) => {
    res.removeHeader('content-type');
    res.end('no type');
  });
  mock.on('GET', /\/raw\/xml/, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/atom+xml' });
    res.end('<feed/>');
  });
  const send = await setup({ operation: 'request' });
  let r = await send({ path: 'raw/none' });
  assert.ok(Buffer.isBuffer(r.msg.payload));
  r = await send({ path: 'raw/xml' });
  assert.equal(r.msg.payload, '<feed/>');
});

test('batch: JSON format for V4 (results, missing responses), refused for V2, 415 explained', async () => {
  mock.on('POST', `${V4SVC}/$batch`, (req, res) => {
    const body = JSON.parse(req.body);
    json(res, 200, {
      responses: [
        { id: body.requests[0].id, status: 200, headers: { 'content-type': 'application/json', 'sap-messages': JSON.stringify([{ message: 'hi', numericSeverity: 2 }]) }, body: { value: [{ Product: 'P1' }] } },
        { id: body.requests[1].id, status: 400, body: { error: { message: 'bad' } } },
      ],
    });
  });
  const send = await setup({ service: V4SVC, operation: 'batch', batchFormat: 'json' });
  let r = await send({ payload: [{ url: 'Product' }, { method: 'PATCH', url: "Product('P1')", body: {} }, { url: 'ProductText' }] });
  const req = lastOf('POST', /\$batch/);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers.accept, 'application/json');
  assert.deepEqual(r.msg.payload[0].data, [{ Product: 'P1' }]);
  assert.deepEqual(r.msg.payload[0].messages, [{ code: undefined, message: 'hi', severity: 'info', target: undefined, longtextUrl: undefined }]);
  assert.equal(r.msg.payload[1].ok, false);
  assert.equal(r.msg.payload[2], null);
  assert.equal(r.msg.odata.errors, 2);
  assert.equal(r.msg.odata.format, 'json');

  r = await send({ service: 'GWSAMPLE_BASIC', payload: [{ url: 'A' }] });
  assert.match(r.error.message, /only defined for OData V4/);

  mock.on('POST', `${V4SVC}/$batch`, (req, res) => json(res, 415, { error: { code: 'X', message: 'unsupported format' } }));
  r = await send({ payload: [{ url: 'Product' }] });
  assert.match(r.error.message, /unsupported format - this server does not support the JSON batch format, use batchFormat "multipart"/);
  r = await send({ batchFormat: 'multipart', payload: [{ url: 'Product' }] });
  assert.equal(r.error.statusCode, 415);
  assert.doesNotMatch(r.error.message, /use batchFormat/);
});
