'use strict';
const fs = require('node:fs'); const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const { SapClient } = require(path.join(root, 'lib/client'));
const odata = require(path.join(root, 'lib/odata'));
const { buildBatch, parseBatch } = require(path.join(root, 'lib/batch'));
const key = process.env.SAP_SANDBOX_API_KEY || fs.readFileSync(path.join(root, 'sap-api-key-sandbox.txt'), 'utf8').trim();
const c = new SapClient({ url: 'https://sandbox.api.sap.com', authType: 'apikey', credentials: { token: key } });
(async () => {
  for (const svc of ['/s4hanacloud/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0002', '/s4hanacloud/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001']) {
    try {
      const { model } = await c.metadata(svc);
      const set = Object.keys(model.entitySets)[0];
      console.log(`OK   ${svc} $metadata: ${model.version}, ${Object.keys(model.entitySets).length} sets, first=${set} keys=${JSON.stringify(model.entitySets[set].keys)}`);
      const r = await c.request('GET', `${svc}/${set}`, { query: odata.buildQuery({ top: 2, count: true }, 'v4') });
      const n = odata.normalize(r.body, 'v4');
      console.log(`OK   query: ${n.data.length} rows, @odata.count=${n.count}, nextLink=${n.nextLink ? 'yes' : 'no'}`);
      const k = {}; for (const kp of model.entitySets[set].keys) k[kp.name] = n.data[0][kp.name];
      const p = odata.resourcePath({ entitySet: set, key: k, keyProps: model.entitySets[set].keys, version: 'v4' });
      const g = await c.request('GET', svc + p);
      console.log(`OK   get ${p}: etag=${odata.normalize(g.body, 'v4').etag || g.headers.etag || '(none)'}`);
      const b = buildBatch([{ url: `${set}?$top=1` }, { url: p.slice(1) }]);
      const br = await c.request('POST', `${svc}/$batch`, { headers: { 'Content-Type': b.contentType, Accept: 'multipart/mixed' }, body: b.body, raw: true, servicePath: svc });
      console.log(`OK   V4 $batch: HTTP ${br.statusCode}, parts=${parseBatch(br.text, br.headers['content-type'], b.layout, 2).map((x) => x && x.status).join(',')}`);
      return;
    } catch (e) { console.log(`FAIL ${svc}: ${e.statusCode || ''} ${e.message}`.slice(0, 300)); }
  }
  process.exitCode = 1; // no service version worked
})();
