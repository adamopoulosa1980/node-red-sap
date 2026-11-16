'use strict';

const crypto = require('node:crypto');

/**
 * OData $batch (multipart/mixed) for V2 and V4 as implemented by SAP Gateway.
 *  - Read requests (GET) are top-level parts.
 *  - Modifying requests are wrapped in change sets. A change set is atomic:
 *    if one request fails, SAP rolls back the whole change set and returns a
 *    single error response for it.
 */

const CRLF = '\r\n';
const READ_METHODS = new Set(['GET', 'HEAD']);

function boundary(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function serialiseRequest(req, contentId) {
  const method = (req.method || 'GET').toUpperCase();
  const url = String(req.url || '').replace(/^\/+/, '');
  if (!url) throw new Error('Every $batch request needs a "url" relative to the service root');
  const headers = { Accept: 'application/json', ...(req.headers || {}) };
  let body = '';
  if (req.body !== undefined && req.body !== null && !READ_METHODS.has(method)) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
  }
  const lines = ['Content-Type: application/http', 'Content-Transfer-Encoding: binary'];
  if (contentId !== undefined) lines.push(`Content-ID: ${contentId}`);
  lines.push('', `${method} ${url} HTTP/1.1`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('', body);
  return lines.join(CRLF);
}

/**
 * @param {Array<{method?:string,url:string,headers?:object,body?:*,changeset?:string,contentId?:string}>} requests
 * @param {{atomic?:boolean, version?:'v2'|'v4'}} [options]
 *   atomic (default true): consecutive modifying requests share one change set;
 *   false: each modifying request gets its own change set. A request's own
 *   "changeset" label overrides this (equal consecutive labels are grouped).
 * @returns {{body:string, contentType:string, layout:Array}}
 */
function buildBatch(requests, options = {}) {
  const layout = group(requests, options.atomic !== false);
  const batchBoundary = boundary('batch');

  let contentId = 0;
  const parts = layout.map((item) => {
    if (item.type === 'request') {
      return serialiseRequest(requests[item.index]);
    }
    const csBoundary = boundary('changeset');
    const inner = item.indices
      .map((i) => {
        contentId += 1;
        const id = requests[i].contentId !== undefined ? requests[i].contentId : contentId;
        return `--${csBoundary}${CRLF}${serialiseRequest(requests[i], id)}`;
      })
      .join(CRLF);
    return `Content-Type: multipart/mixed; boundary=${csBoundary}${CRLF}${CRLF}${inner}${CRLF}--${csBoundary}--${CRLF}`;
  });

  const body = parts.map((p) => `--${batchBoundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${batchBoundary}--${CRLF}`;
  return {
    body,
    contentType: `multipart/mixed; boundary=${batchBoundary}`,
    layout: layout.map((l) => (l.type === 'request' ? l : { type: 'changeset', indices: l.indices })),
  };
}

/** Groups requests: reads stand alone, consecutive writes form change sets / atomicity groups. */
function group(requests, atomic) {
  if (!Array.isArray(requests) || requests.length === 0) throw new Error('$batch needs a non-empty array of requests');
  const layout = [];
  let open = null; // { label, indices }

  requests.forEach((req, index) => {
    const method = (req.method || 'GET').toUpperCase();
    if (READ_METHODS.has(method)) {
      open = null;
      layout.push({ type: 'request', index });
      return;
    }
    const label = req.changeset !== undefined && req.changeset !== null ? String(req.changeset) : atomic ? '__default' : `__single_${index}`;
    if (open && open.label === label) {
      open.indices.push(index);
    } else {
      open = { type: 'changeset', label, indices: [index] };
      layout.push(open);
    }
  });
  return layout;
}

/**
 * OData 4.01 JSON batch format (section 19 of the JSON format spec; supported by SAP Gateway for V4).
 * Change sets become atomicity groups; ids default to the 1-based request position.
 * @returns {{body:string, contentType:string, layout:Array<{id:string, group:(string|undefined)}>}}
 */
function buildJsonBatch(requests, options = {}) {
  const grouped = group(requests, options.atomic !== false);
  const entries = [];
  const layout = new Array(requests.length);
  grouped.forEach((item, g) => {
    const indices = item.type === 'request' ? [item.index] : item.indices;
    for (const i of indices) {
      const r = requests[i];
      const method = (r.method || 'GET').toUpperCase();
      const url = String(r.url || '').replace(/^\/+/, '');
      if (!url) throw new Error('Every $batch request needs a "url" relative to the service root');
      const id = String(r.contentId !== undefined ? r.contentId : i + 1);
      const entry = { id, method, url, headers: { accept: 'application/json', ...(r.headers || {}) } };
      const atomicityGroup = item.type === 'changeset' ? `g${g + 1}` : undefined;
      if (atomicityGroup) entry.atomicityGroup = atomicityGroup;
      if (r.dependsOn !== undefined) entry.dependsOn = [].concat(r.dependsOn).map(String);
      if (r.body !== undefined && r.body !== null && !READ_METHODS.has(method)) {
        entry.body = r.body;
        if (!Object.keys(entry.headers).some((h) => h.toLowerCase() === 'content-type')) entry.headers['content-type'] = 'application/json';
      }
      entries.push(entry);
      layout[i] = { id, group: atomicityGroup };
    }
  });
  return { body: JSON.stringify({ requests: entries }), contentType: 'application/json', layout };
}

/**
 * Parses a JSON batch response and aligns it with the requests. A request without
 * its own response (failed atomicity group) gets the group's error response.
 */
function parseJsonBatch(body, layout) {
  const json = typeof body === 'object' && !Buffer.isBuffer(body) ? body : JSON.parse(String(body));
  const byId = new Map();
  for (const r of json.responses || []) {
    const headers = {};
    for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = v;
    const status = Number(r.status);
    byId.set(String(r.id), { status, statusText: '', headers, body: r.body === undefined ? null : r.body, ok: status >= 200 && status < 300 });
  }
  return layout.map(({ id, group: g }) => {
    if (byId.has(id)) return byId.get(id);
    const failed = layout.filter((l) => g && l.group === g && byId.has(l.id) && !byId.get(l.id).ok);
    return failed.length ? byId.get(failed[0].id) : null;
  });
}

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  return m ? m[1] || m[2] : null;
}

function splitMultipart(body, b) {
  const delim = `--${b}`;
  const segments = body.split(delim);
  const parts = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('--')) break; // closing delimiter
    parts.push(seg.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n$/, ''));
  }
  return parts;
}

