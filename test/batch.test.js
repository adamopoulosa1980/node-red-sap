'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBatch, parseBatch, boundaryOf } = require('../lib/batch');

const CRLF = '\r\n';

test('buildBatch - reads top-level, consecutive writes in one atomic change set', () => {
  const b = buildBatch([
    { url: "/A('1')" },
    { method: 'post', url: 'A', body: { Name: 'Ä' } },
    { method: 'PATCH', url: "A('2')", body: '{"x":1}', headers: { 'content-type': 'application/json', 'If-Match': '*' } },
    { method: 'GET', url: 'B' },
    { method: 'DELETE', url: "A('3')", contentId: 'del' },
  ]);
  assert.match(b.contentType, /^multipart\/mixed; boundary=batch_[0-9a-f-]+$/);
  assert.deepEqual(b.layout, [
    { type: 'request', index: 0 },
    { type: 'changeset', indices: [1, 2] },
    { type: 'request', index: 3 },
    { type: 'changeset', indices: [4] },
  ]);
  const bnd = boundaryOf(b.contentType);
  assert.ok(b.body.startsWith(`--${bnd}${CRLF}Content-Type: application/http${CRLF}Content-Transfer-Encoding: binary${CRLF}${CRLF}GET A('1') HTTP/1.1${CRLF}Accept: application/json${CRLF}`));
  assert.ok(b.body.endsWith(`--${bnd}--${CRLF}`));
  assert.ok(b.body.includes(`Content-ID: 1${CRLF}${CRLF}POST A HTTP/1.1${CRLF}Accept: application/json${CRLF}Content-Type: application/json${CRLF}Content-Length: 13${CRLF}${CRLF}{"Name":"Ä"}`));
  assert.ok(b.body.includes(`Content-ID: 2${CRLF}${CRLF}PATCH A('2') HTTP/1.1${CRLF}Accept: application/json${CRLF}content-type: application/json${CRLF}If-Match: *${CRLF}Content-Length: 7${CRLF}${CRLF}{"x":1}`));
  assert.ok(b.body.includes(`Content-ID: del${CRLF}${CRLF}DELETE A('3') HTTP/1.1`));
  assert.equal((b.body.match(/Content-Type: multipart\/mixed; boundary=changeset_/g) || []).length, 2);
});

test('buildBatch - atomic=false and explicit changeset labels', () => {
  const b = buildBatch(
    [
      { method: 'POST', url: 'A', body: {} },
      { method: 'POST', url: 'A', body: {} },
      { method: 'POST', url: 'A', body: {}, changeset: 'g' },
      { method: 'POST', url: 'A', body: {}, changeset: 'g' },
      { method: 'DELETE', url: "A('1')", body: null },
    ],
    { atomic: false }
  );
  assert.deepEqual(b.layout, [
    { type: 'changeset', indices: [0] },
    { type: 'changeset', indices: [1] },
    { type: 'changeset', indices: [2, 3] },
    { type: 'changeset', indices: [4] },
  ]);
  assert.ok(!/DELETE A\('1'\) HTTP\/1.1\r\nAccept: application\/json\r\nContent-Length/.test(b.body));
});

test('buildBatch - validation', () => {
  assert.throws(() => buildBatch([]), /non-empty array/);
  assert.throws(() => buildBatch(null), /non-empty array/);
  assert.throws(() => buildBatch([{ method: 'GET' }]), /needs a "url"/);
});

test('boundaryOf', () => {
  assert.equal(boundaryOf('multipart/mixed; boundary="abc def"'), 'abc def');
  assert.equal(boundaryOf('multipart/mixed;boundary=xyz; charset=utf-8'), 'xyz');
  assert.equal(boundaryOf('application/json'), null);
  assert.equal(boundaryOf(undefined), null);
});

function sapResponse() {
  // Shape of a SAP Gateway $batch response (one read, one successful change set, one failed change set, one read)
  return [
    '--batchresp_1',
    'Content-Type: application/http',
    'Content-Length: 120',
    'content-transfer-encoding: binary',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    'Content-Length: 22',
    '',
    '{"d":{"Id":"1","N":2}}',
    '--batchresp_1',
    'Content-Type: multipart/mixed; boundary=changesetresp_A',
    '',
    '--changesetresp_A',
    'Content-Type: application/http',
    'Content-ID: 1',
    '',
    'HTTP/1.1 201 Created',
    'Content-Type: application/json',
    'location: A(\'9\')',
    '',
    '{"d":{"Id":"9"}}',
    '--changesetresp_A',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 204 No Content',
    'dataserviceversion: 2.0',
    '',
    '',
    '--changesetresp_A--',
    '',
    '--batchresp_1',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 400 Bad Request',
    'Content-Type: application/json',
    '',
    '{"error":{"code":"X","message":{"value":"bad"}}}',
    '--batchresp_1',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '{not json',
    '--batchresp_1--',
    'epilogue',
  ].join(CRLF);
}

