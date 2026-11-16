'use strict';
/**
 * Live end-to-end test of the sap-odata node against a local ABAP Cloud Developer Trial
 * (docker image sapse/abap-cloud-developer-trial). Writes data:
 *   V2 /sap/opu/odata/iwbep/GWSAMPLE_BASIC   BusinessPartner CRUD, ETag, CSRF, function import, $batch
 *   V4 /DMO/TRAVEL_U (RAP, unmanaged)         Travel CRUD, ETag, bound action, multipart + JSON $batch
 * Usage: SAP_URL=http://localhost:50000 SAP_USER=DEVELOPER SAP_PASSWORD=... node test/live/local-trial.js
 *   (falls back to sap-trial-credentials.txt, git-ignored)
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const helper = require('node-red-node-test-helper');

helper.init(require.resolve('node-red'));

function password() {
  if (process.env.SAP_PASSWORD) return process.env.SAP_PASSWORD;
  const text = fs.readFileSync(path.join(root, 'sap-trial-credentials.txt'), 'utf8');
  const m = /User\s*:\s*DEVELOPER\s*\r?\n\s*Pass\s*:\s*(\S+)/.exec(text);
  if (!m) throw new Error('No DEVELOPER password: set SAP_PASSWORD');
  return m[1];
}

const V2 = '/sap/opu/odata/iwbep/GWSAMPLE_BASIC';
const V4 = '/sap/opu/odata4/dmo/api_travel_u_v4/srvd_a2x/dmo/travel_u/0001';
const NS = 'com.sap.gateway.srvd_a2x.dmo.travel_u.v0001';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

helper.startServer(async () => {
  const flow = [
    { id: 't', type: 'tab' },
    { id: 'c', type: 'sap-connection', url: process.env.SAP_URL || 'http://localhost:50000', client: '001', language: 'EN', timeout: 120000 },
    { id: 'n', type: 'sap-odata', z: 't', connection: 'c', service: V2, wires: [['h']] },
    { id: 'h', type: 'helper', z: 't' },
  ];
  await helper.load([require('../../nodes/sap-connection'), require('../../nodes/sap-odata')], flow, { c: { user: process.env.SAP_USER || 'DEVELOPER', password: password() } });
  const n = helper.getNode('n');
  const h = helper.getNode('h');
  const conn = helper.getNode('c');
  // on() + removeListener(): Node-RED's input listeners do not support once()
  const call = (msg) =>
    new Promise((resolve) => {
      let timer;
      const finish = (result) => {
        clearTimeout(timer);
        n.removeListener('call:error', onErr);
        h.removeListener('input', onOut);
        resolve(result);
      };
      const onErr = (c) => finish({ error: c.args[0], msg: c.args[1] });
      const onOut = (m) => finish({ msg: m });
      n.on('call:error', onErr);
      h.on('input', onOut);
      timer = setTimeout(() => finish({ error: { message: 'no output after 60 s' } }), 60000);
      n.receive(msg);
    });

  try {
    // ------------------------------------------------------------ V2
    console.log('--- V2 GWSAMPLE_BASIC');
    const stamp = new Date().toISOString().slice(11, 19);
    const bp = {
      CompanyName: `Node-RED ${stamp}`,
      EmailAddress: `node-red-${Date.now()}@example.com`,
      CurrencyCode: 'EUR',
      BusinessPartnerRole: '01',
      Address: { City: 'Athens', PostalCode: '10431', Street: "O'Neil Street", Building: '1', Country: 'GR', AddressType: '02' },
    };
    // remove leftovers of interrupted runs
    let r = await call({ operation: 'query', entitySet: 'BusinessPartnerSet', query: { filter: "startswith(CompanyName,'Node-RED')", select: 'BusinessPartnerID' } });
    for (const old of r.msg?.payload || []) await call({ operation: 'delete', entitySet: 'BusinessPartnerSet', key: old.BusinessPartnerID, etag: '*' });
    check('cleanup query with startswith()', Array.isArray(r.msg?.payload), `${(r.msg?.payload || []).length} leftover(s) removed`);

    r = await call({ operation: 'create', entitySet: 'BusinessPartnerSet', payload: bp });
    const id = r.msg?.payload && r.msg.payload.BusinessPartnerID;
    check('create (POST, CSRF token fetched)', r.msg?.odata?.statusCode === 201 && id, r.error ? r.error.message : `id=${id}`);

    r = await call({ operation: 'get', entitySet: 'BusinessPartnerSet', key: id });
    const etag1 = r.msg?.odata?.etag;
    check('read by key (typed from $metadata) + ETag', r.msg?.payload?.CompanyName === bp.CompanyName && etag1, `etag=${etag1}`);
    check('V2 /Date()/ converted to ISO', r.msg && /^\d{4}-\d\d-\d\dT/.test(r.msg.payload.CreatedAt), r.msg?.payload?.CreatedAt);

    r = await call({ operation: 'query', entitySet: 'BusinessPartnerSet', query: { filter: `CompanyName eq '${bp.CompanyName}'`, select: 'BusinessPartnerID,CompanyName', count: true } });
    check("query with $filter literal + $inlinecount", r.msg?.payload?.length === 1 && r.msg.odata.count === 1, r.error && r.error.message);

    r = await call({ operation: 'update', entitySet: 'BusinessPartnerSet', key: id, payload: { CompanyName: `${bp.CompanyName} upd` } });
    check('update (MERGE, If-Match read automatically)', r.msg?.odata?.statusCode === 204 && r.msg.odata.method === 'MERGE', r.error && r.error.message);

    r = await call({ operation: 'update', entitySet: 'BusinessPartnerSet', key: id, etag: etag1, payload: { CompanyName: 'stale' } });
    check('stale ETag rejected (412 Precondition Failed)', r.error && r.error.statusCode === 412, r.error ? `${r.error.statusCode} ${r.error.message}` : 'no error');

    conn.client.csrfToken = 'expired-token';
    r = await call({ operation: 'update', entitySet: 'BusinessPartnerSet', key: id, payload: { PhoneNumber: '2100000000' } });
    check('expired CSRF token refreshed transparently', r.msg?.odata?.statusCode === 204, r.error && r.error.message);

    r = await call({ operation: 'query', entitySet: 'SalesOrderSet', query: { top: 1, select: 'SalesOrderID', filter: "LifecycleStatus eq 'N'" } });
    const so = r.msg?.payload?.[0] && r.msg.payload[0].SalesOrderID;
    r = await call({ operation: 'function', functionName: 'SalesOrder_Confirm', params: { SalesOrderID: so } });
    check('function import (POST from $metadata)', r.msg?.odata?.statusCode === 200, r.error ? r.error.message : `SalesOrder ${so}`);

    // GWSAMPLE_BASIC answers every change set with "Missing response data in changeset deferred processing mode"
    // (a limitation of that demo service), so V2 change sets are checked on the RAP service API_TRAVEL_U_V2
    const V2T = '/sap/opu/odata/dmo/API_TRAVEL_U_V2';
    r = await call({ service: V2T, operation: 'get', entitySet: 'Travel', key: '1', query: { select: 'Memo' } });
    const memo = r.msg?.payload?.Memo;
    r = await call({
      service: V2T,
      operation: 'batch',
      payload: [
        { entitySet: 'Travel', key: '1', query: { select: 'Memo' } },
        { method: 'MERGE', entitySet: 'Travel', key: '1', body: { Memo: 'Node-RED batch 1' }, headers: { 'If-Match': '*' } },
        { method: 'MERGE', entitySet: 'Travel', key: '1', body: { Memo: 'Node-RED batch 2' }, headers: { 'If-Match': '*' } },
      ],
    });
    check('$batch multipart V2: read + atomic change set', (r.msg?.payload || []).map((x) => x.status).join(',') === '200,204,204', r.error ? r.error.message : (r.msg?.payload || []).map((x) => x.status).join(','));
    r = await call({ service: V2T, operation: 'update', entitySet: 'Travel', key: '1', etag: '*', payload: { Memo: memo } });
    check('original value restored', r.msg?.odata?.statusCode === 204, r.error && r.error.message);
    const created2 = undefined;

    r = await call({ operation: 'batch', payload: [{ method: 'POST', entitySet: 'BusinessPartnerSet', body: { CompanyName: 'missing fields' } }, { method: 'MERGE', entitySet: 'BusinessPartnerSet', key: id, body: { CompanyName: 'must roll back' }, headers: { 'If-Match': '*' } }] });
    check('$batch failed change set -> error for every request', r.msg?.payload?.every((x) => !x.ok) && r.msg.odata.errors === 2, r.msg?.payload?.map((x) => x.status).join(','));

    for (const key of [id, created2].filter(Boolean)) {
      r = await call({ operation: 'delete', entitySet: 'BusinessPartnerSet', key });
      check(`delete ${key}`, r.msg?.odata?.statusCode === 204, r.error && r.error.message);
    }
    r = await call({ operation: 'get', entitySet: 'BusinessPartnerSet', key: id });
    check('deleted entity is gone (SAP error code parsed)', r.error && [400, 404].includes(r.error.statusCode) && r.msg?.error?.code, r.error && `${r.error.statusCode} ${r.msg?.error?.code} ${r.error.message}`);

    // ------------------------------------------------------------ V4
    console.log('--- V4 /DMO/TRAVEL_U');
    const travel = { AgencyID: '70041', CustomerID: '594', BeginDate: '2026-12-01', EndDate: '2026-12-10', BookingFee: 10, CurrencyCode: 'EUR', Memo: 'Node-RED live test' };
    r = await call({ service: V4, operation: 'create', entitySet: 'Travel', payload: travel });
    const tid = r.msg?.payload && r.msg.payload.TravelID;
    check('V4 create', r.msg?.odata?.statusCode === 201 && tid, r.error ? r.error.message : `TravelID=${tid}`);

    r = await call({ service: V4, operation: 'update', entitySet: 'Travel', key: tid, payload: { Memo: 'patched' } });
    check('V4 update (PATCH, @odata.etag)', r.msg?.odata?.method === 'PATCH' && r.msg.odata.statusCode < 300, r.error && r.error.message);

    r = await call({ service: V4, operation: 'function', functionName: `${NS}.set_status_booked`, bindingPath: `Travel('${tid}')` });
    check('V4 bound action', r.msg?.odata?.statusCode < 300 && r.msg.payload && r.msg.payload.Status === 'B', r.error ? r.error.message : `Status=${r.msg.payload && r.msg.payload.Status}`);

    r = await call({ service: V4, operation: 'batch', batchFormat: 'json', payload: [{ entitySet: 'Travel', key: tid }, { method: 'PATCH', entitySet: 'Travel', key: tid, body: { Memo: 'json batch' }, headers: { 'If-Match': '*' } }] });
    // ABAP SAP Gateway supports only multipart/mixed batches (verified: 415 on ABAP Platform 2025); the node says so
    check('V4 JSON $batch: unsupported by ABAP Gateway, clear hint', r.msg?.payload?.every((x) => x && x.ok) || (r.error?.statusCode === 415 && /use batchFormat "multipart"/.test(r.error.message)), r.error ? r.error.message : 'supported');

    r = await call({ service: V4, operation: 'batch', payload: [{ entitySet: 'Travel', key: tid, query: { select: 'Memo' } }, { method: 'PATCH', entitySet: 'Travel', key: tid, body: { Memo: 'multipart batch' }, headers: { 'If-Match': '*' } }] });
    check('V4 multipart $batch', r.msg?.payload?.every((x) => x && x.ok), r.error ? r.error.message : (r.msg?.payload || []).map((x) => x && x.status).join(','));

    r = await call({ service: V4, operation: 'get', entitySet: 'Travel', key: tid });
    check('V4 read back', r.msg?.payload?.Memo === 'multipart batch', r.msg?.payload?.Memo);

    r = await call({ service: V4, operation: 'delete', entitySet: 'Travel', key: tid });
    check('V4 delete', r.msg?.odata?.statusCode === 204, r.error && r.error.message);
  } catch (e) {
    failures += 1;
    console.log('FAIL unexpected', e.stack);
  }
  console.log(failures ? `${failures} check(s) failed` : 'all live checks passed');
  await helper.unload();
  helper.stopServer(() => process.exit(failures ? 1 : 0));
});
