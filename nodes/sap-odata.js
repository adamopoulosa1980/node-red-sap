'use strict';

const odata = require('../lib/odata');
const fs = require('node:fs');
const { buildBatch, parseBatch, buildJsonBatch, parseJsonBatch } = require('../lib/batch');
const { parseSapMessages } = require('../lib/client');

const OPERATIONS = ['query', 'get', 'count', 'create', 'update', 'delete', 'function', 'batch', 'metadata', 'catalog', 'request'];
const NEEDS_KEY = new Set(['get', 'update', 'delete']);
const QUERY_FIELDS = ['filter', 'select', 'expand', 'orderby', 'top', 'skip', 'search'];

const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

function parseCustomQuery(text) {
  const out = {};
  for (const pair of String(text || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    out[i < 0 ? pair : pair.slice(0, i)] = i < 0 ? '' : pair.slice(i + 1);
  }
  return out;
}

/** Collects query options: node config first, msg.query overrides. */
function queryOptions(config, msg) {
  const q = {};
  for (const f of QUERY_FIELDS) if (config[f] !== undefined && config[f] !== '') q[f] = config[f];
  if (config.count) q.count = true;
  Object.assign(q, parseCustomQuery(config.custom));
  return { ...q, ...(msg.query || {}) };
}

/** Resolves the update verb. V2 partial update is MERGE (OData 2.0), V4 is PATCH. */
function updateVerb(setting, version) {
  if (setting && setting !== 'auto') return setting;
  return version === 'v4' ? 'PATCH' : 'MERGE';
}

function extractEtag(entity, headers) {
  return pick(headers && headers.etag, entity && entity.__metadata && entity.__metadata.etag, entity && entity['@odata.etag']);
}

const SEVERITY = { 1: 'success', 2: 'info', 3: 'warning', 4: 'error' };

/** Adds RAP messages returned in the entity body (V4 property SAP__Messages) to the header messages. */
function withBodyMessages(messages, data) {
  const list = data && !Array.isArray(data) && Array.isArray(data.SAP__Messages) ? data.SAP__Messages : [];
  return [
    ...messages,
    ...list.map((m) => ({ code: m.code, message: m.message, severity: SEVERITY[m.numericSeverity], target: m.target, longtextUrl: m.longtextUrl })),
  ];
}

module.exports = function (RED) {
  function SapODataNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'no connection' });
      node.on('input', (msg, send, done) => done(new Error('No sap-connection configured')));
      return;
    }
    const client = node.connection.client;

    const postProcess = (data, version) => {
      let out = data;
      if (config.convertDates !== false && version === 'v2') out = odata.convertV2Dates(out);
      if (config.stripMetadata) out = odata.stripMetadata(out);
      return out;
    };

    async function loadModel(svc) {
      if (config.useMetadata === false) return undefined;
      try {
        return (await client.metadata(svc)).model;
      } catch (e) {
        node.warn(`Could not load $metadata for ${svc} (${e.message}); keys/parameters are formatted from their JS type`);
        return undefined;
      }
    }

    async function readAll(firstUrl, headers, svc, version, first) {
      const pages = [first];
      let norm = odata.normalize(first.body, version);
      const data = [...norm.data];
      const limit = Number(config.maxPages) || 100;
      while (norm.nextLink && pages.length < limit) {
        const next = new URL(norm.nextLink, firstUrl).toString();
        const res = await client.request('GET', next, { headers, servicePath: svc });
        pages.push(res);
        norm = odata.normalize(res.body, version);
        data.push(...norm.data);
      }
      return { data, nextLink: norm.nextLink, pages: pages.length };
    }

    async function resolveEtag(msg, svc, path, headers, version) {
      const mode = config.etag || 'auto';
      if (mode === 'none') return undefined;
      if (mode === 'wildcard') return '*';
      const given = pick(msg.etag, extractEtag(msg.payload));
      if (given || mode === 'msg') return given;
      // auto: read the current entity to obtain its ETag (only if the service uses ETags)
      const res = await client.request('GET', svc + path, { headers, servicePath: svc });
      return extractEtag(odata.normalize(res.body, version).data, res.headers);
    }

    async function execute(msg) {
      const operation = pick(msg.operation, config.operation, 'query');
      if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation "${operation}"`);
      if (operation === 'catalog') return { payload: await client.catalog(), odata: { operation } };

      const svc = odata.servicePath(pick(msg.service, config.service));
      const version = pick(msg.odataVersion, config.version !== 'auto' ? config.version : undefined, odata.detectVersion(svc));
      const headers = { ...(msg.headers || {}) };
      const meta = { operation, version, service: svc };

      if (operation === 'metadata') {
        const { model, xml } = await client.metadata(svc, { force: msg.refresh === true });
        return { payload: model, metadataXml: xml, odata: meta };
      }

      if (operation === 'request') {
        const method = pick(msg.method, config.method, 'GET').toUpperCase();
        const p = pick(msg.path, config.path) || '';
        const target = /^(https?:\/\/|\/sap\/)/i.test(p) ? p : `${svc}/${p.replace(/^\/+/, '')}`;
        let body = method === 'GET' ? undefined : msg.payload;
        if (msg.uploadFile) {
          // streaming upload (e.g. media resources: PUT .../$value, POST to a media entity set)
          const size = (await fs.promises.stat(msg.uploadFile)).size;
          body = () => fs.createReadStream(msg.uploadFile);
          headers['Content-Length'] = size;
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/octet-stream';
        }
        const sink = msg.downloadFile ? fs.createWriteStream(msg.downloadFile) : undefined;
        const res = await client.request(method, target, { headers, body, servicePath: svc, raw: true, sink });
        const odataOut = { ...meta, statusCode: res.statusCode, headers: res.headers, url: res.url, messages: res.messages };
        if (res.streamed) return { payload: { file: msg.downloadFile, bytes: sink.bytesWritten }, odata: odataOut };
        const ct = res.headers['content-type'] || '';
        let payload = res.body; // binary (Buffer) unless empty, JSON, XML or text
        if (!res.body.length) payload = '';
        else if (/json/i.test(ct)) payload = postProcess(JSON.parse(res.text), version);
        else if (/xml|text/i.test(ct)) payload = res.text;
        return { payload, odata: odataOut };
      }

      if (operation === 'batch') {
        if (!Array.isArray(msg.payload)) throw new Error('batch: msg.payload must be an array of requests');
        const format = pick(msg.batchFormat, config.batchFormat, 'multipart');
        if (format === 'json' && version !== 'v4') throw new Error('batch: the JSON batch format is only defined for OData V4');
        const model = msg.payload.some((r) => !r.url && r.key !== undefined) ? await loadModel(svc) : undefined;
        const requests = msg.payload.map((r) => {
          if (r.url) return r;
          const keyProps = model && model.entitySets[r.entitySet] ? model.entitySets[r.entitySet].keys : undefined;
          const path = odata.resourcePath({ entitySet: r.entitySet, key: r.key, navigation: r.navigation, keyProps, version }).slice(1);
          const qs = r.query ? odata.buildQuery(r.query, version) : '';
          return { ...r, url: qs ? `${path}?${qs}` : path };
        });
        const atomic = msg.atomic !== undefined ? msg.atomic !== false : config.atomic !== false;
        const json = format === 'json';
        const batch = json ? buildJsonBatch(requests, { atomic }) : buildBatch(requests, { atomic });
        let res;
        try {
          res = await client.request('POST', `${svc}/$batch`, {
            headers: { ...headers, 'Content-Type': batch.contentType, Accept: json ? 'application/json' : 'multipart/mixed' },
            body: batch.body,
            servicePath: svc,
            raw: true,
          });
        } catch (e) {
          // SAP Gateway (ABAP) answers the OData 4.01 JSON batch format with 415; only multipart/mixed is supported there
          if (json && e.statusCode === 415) e.message = `${e.message} - this server does not support the JSON batch format, use batchFormat "multipart"`;
          throw e;
        }
        const parsed = json ? parseJsonBatch(res.text, batch.layout) : parseBatch(res.text, res.headers['content-type'], batch.layout, requests.length);
        const results = parsed.map((r) =>
          r
            ? {
                ...r,
                messages: parseSapMessages(r.headers),
                data: r.ok ? postProcess(odata.normalize(r.body, version).data, version) : undefined,
              }
            : null
        );
        const errors = results.filter((r) => !r || !r.ok).length;
        return { payload: results, odata: { ...meta, format, statusCode: res.statusCode, errors, messages: res.messages } };
      }

      const entitySet = pick(msg.entitySet, config.entitySet);
      const key = pick(msg.key, config.key);
      const navigation = pick(msg.navigation, config.navigation);

      if (operation === 'function') {
        const name = pick(msg.functionName, config.functionName);
        const model = await loadModel(svc);
        const definition = model && model.operations[name];
        const params = msg.params || (msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {});
        const bindingPath = pick(msg.bindingPath, config.bindingPath);
        const r = odata.operationRequest({ name, params, version, definition, httpMethod: pick(msg.method, config.method), bindingPath });
        const h = { ...headers };
        if (bindingPath && r.method === 'POST') {
          // an action bound to an entity with an ETag must be conditional (OData 4.01 11.5.4.1; enforced by SAP RAP)
          const etag = await resolveEtag(msg, svc, `/${bindingPath.replace(/^\/+/, '')}`, headers, version);
          if (etag) h['If-Match'] = etag;
        }
        const res = await client.request(r.method, svc + r.path, { query: r.query, headers: h, body: r.body, servicePath: svc });
        const norm = odata.normalize(res.body, version);
        return { payload: postProcess(norm.data, version), odata: { ...meta, statusCode: res.statusCode, headers: res.headers, url: res.url, messages: res.messages } };
      }

      if (NEEDS_KEY.has(operation) && (key === undefined || key === null || key === '')) {
        throw new Error(`${operation}: an entity key is required (msg.key or node setting)`);
      }
      const model = key !== undefined && key !== null && key !== '' ? await loadModel(svc) : undefined;
      const keyProps = model && model.entitySets[entitySet] ? model.entitySets[entitySet].keys : undefined;
      const path = odata.resourcePath({ entitySet, key, navigation, keyProps, version });

      switch (operation) {
        case 'query':
        case 'get': {
          const qs = odata.buildQuery(queryOptions(config, msg), version);
          const res = await client.request('GET', svc + path, { query: qs, headers, servicePath: svc });
          const norm = odata.normalize(res.body, version);
          const fetchAll = msg.fetchAll !== undefined ? msg.fetchAll === true : config.fetchAll === true;
          if (norm.isCollection && fetchAll) {
            const all = await readAll(res.url, headers, svc, version, res);
            return { payload: postProcess(all.data, version), odata: { ...meta, count: norm.count, nextLink: all.nextLink, pages: all.pages, url: res.url, messages: res.messages } };
          }
          return {
            payload: postProcess(norm.data, version),
            odata: { ...meta, count: norm.count, nextLink: norm.nextLink, etag: extractEtag(norm.data, res.headers), statusCode: res.statusCode, url: res.url, messages: res.messages },
          };
        }
        case 'count': {
          const q = queryOptions(config, msg);
          const countQuery = {};
          for (const f of ['filter', 'search']) if (q[f] !== undefined) countQuery[f] = q[f];
          const res = await client.request('GET', `${svc}${path}/$count`, { query: odata.buildQuery(countQuery, version), headers: { Accept: 'text/plain', ...headers }, servicePath: svc });
          return { payload: Number(String(res.text).trim()), odata: { ...meta, statusCode: res.statusCode, url: res.url, messages: res.messages } };
        }
        case 'create': {
          const res = await client.request('POST', svc + path, { headers, body: msg.payload, servicePath: svc });
          const norm = odata.normalize(res.body, version);
          return {
            payload: postProcess(norm.data, version),
            odata: { ...meta, statusCode: res.statusCode, location: res.headers.location, etag: extractEtag(norm.data, res.headers), url: res.url, messages: res.messages },
          };
        }
        case 'update': {
          const verb = updateVerb(pick(msg.method, config.updateMethod), version);
          const etag = await resolveEtag(msg, svc, path, headers, version);
          const h = { ...headers };
          if (etag) h['If-Match'] = etag;
          let method = verb;
          if (verb === 'MERGE' && config.tunnel) {
            method = 'POST';
            h['X-HTTP-Method'] = 'MERGE';
          }
          const res = await client.request(method, svc + path, { headers: h, body: msg.payload, servicePath: svc });
          const norm = odata.normalize(res.body, version);
          return {
            payload: res.statusCode === 204 ? msg.payload : postProcess(norm.data, version),
            odata: { ...meta, statusCode: res.statusCode, method: verb, etag: extractEtag(norm.data, res.headers), url: res.url, messages: res.messages },
          };
        }
        default: {
          // delete
          const etag = await resolveEtag(msg, svc, path, headers, version);
          const h = { ...headers };
          if (etag) h['If-Match'] = etag;
          const res = await client.request('DELETE', svc + path, { headers: h, servicePath: svc });
          return { payload: null, odata: { ...meta, statusCode: res.statusCode, url: res.url, messages: res.messages } };
        }
      }
    }

    node.on('input', async (msg, send, done) => {
      node.status({ fill: 'blue', shape: 'dot', text: 'requesting' });
      try {
        const result = await execute(msg);
        if (result.odata.messages) result.odata.messages = withBodyMessages(result.odata.messages, result.payload);
        Object.assign(msg, result);
        node.status({ fill: 'green', shape: 'dot', text: `${result.odata.operation} ${result.odata.statusCode || 'ok'}` });
        send(msg);
        done();
      } catch (e) {
        msg.error = e.toJSON ? e.toJSON() : { message: e.message };
        node.status({ fill: 'red', shape: 'ring', text: e.statusCode ? `HTTP ${e.statusCode}` : 'error' });
        done(e);
      }
    });
  }

  RED.nodes.registerType('sap-odata', SapODataNode);
};
