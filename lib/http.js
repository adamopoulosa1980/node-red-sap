'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tlsLib = require('node:tls');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { ntlmConnect, httpsProxyAgent, proxyHeaders, proxyPort } = require('./proxy');

/**
 * Minimal cookie jar for a single SAP host. SAP Gateway binds the CSRF token
 * to the session cookies (SAP_SESSIONID_<SID>_<CLIENT>, sap-usercontext), so
 * they must be replayed on every request of the same client.
 */
class CookieJar {
  constructor() {
    this.cookies = new Map(); // key "name|path" -> { name, value, path, expires }
  }

  store(setCookie) {
    if (!setCookie) return;
    for (const raw of [].concat(setCookie)) {
      const [nameValue, ...attrs] = raw.split(';');
      const eq = nameValue.indexOf('=');
      if (eq <= 0) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();
      let path = '/';
      let expires = null;
      for (const attr of attrs) {
        const i = attr.indexOf('=');
        const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : attr.slice(i + 1).trim();
        if (k === 'path') path = v || '/';
        else if (k === 'max-age') {
          const s = parseInt(v, 10);
          if (!Number.isNaN(s)) expires = Date.now() + s * 1000;
        } else if (k === 'expires' && expires === null) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) expires = t;
        }
      }
      const key = `${name}|${path}`;
      if (expires !== null && expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path, expires });
    }
  }

  header(urlPath) {
    const now = Date.now();
    const out = [];
    for (const [key, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (urlPath.startsWith(c.path)) out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }
}

/**
 * Decodes a response body according to Content-Encoding. SAP Web Dispatcher,
 * ICM and API Management (e.g. sandbox.api.sap.com) compress responses.
 */
function decode(buf, encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buf);
    case 'deflate':
      return zlib.inflateSync(buf);
    case 'br':
      return zlib.brotliDecompressSync(buf);
    default:
      return buf;
  }
}

/** Streaming decoder for Content-Encoding (null = identity). */
function decoder(encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

const isStream = (b) => b !== null && typeof b === 'object' && typeof b.pipe === 'function';

/** Executes one request on the given transport; buffers the response or streams it into `sink`. */
function exchange(transport, options, { method, url, body, timeout, sink }) {
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const meta = { statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, url };
      const encoding = res.headers['content-encoding'];
      if (sink && res.statusCode < 400) {
        const dec = decoder(encoding);
        pipeline(...[res, dec, sink].filter(Boolean), (err) => (err ? reject(err) : resolve({ ...meta, body: Buffer.alloc(0), streamed: true })));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ ...meta, body: decode(Buffer.concat(chunks), encoding) });
        } catch (e) {
          reject(new Error(`Could not decode ${encoding} response from ${method} ${url}: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`Request timed out after ${timeout} ms: ${method} ${url}`)));
    req.on('error', reject);
    if (isStream(body)) {
      body.on('error', (e) => req.destroy(e));
      body.pipe(req);
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

function targetTls(tls) {
  return {
    rejectUnauthorized: tls.rejectUnauthorized !== false,
    ca: tls.ca || undefined,
    cert: tls.cert || undefined,
    key: tls.key || undefined,
    pfx: tls.pfx || undefined,
    passphrase: tls.passphrase || undefined,
  };
}

/**
 * Performs a single HTTP(S) request.
 * @param {object} o
 * @param {string} o.method
 * @param {string} o.url
 * @param {object} [o.headers]
 * @param {Buffer|string|import('stream').Readable|function():import('stream').Readable} [o.body]
 * @param {number} [o.timeout=60000]
 * @param {object} [o.tls]    rejectUnauthorized, ca, cert, key, pfx, passphrase
 * @param {object} [o.proxy]  resolved proxy (lib/proxy.resolveProxy)
 * @param {import('stream').Writable} [o.sink] stream a successful response body into this writable
 * @returns {Promise<{statusCode:number, statusMessage:string, headers:object, body:Buffer, url:string, streamed?:boolean}>}
 */
async function send({ method, url, headers = {}, body, timeout = 60000, tls = {}, proxy = null, sink }) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (secure ? 443 : 80);
  const make = typeof body === 'function' ? body : () => body;
  const toPayload = (b) => (b === undefined || b === null || isStream(b) ? b : Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'));
  const hdrs = { 'Accept-Encoding': 'gzip, deflate, br', ...headers };
  const first = toPayload(make());
  if (Buffer.isBuffer(first) && hdrs['Content-Length'] === undefined) hdrs['Content-Length'] = first.length;
  const ctx = { method, url, body: first, timeout, sink };

  // Use the path exactly as built: WHATWG URL would re-encode ' to %27 inside OData literals
  const rawPath = url.replace(/^https?:\/\/[^/?#]+/i, '') || '/';
  const direct = { protocol: u.protocol, hostname, port, path: rawPath, method, headers: hdrs, ...targetTls(tls) };

  if (!proxy) return exchange(secure ? https : http, direct, ctx);

  if (proxy.auth === 'ntlm') {
    if (secure) {
      const tunnel = await ntlmConnect(proxy, { mode: 'connect', host: hostname, port }, timeout, tls);
      const servername = net.isIP(hostname) ? undefined : hostname;
      // no "agent" option: node only honours createConnection when no agent is given (agent:false would open a new direct connection)
      return exchange(https, { ...direct, createConnection: () => tlsLib.connect({ socket: tunnel, servername, ...targetTls(tls) }) }, ctx);
    }
    const { socket, authorization } = await ntlmConnect(proxy, { mode: 'http', host: hostname, port, url }, timeout, tls);
    const viaProxy = { method, path: url, headers: { ...hdrs, ...proxy.headers, Host: u.host, 'Proxy-Authorization': authorization }, createConnection: () => socket };
    return exchange(proxy.url.protocol === 'https:' ? https : http, viaProxy, ctx);
  }

  if (secure) return exchange(https, { ...direct, agent: await httpsProxyAgent(proxy, tls) }, ctx);

  // http target: absolute-form request to the proxy
  const absolute = {
    protocol: proxy.url.protocol,
    hostname: proxy.url.hostname.replace(/^\[|\]$/g, ''),
    port: proxyPort(proxy.url),
    path: url,
    method,
    headers: { ...hdrs, ...(await proxyHeaders(proxy)), Host: u.host },
    rejectUnauthorized: tls.rejectUnauthorized !== false,
    ca: tls.ca || undefined,
  };
  return exchange(proxy.url.protocol === 'https:' ? https : http, absolute, ctx);
}

module.exports = { CookieJar, send, decode, decoder };
