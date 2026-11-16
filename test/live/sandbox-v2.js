'use strict';
// Live smoke test against https://sandbox.api.sap.com (read-only). Usage:
//   SAP_SANDBOX_API_KEY=<key> npm run test:live   (or put the key in sap-api-key-sandbox.txt, git-ignored)
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const { SapClient } = require(path.join(root, 'lib/client'));
const odata = require(path.join(root, 'lib/odata'));

const key = process.env.SAP_SANDBOX_API_KEY || fs.readFileSync(path.join(root, 'sap-api-key-sandbox.txt'), 'utf8').trim();
const client = new SapClient({ url: 'https://sandbox.api.sap.com', authType: 'apikey', credentials: { token: key } });
const svc = '/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER';

(async () => {
  const step = async (name, fn) => {
    try {
      console.log(`OK   ${name}: ${await fn()}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`FAIL ${name}: ${e.statusCode || ''} ${e.message}`);
    }
  };

  let model;
  await step('$metadata', async () => {
    model = (await client.metadata(svc)).model;
    const bp = model.entitySets.A_BusinessPartner;
    return `${model.version}, ${Object.keys(model.entitySets).length} entity sets, ${Object.keys(model.operations).length} operations, A_BusinessPartner key=${bp.keys.map((k) => `${k.name}:${k.type}`).join(',')}`;
  });

  let first;
  await step('query $top=3 $inlinecount $select', async () => {
    const qs = odata.buildQuery({ top: 3, count: true, select: 'BusinessPartner,BusinessPartnerFullName,CreationDate', orderby: 'BusinessPartner' }, 'v2');
    const res = await client.request('GET', `${svc}/A_BusinessPartner`, { query: qs });
    const n = odata.normalize(res.body, 'v2');
    first = n.data[0];
    const sample = odata.stripMetadata(odata.convertV2Dates(n.data[0]));
    return `${n.data.length} rows, __count=${n.count}, first=${JSON.stringify(sample)}`;
  });

  await step('$filter with string literal (quotes sent verbatim)', async () => {
    const qs = odata.buildQuery({ filter: `BusinessPartner eq '${first.BusinessPartner}'`, select: 'BusinessPartner' }, 'v2');
    const res = await client.request('GET', `${svc}/A_BusinessPartner`, { query: qs });
    return `${odata.normalize(res.body, 'v2').data.length} row(s) for ${first.BusinessPartner}`;
  });

  await step('get by key (typed from $metadata) + etag', async () => {
    const p = odata.resourcePath({ entitySet: 'A_BusinessPartner', key: first.BusinessPartner, keyProps: model.entitySets.A_BusinessPartner.keys, version: 'v2' });
    const res = await client.request('GET', svc + p);
    const n = odata.normalize(res.body, 'v2');
    return `${p} -> ${n.data.BusinessPartner}, etag=${n.etag || res.headers.etag || '(none)'}`;
  });

  await step('navigation to_BusinessPartnerAddress', async () => {
    const p = odata.resourcePath({ entitySet: 'A_BusinessPartner', key: first.BusinessPartner, navigation: 'to_BusinessPartnerAddress', version: 'v2' });
    const res = await client.request('GET', svc + p, { query: '$top=2' });
    return `${odata.normalize(res.body, 'v2').data.length} address(es)`;
  });

  await step('$count', async () => {
    const res = await client.request('GET', `${svc}/A_BusinessPartner/$count`, { headers: { Accept: 'text/plain' } });
    return res.text.trim();
  });

  await step('error format (unknown entity set)', async () => {
    try {
      await client.request('GET', `${svc}/DoesNotExist`);
      return 'unexpected success';
    } catch (e) {
      return `HTTP ${e.statusCode}, code=${e.code}, message="${e.message}"`;
    }
  });

  await step('$batch (2 reads)', async () => {
    const { buildBatch, parseBatch } = require(path.join(root, 'lib/batch'));
    const b = buildBatch([{ url: 'A_BusinessPartner?$top=1&$select=BusinessPartner' }, { url: `A_BusinessPartner('${first.BusinessPartner}')?$select=BusinessPartner` }]);
    const res = await client.request('POST', `${svc}/$batch`, { headers: { 'Content-Type': b.contentType, Accept: 'multipart/mixed' }, body: b.body, raw: true, servicePath: svc });
    const parts = parseBatch(res.text, res.headers['content-type'], b.layout, 2);
    return `HTTP ${res.statusCode}, parts=${parts.map((p) => p && p.status).join(',')}`;
  });
})();
