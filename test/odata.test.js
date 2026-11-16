'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const o = require('../lib/odata');

test('detectVersion', () => {
  assert.equal(o.detectVersion('/sap/opu/odata4/sap/x/srvd_a2x/sap/x/0001'), 'v4');
  assert.equal(o.detectVersion('/sap/opu/odata/sap/API_X'), 'v2');
  assert.equal(o.detectVersion(undefined), 'v2');
});

test('servicePath', () => {
  assert.equal(o.servicePath('API_BUSINESS_PARTNER'), '/sap/opu/odata/sap/API_BUSINESS_PARTNER');
  assert.equal(o.servicePath(' ZMY_SRV;v=0002/ '), '/sap/opu/odata/sap/ZMY_SRV;v=0002');
  assert.equal(o.servicePath('/sap/opu/odata4/sap/p/srvd_a2x/sap/p/0001/'), '/sap/opu/odata4/sap/p/srvd_a2x/sap/p/0001');
  assert.equal(o.servicePath('https://h/sap/opu/odata/sap/X/'), 'https://h/sap/opu/odata/sap/X');
  assert.throws(() => o.servicePath(''), /No OData service/);
});

test('formatLiteral - inferred from JS type', () => {
  assert.equal(o.formatLiteral(null), 'null');
  assert.equal(o.formatLiteral(undefined), 'null');
  assert.equal(o.formatLiteral(5), '5');
  assert.equal(o.formatLiteral(1.5), '1.5d');
  assert.equal(o.formatLiteral(1.5, undefined, 'v4'), '1.5');
  assert.equal(o.formatLiteral(true), 'true');
  assert.equal(o.formatLiteral("O'Neil"), "'O''Neil'");
  const d = new Date('2024-01-02T03:04:05.000Z');
  assert.equal(o.formatLiteral(d), "datetime'2024-01-02T03:04:05'");
  assert.equal(o.formatLiteral(d, undefined, 'v4'), '2024-01-02T03:04:05.000Z');
});