test('parseBatch - aligns responses with requests, failed change set applies to all its requests', () => {
  const layout = [
    { type: 'request', index: 0 },
    { type: 'changeset', indices: [1, 2] },
    { type: 'changeset', indices: [3, 4] },
    { type: 'request', index: 5 },
  ];
  const r = parseBatch(Buffer.from(sapResponse()), 'multipart/mixed; boundary=batchresp_1', layout, 6);
  assert.equal(r.length, 6);
  assert.deepEqual(r[0], { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'content-length': '22' }, body: { d: { Id: '1', N: 2 } }, ok: true });
  assert.equal(r[1].status, 201);
  assert.equal(r[1].headers.location, "A('9')");
  assert.deepEqual(r[1].body, { d: { Id: '9' } });
  assert.equal(r[2].status, 204);
  assert.equal(r[2].body, null);
  assert.equal(r[3].status, 400);
  assert.equal(r[3].ok, false);
  assert.equal(r[3], r[4]);
  assert.deepEqual(r[3].body, { error: { code: 'X', message: { value: 'bad' } } });
  assert.equal(r[5].body, '{not json');
});

test('parseBatch - without layout returns a flat list; length inferred from layout', () => {
  const flat = parseBatch(sapResponse(), 'multipart/mixed; boundary=batchresp_1');
  assert.deepEqual(
    flat.map((x) => x.status),
    [200, 201, 204, 400, 200]
  );
  const inferred = parseBatch(sapResponse(), 'multipart/mixed; boundary=batchresp_1', [{ type: 'request', index: 0 }, { type: 'changeset', indices: [1] }]);
  assert.equal(inferred.length, 2);
  assert.equal(inferred[1].status, 201);
});

test('parseBatch - edge cases', () => {
  assert.throws(() => parseBatch('x', 'application/json', []), /without multipart boundary/);
  // fewer parts than layout entries -> null; change set shorter than request list -> last response reused
  const body = ['--b', 'Content-Type: multipart/mixed; boundary=c', '', '--c', 'Content-Type: application/http', '', 'HTTP/1.1 200 OK', '', '', '--c--', '--b--'].join(CRLF);
  const r = parseBatch(body, 'multipart/mixed; boundary=b', [{ type: 'changeset', indices: [0, 1] }, { type: 'request', index: 2 }], 3);
  assert.equal(r[0].status, 200);
  assert.equal(r[1], r[0]);
  assert.equal(r[2], null);
  // read slot answered by a change set / empty change set / part without header separator / garbage status line
  const odd = ['--b', 'Content-Type: multipart/mixed; boundary=c', '', '--c--', '--b', 'Content-Type: multipart/mixed; boundary=d', '', '--d', 'Content-Type: application/http', '', 'HTTP/1.1 202 Accepted', '', '', '--d--', '--b', 'garbage', '--b', 'Content-Type: application/http', '', 'nonsense', '--b--'].join(CRLF);
  const r2 = parseBatch(odd, 'multipart/mixed; boundary=b', [{ type: 'request', index: 0 }, { type: 'request', index: 1 }, { type: 'request', index: 2 }, { type: 'changeset', indices: [3] }], 4);
  assert.equal(r2[0], null);
  assert.equal(r2[1].status, 202);
  assert.equal(r2[2].status, 0);
  assert.equal(r2[3].status, 0);
  assert.equal(r2[3].ok, false);
  assert.equal(r2[3].statusText, '');
  // empty change set for a change set slot; body without Content-Type stays text
  const third = ['--b', 'Content-Type: multipart/mixed; boundary=c', '', '--c--', '--b', 'Content-Type: application/http', '', 'HTTP/1.1 200 OK', '', '{"a":1}', '--b--'].join(CRLF);
  const r3 = parseBatch(third, 'multipart/mixed; boundary=b', [{ type: 'changeset', indices: [0] }, { type: 'request', index: 1 }], 2);
  assert.equal(r3[0], null);
  assert.equal(r3[1].body, '{"a":1}');
});