function splitHead(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { head: text, rest: '' };
  return { head: text.slice(0, m.index), rest: text.slice(m.index + m[0].length) };
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function parseHttpResponse(text) {
  const { head, rest } = splitHead(text.replace(/^\s+/, ''));
  const [statusLine, ...headerLines] = head.split(/\r?\n/);
  const m = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());
  const status = m ? parseInt(m[1], 10) : 0;
  const headers = parseHeaders(headerLines.join('\n'));
  let body = rest.replace(/\r?\n$/, '');
  if (body && /json/i.test(headers['content-type'] || '')) {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep raw text */
    }
  }
  return { status, statusText: m ? m[2] : '', headers, body: body === '' ? null : body, ok: status >= 200 && status < 300 };
}

/** Parses a multipart/mixed batch response into a flat list of parts (nested change sets kept as arrays). */
function parseParts(body, contentType) {
  const b = boundaryOf(contentType);
  if (!b) throw new Error(`$batch response without multipart boundary (Content-Type: ${contentType})`);
  return splitMultipart(body, b).map((part) => {
    const { head, rest } = splitHead(part);
    const headers = parseHeaders(head);
    const ct = headers['content-type'] || '';
    if (/^multipart\/mixed/i.test(ct)) {
      return { changeset: parseParts(rest, ct).map((p) => p.response) };
    }
    return { response: parseHttpResponse(rest), contentId: headers['content-id'] };
  });
}

/**
 * Parses a $batch response and aligns it with the original requests.
 * @returns {Array<{status:number,statusText:string,headers:object,body:*,ok:boolean}>}
 */
function parseBatch(body, contentType, layout, requestCount) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const parts = parseParts(text, contentType);
  if (!layout) {
    return parts.flatMap((p) => (p.changeset ? p.changeset : [p.response]));
  }
  const results = new Array(requestCount !== undefined ? requestCount : layout.reduce((n, l) => n + (l.indices ? l.indices.length : 1), 0)).fill(null);
  layout.forEach((item, i) => {
    const part = parts[i];
    if (!part) return;
    if (item.type === 'request') {
      results[item.index] = part.response || (part.changeset && part.changeset[0]) || null;
      return;
    }
    if (part.changeset) {
      item.indices.forEach((idx, j) => {
        results[idx] = part.changeset[j] || part.changeset[part.changeset.length - 1] || null;
      });
    } else {
      // whole change set failed -> SAP returns one error response
      item.indices.forEach((idx) => {
        results[idx] = part.response;
      });
    }
  });
  return results;
}

module.exports = { buildBatch, parseBatch, buildJsonBatch, parseJsonBatch, boundaryOf };