test('formatLiteral - V2 typed (OData 2.0 primitive literal forms)', () => {
  const v = 'v2';
  assert.equal(o.formatLiteral('a', 'Edm.String', v), "'a'");
  assert.equal(o.formatLiteral('0050568d-393c-1ed4-9d97-e65f0f3fcc23', 'Edm.Guid', v), "guid'0050568d-393c-1ed4-9d97-e65f0f3fcc23'");
  assert.equal(o.formatLiteral('X', 'Edm.Boolean', v), 'true');
  assert.equal(o.formatLiteral('true', 'Edm.Boolean', v), 'true');
  assert.equal(o.formatLiteral(true, 'Edm.Boolean', v), 'true');
  assert.equal(o.formatLiteral('', 'Edm.Boolean', v), 'false');
  for (const t of ['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32']) assert.equal(o.formatLiteral(7, t, v), '7');
  assert.equal(o.formatLiteral('9007199254740993', 'Edm.Int64', v), '9007199254740993L');
  assert.equal(o.formatLiteral('12.50', 'Edm.Decimal', v), '12.50M');
  assert.equal(o.formatLiteral(1.5, 'Edm.Double', v), '1.5d');
  assert.equal(o.formatLiteral(1.5, 'Edm.Single', v), '1.5f');
  assert.equal(o.formatLiteral('2024-01-02T00:00:00', 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral('/Date(1704153600000)/', 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral('/Date(1704153600000+0000)/', 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral(1704153600000, 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral(new Date(1704153600000), 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral('2024-01-02', 'Edm.DateTime', v), "datetime'2024-01-02T00:00:00'");
  assert.equal(o.formatLiteral('2024-01-02T00:00:00+02:00', 'Edm.DateTimeOffset', v), "datetimeoffset'2024-01-02T00:00:00+02:00'");
  assert.equal(o.formatLiteral(1704153600000, 'Edm.DateTimeOffset', v), "datetimeoffset'2024-01-02T00:00:00Z'");
  assert.equal(o.formatLiteral('PT13H20M00S', 'Edm.Time', v), "time'PT13H20M00S'");
  assert.equal(o.formatLiteral('AQID', 'Edm.Binary', v), "X'AQID'");
  assert.equal(o.formatLiteral('x', 'My.Enum', v), "'x'");
  assert.equal(o.formatLiteral(3, 'Unknown', v), '3');
});

test('formatLiteral - V4 typed (OData 4.0 ABNF)', () => {
  const v = 'v4';
  assert.equal(o.formatLiteral('0050568d-393c-1ed4-9d97-e65f0f3fcc23', 'Edm.Guid', v), '0050568d-393c-1ed4-9d97-e65f0f3fcc23');
  assert.equal(o.formatLiteral('9007199254740993', 'Edm.Int64', v), '9007199254740993');
  assert.equal(o.formatLiteral('12.5', 'Edm.Decimal', v), '12.5');
  assert.equal(o.formatLiteral(1.5, 'Edm.Double', v), '1.5');
  assert.equal(o.formatLiteral(1.5, 'Edm.Single', v), '1.5');
  assert.equal(o.formatLiteral('2024-01-02T00:00:00Z', 'Edm.DateTimeOffset', v), '2024-01-02T00:00:00Z');
  assert.equal(o.formatLiteral('2024-01-02T10:00:00', 'Edm.DateTimeOffset', v), '2024-01-02T10:00:00Z');
  assert.equal(o.formatLiteral('2024-01-02T00:00:00Z', 'Edm.Date', v), '2024-01-02');
  assert.equal(o.formatLiteral(new Date('2024-01-02T00:00:00Z'), 'Edm.Date', v), '2024-01-02');
  assert.equal(o.formatLiteral('13:20:00', 'Edm.TimeOfDay', v), '13:20:00');
  assert.equal(o.formatLiteral('P1D', 'Edm.Duration', v), "duration'P1D'");
  assert.equal(o.formatLiteral('AQID', 'Edm.Binary', v), "binary'AQID'");
  assert.equal(o.formatLiteral('Open', 'ns.Status', v), "ns.Status'Open'");
  assert.equal(o.formatLiteral('x', 'Unknown', v), "'x'");
});

test('formatKey', () => {
  assert.equal(o.formatKey('1000'), "('1000')");
  assert.equal(o.formatKey(1000), '(1000)');
  assert.equal(o.formatKey(" ('1') "), "('1')");
  assert.equal(o.formatKey("BusinessPartner='1'"), "(BusinessPartner='1')");
  assert.equal(o.formatKey({ SalesOrderID: '1', ItemPosition: '10' }), "(SalesOrderID='1',ItemPosition='10')");
  assert.equal(o.formatKey({ Id: 'g' }, [{ name: 'Id', type: 'Edm.Guid' }]), "(Id=guid'g')");
  assert.equal(o.formatKey('g', [{ name: 'Id', type: 'Edm.Guid' }], 'v4'), '(g)');
  assert.equal(o.formatKey('42', [{ name: 'Id', type: 'Edm.Int32' }]), '(42)');
  assert.equal(o.formatKey(new Date(0)), "(datetime'1970-01-01T00:00:00')");
  assert.equal(o.formatKey('1', []), "('1')");
  assert.throws(() => o.formatKey(''), /Missing entity key/);
  assert.throws(() => o.formatKey(null), /Missing entity key/);
  assert.throws(() => o.formatKey(undefined), /Missing entity key/);
  assert.throws(() => o.formatKey({}), /Empty entity key/);
  assert.throws(
    () => o.formatKey('1', [{ name: 'A', type: 'Edm.String' }, { name: 'B', type: 'Edm.String' }]),
    /composite key \(A, B\)/
  );
});

test('buildQuery - system query options', () => {
  assert.equal(
    o.buildQuery({ filter: "Country eq 'GR' and Name eq 'A&B'", $select: ['A', 'B'], expand: 'to_X/to_Y', orderby: 'A desc', top: 10, skip: 0, empty: '', nil: null, undef: undefined }),
    "$filter=Country%20eq%20'GR'%20and%20Name%20eq%20'A%26B'&$select=A,B&$expand=to_X/to_Y&$orderby=A%20desc&$top=10&$skip=0"
  );
  assert.equal(o.buildQuery({ count: true }), '$inlinecount=allpages');
  assert.equal(o.buildQuery({ count: 'true' }), '$inlinecount=allpages');
  assert.equal(o.buildQuery({ $inlinecount: 'none' }), '$inlinecount=none');
  assert.equal(o.buildQuery({ count: true }, 'v4'), '$count=true');
  assert.equal(o.buildQuery({ count: false }), '');
  assert.equal(o.buildQuery({ count: 'false' }, 'v4'), '');
  assert.equal(o.buildQuery({ search: 'pump', 'sap-statistics': true, Format: 'json' }), 'search=pump&sap-statistics=true&$format=json');
  assert.equal(o.buildQuery({ search: 'pump' }, 'v4'), '$search=pump');
  assert.equal(o.buildQuery({ $search: 'pump' }, 'v2'), '$search=pump');
  assert.equal(o.buildQuery({ filter: 'D eq datetime\'2024-01-01T00:00:00\'' }), "$filter=D%20eq%20datetime'2024-01-01T00:00:00'");
  assert.equal(o.buildQuery(), '');
});

test('resourcePath', () => {
  assert.equal(o.resourcePath({ entitySet: '/A_BusinessPartner' }), '/A_BusinessPartner');
  assert.equal(o.resourcePath({ entitySet: 'A', key: '1', navigation: '/to_B' }), "/A('1')/to_B");
  assert.equal(o.resourcePath({ entitySet: 'A', key: '' }), '/A');
  assert.equal(o.resourcePath({ entitySet: 'A', key: null }), '/A');
  assert.throws(() => o.resourcePath({}), /No entity set/);
});

test('operationRequest - V2 function import (parameters in query string)', () => {
  assert.deepEqual(o.operationRequest({ name: 'Confirm', params: { Id: "1'0" }, version: 'v2' }), {
    method: 'GET',
    path: '/Confirm',
    query: "Id='1''0'",
    body: undefined,
  });
  const def = { kind: 'function', httpMethod: 'POST', parameters: [{ name: 'Day', type: 'Edm.DateTime' }] };
  assert.deepEqual(o.operationRequest({ name: 'GetDate', params: { Day: '2024-01-01T00:00:00' }, version: 'v2', definition: def }), {
    method: 'POST',
    path: '/GetDate',
    query: "Day=datetime'2024-01-01T00:00:00'",
    body: undefined,
  });
  assert.equal(o.operationRequest({ name: 'X', version: 'v2', httpMethod: 'post' }).method, 'POST');
  assert.equal(o.operationRequest({ name: 'X', version: 'v2', definition: {} }).method, 'GET');
  assert.throws(() => o.operationRequest({ version: 'v2' }), /No function\/action name/);
});

test('operationRequest - V4 function, action and bound operations', () => {
  const fn = { kind: 'function', parameters: [{ name: 'Date', type: 'Edm.Date' }] };
  assert.deepEqual(o.operationRequest({ name: 'GetByDate', params: { Date: '2024-01-01', Name: 'a b' }, version: 'v4', definition: fn }), {
    method: 'GET',
    path: "/GetByDate(Date=2024-01-01,Name='a%20b')",
    query: '',
    body: undefined,
  });
  assert.deepEqual(o.operationRequest({ name: 'ResetAll', params: { Reason: 'x' }, version: 'v4', definition: { kind: 'action' } }), {
    method: 'POST',
    path: '/ResetAll',
    query: '',
    body: { Reason: 'x' },
  });
  assert.deepEqual(o.operationRequest({ name: 'ns.Activate', version: 'v4', httpMethod: 'POST', bindingPath: "/Product('1')" }), {
    method: 'POST',
    path: "/Product('1')/ns.Activate",
    query: '',
    body: {},
  });
  assert.equal(o.operationRequest({ name: 'F', version: 'v4' }).path, '/F()');
});

test('convertV2Dates', () => {
  assert.deepEqual(o.convertV2Dates({ a: '/Date(0)/', b: ['/Date(86400000+0060)/', 'x'], c: 1, d: null, e: { f: '/Date(-1000)/' } }), {
    a: '1970-01-01T00:00:00.000Z',
    b: ['1970-01-02T00:00:00.000Z', 'x'],
    c: 1,
    d: null,
    e: { f: '1969-12-31T23:59:59.000Z' },
  });
});

test('stripMetadata', () => {
  const input = {
    __metadata: { uri: 'u', etag: 'e' },
    '@odata.etag': 'W/"x"',
    'Name@odata.type': '#String',
    Name: 'A',
    to_Deferred: { __deferred: { uri: 'u' } },
    to_Items: { results: [{ __metadata: {}, Id: 1 }] },
    nested: { __metadata: {}, x: 1, y: 2 },
    list: [1, 'a'],
  };
  assert.deepEqual(o.stripMetadata(input), { Name: 'A', to_Items: [{ Id: 1 }], nested: { x: 1, y: 2 }, list: [1, 'a'] });
  assert.equal(o.stripMetadata(5), 5);
});

test('normalize - V2', () => {
  assert.deepEqual(o.normalize({ d: { results: [{ a: 1 }], __count: '5', __next: 'n', __delta: 'dl' } }, 'v2'), {
    data: [{ a: 1 }],
    count: 5,
    nextLink: 'n',
    deltaLink: 'dl',
    isCollection: true,
  });
  assert.deepEqual(o.normalize({ d: { results: [] } }, 'v2'), { data: [], count: undefined, nextLink: undefined, deltaLink: undefined, isCollection: true });
  assert.deepEqual(o.normalize({ d: { a: 1, __metadata: { etag: 'E' } } }, 'v2'), { data: { a: 1, __metadata: { etag: 'E' } }, etag: 'E', isCollection: false });
  assert.deepEqual(o.normalize({ d: { a: 1 } }, 'v2'), { data: { a: 1 }, etag: undefined, isCollection: false });
  assert.deepEqual(o.normalize({ d: null }, 'v2'), { data: null, etag: undefined, isCollection: false });
  assert.deepEqual(o.normalize({ a: 1 }, 'v2'), { data: { a: 1 }, etag: undefined, isCollection: false });
  assert.deepEqual(o.normalize({ d: [{ a: 1 }] }, 'v2'), { data: [{ a: 1 }], isCollection: true });
  assert.deepEqual(o.normalize(null, 'v2'), { data: null, isCollection: false });
  assert.deepEqual(o.normalize(undefined, 'v2'), { data: null, isCollection: false });
  assert.deepEqual(o.normalize('', 'v2'), { data: null, isCollection: false });
  assert.deepEqual(o.normalize('12', 'v2'), { data: '12', isCollection: false });
});

test('normalize - V4', () => {
  assert.deepEqual(o.normalize({ '@odata.context': 'c', '@odata.count': 3, '@odata.nextLink': 'n', '@odata.deltaLink': 'd', value: [{ a: 1 }] }, 'v4'), {
    data: [{ a: 1 }],
    count: 3,
    nextLink: 'n',
    deltaLink: 'd',
    isCollection: true,
  });
  assert.deepEqual(o.normalize({ value: [] }, 'v4'), { data: [], count: undefined, nextLink: undefined, deltaLink: undefined, isCollection: true });
  assert.deepEqual(o.normalize({ '@odata.context': 'c', value: 5 }, 'v4'), { data: 5, isCollection: false });
  assert.deepEqual(o.normalize({ '@odata.etag': 'W/"1"', a: 1, value: [1] }, 'v4'), { data: { '@odata.etag': 'W/"1"', a: 1, value: [1] }, etag: 'W/"1"', isCollection: false });
});
