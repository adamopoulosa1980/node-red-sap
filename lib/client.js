'use strict';

const { CookieJar, send } = require('./http');
const { parseMetadata } = require('./metadata');
const { resolveProxy } = require('./proxy');
const { negotiateToken } = require('./negotiate');
const optional = require('./optional');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const GRANTS = {
  client_credentials: 'client_credentials',
  password: 'password',
  'saml2-bearer': 'urn:ietf:params:oauth:grant-type:saml2-bearer',
  'jwt-bearer': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
};

class SapError extends Error {
  constructor(message, { statusCode, code, details, body, url, method } = {}) {
    super(message);
    this.name = 'SapError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details || [];
    this.body = body;
    this.url = url;
    this.method = method;
  }

  toJSON() {
    return { message: this.message, statusCode: this.statusCode, code: this.code, details: this.details, url: this.url, method: this.method };
  }
}

/** Extracts a readable message from SAP Gateway V2/V4 JSON or XML error bodies. */
function parseError(statusCode, headers, bodyText) {
  let code;
  let message;
  let details = [];
  let parsed = bodyText;
  const ct = (headers && headers['content-type']) || '';
  if (/json/i.test(ct) || /^\s*\{/.test(bodyText || '')) {
    try {
      parsed = JSON.parse(bodyText);
      const e = parsed.error || parsed;
      code = e.code;
      message = typeof e.message === 'object' ? e.message && e.message.value : e.message;
      const v2Details = e.innererror && e.innererror.errordetails;
      details = (v2Details || e.details || []).map((d) => ({
        code: d.code,
        message: typeof d.message === 'object' ? d.message && d.message.value : d.message,
        severity: d.severity,
        target: d.target || d.propertyref,
      }));
    } catch {
      /* not JSON */
    }
  } else if (/xml/i.test(ct) || /^\s*</.test(bodyText || '')) {
    const c = /<(?:\w+:)?code>([\s\S]*?)<\/(?:\w+:)?code>/.exec(bodyText);
    const m = /<(?:\w+:)?message[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/.exec(bodyText);
    code = c && c[1];
    message = m && m[1];
  }
  if (!message) {
    const text = String(bodyText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    message = text ? text.slice(0, 300) : `HTTP ${statusCode}`;
  }
  return { code, message, details, body: parsed };
}

const SEVERITY = { 1: 'success', 2: 'info', 3: 'warning', 4: 'error' };

/**
 * SAP business messages returned with successful responses:
 *  - V2: header "sap-message" = JSON {code, message, severity, target, details:[...]}
 *  - V4: header "sap-messages" = JSON array [{code, message, numericSeverity, target, ...}]
 */
function parseSapMessages(headers) {
  const out = [];
  const add = (m) =>
    out.push({
      code: m.code,
      message: m.message,
      severity: m.severity || SEVERITY[m.numericSeverity],
      target: m.target,
      longtextUrl: m.longtext_url || m.longtextUrl,
    });
  const v2 = headers && headers['sap-message'];
  const v4 = headers && headers['sap-messages'];
  try {
    if (v2) {
      const m = JSON.parse(v2);
      add(m);
      (m.details || []).forEach(add);
    }
    if (v4) [].concat(JSON.parse(v4)).forEach(add);
  } catch {
    out.push({ message: String(v2 || v4), severity: 'unknown' });
  }
  return out;
}

/** base64url without padding (assertions for RFC 7522 / RFC 7523). */
function base64url(text) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SAP Gateway client: one instance per connection (= one SAP session).
 * Handles authentication, proxies, BTP destinations, sap-client/sap-language,
 * session cookies, X-CSRF-Token fetch/refresh, metadata caching and error normalisation.
 */
class SapClient {
  /**
   * @param {object} cfg
   * @param {string} [cfg.url]            e.g. https://my-sap:44300 (not needed for authType "destination")
   * @param {string} [cfg.client]         sap-client
   * @param {string} [cfg.language]       sap-language
   * @param {'none'|'basic'|'bearer'|'oauth2'|'cert'|'apikey'|'kerberos'|'destination'} [cfg.authType]
   * @param {object} [cfg.credentials]    user, password, token, clientId, clientSecret, assertion, cert, key, pfx, passphrase, ca,
   *                                      proxyUser, proxyPassword, userJwt
   * @param {string} [cfg.tokenUrl]       OAuth2 token endpoint
   * @param {'client_credentials'|'password'|'saml2-bearer'|'jwt-bearer'} [cfg.grantType]
   * @param {'basic'|'body'|'none'} [cfg.clientAuth]  how the OAuth client authenticates (none = mTLS / public client)
   * @param {string} [cfg.scope]
   * @param {string} [cfg.spn]            Kerberos service principal (default HTTP/<host>)
   * @param {string} [cfg.destinationName]
   * @param {number} [cfg.destinationTtl=300000]
   * @param {object} [cfg.proxy]          { url, auth, noProxy, useEnv, domain, workstation, spn }
   * @param {boolean} [cfg.rejectUnauthorized=true]
   * @param {number} [cfg.timeout=60000]
   * @param {number} [cfg.metadataTtl=3600000]
   * @param {object} [cfg.headers]        extra headers for every request
   */
  constructor(cfg) {
    if (!cfg || (!cfg.url && cfg.authType !== 'destination')) throw new Error('SAP connection URL is required');
    if (cfg.authType === 'destination' && !cfg.destinationName) throw new Error('A BTP destination name is required');
    this.cfg = { authType: 'basic', grantType: 'client_credentials', clientAuth: 'basic', timeout: 60000, metadataTtl: 3600000, destinationTtl: 300000, rejectUnauthorized: true, ...cfg };
    this.baseUrl = String(cfg.url || '').replace(/\/+$/, '');
    this.credentials = cfg.credentials || {};
    this.jar = new CookieJar();
    this.csrfToken = null;
    this.csrfPromise = null;
    this.oauth = null; // { token, expires, refreshToken }
    this.destination = null; // { baseUrl, headers, proxy, client, tls, expires }
    this.metadataCache = new Map(); // servicePath -> { promise, expires }
  }

  get tls() {
    const c = this.credentials;
    return {
      rejectUnauthorized: this.cfg.rejectUnauthorized !== false,
      ca: c.ca,
      cert: c.cert,
      key: c.key,
      pfx: c.pfx ? Buffer.from(c.pfx, 'base64') : undefined,
      passphrase: c.passphrase,
    };
  }

  /** Proxy for a URL from the connection settings (proxy credentials live in the credentials). */
  proxyFor(url) {
    const p = this.cfg.proxy;
    if (!p) return null;
    return resolveProxy(url, { ...p, user: this.credentials.proxyUser, password: this.credentials.proxyPassword });
  }

  /** Resolves a BTP destination with the SAP Cloud SDK (cached for destinationTtl). */
  async resolveDestination() {
    if (this.destination && this.destination.expires > Date.now()) return this.destination;
    const sdk = optional.load('@sap-cloud-sdk/connectivity');
    const name = this.cfg.destinationName;
    const dest = await sdk.getDestination({ destinationName: name, jwt: this.credentials.userJwt || undefined, useCache: true });
    if (!dest) throw new Error(`BTP destination "${name}" not found`);
    if (!dest.url) throw new Error(`BTP destination "${name}" has no URL`);
    const headers = {};
    for (const [k, v] of Object.entries(await sdk.buildHeadersForDestination(dest))) {
      if (!/^proxy-authorization$/i.test(k)) headers[k] = v;
    }
    let proxy = null;
    const pc = dest.proxyConfiguration;
    if (pc) {
      proxy = {
        url: new URL(`${pc.protocol || 'http'}://${pc.host}:${pc.port}`),
        auth: 'none',
        headers: { ...(pc.headers || {}) },
      };
      if (dest.cloudConnectorLocationId) proxy.headers['SAP-Connectivity-SCC-Location_ID'] = dest.cloudConnectorLocationId;
    }
    let tls = null;
    if (dest.authentication === 'ClientCertificateAuthentication') {
      const cert = (dest.certificates || []).find((c) => c.name === dest.keyStoreName);
      if (!cert) throw new Error(`BTP destination "${name}": key store "${dest.keyStoreName}" not found`);
      tls = { pfx: Buffer.from(cert.content, 'base64'), passphrase: dest.keyStorePassword };
    }
    this.destination = {
      baseUrl: String(dest.url).replace(/\/+$/, ''),
      headers,
      proxy,
      tls,
      client: dest.sapClient || dest['sap-client'],
      expires: Date.now() + this.cfg.destinationTtl,
    };
    this.baseUrl = this.destination.baseUrl;
    return this.destination;
  }

  absoluteUrl(pathOrUrl, query) {
    let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.baseUrl + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
    const extra = [];
    const client = this.cfg.client || (this.destination && this.destination.client);
    if (query) extra.push(query.replace(/^[?&]+/, ''));
    if (client && !/[?&]sap-client=/.test(url) && !/(^|&)sap-client=/.test(query || '')) extra.push(`sap-client=${encodeURIComponent(client)}`);
    if (this.cfg.language && !/[?&]sap-language=/.test(url) && !/(^|&)sap-language=/.test(query || '')) extra.push(`sap-language=${encodeURIComponent(this.cfg.language)}`);
    const qs = extra.filter(Boolean).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    return url;
  }

  async authHeader(url) {
    const c = this.credentials;
    switch (this.cfg.authType) {
      case 'basic':
        if (!c.user) return undefined;
        return `Basic ${Buffer.from(`${c.user}:${c.password || ''}`).toString('base64')}`;
      case 'bearer':
        return c.token ? `Bearer ${c.token}` : undefined;
      case 'oauth2':
        return `Bearer ${await this.oauthToken()}`;
      case 'kerberos':
        return `Negotiate ${await negotiateToken(new URL(url).hostname, { spn: this.cfg.spn })}`;
      default:
        return undefined; // none / cert / apikey / destination
    }
  }

  /** OAuth 2.0 token (RFC 6749) with refresh_token reuse; grants: client credentials, password, SAML 2.0 bearer (RFC 7522), JWT bearer (RFC 7523). */
  async oauthToken(force = false) {
    if (!force && this.oauth && this.oauth.expires > Date.now()) return this.oauth.token;
    const c = this.credentials;
    if (!this.cfg.tokenUrl) throw new Error('OAuth2 token URL is not configured');
    if (this.oauth && this.oauth.refreshToken) {
      try {
        return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.oauth.refreshToken });
      } catch {
        this.oauth = null; // refresh token expired/revoked -> full grant
      }
    }
    const grant = GRANTS[this.cfg.grantType];
    if (!grant) throw new Error(`Unsupported OAuth2 grant type "${this.cfg.grantType}"`);
    const form = { grant_type: grant };
    if (this.cfg.grantType === 'password') Object.assign(form, { username: c.user || '', password: c.password || '' });
    if (grant.endsWith('bearer')) {
      if (!c.assertion) throw new Error(`OAuth2 ${this.cfg.grantType} grant needs an assertion`);
      const assertion = c.assertion.trim();
      // a raw SAML XML assertion is base64url encoded (RFC 7522 2.1); JWTs and encoded assertions are sent as is
      form.assertion = assertion.startsWith('<') ? base64url(assertion) : assertion;
    }
    return this.tokenRequest(form);
  }

  async tokenRequest(fields) {
    const c = this.credentials;
    const form = new URLSearchParams(fields);
    if (this.cfg.scope) form.set('scope', this.cfg.scope);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.cfg.clientAuth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId || '')}:${encodeURIComponent(c.clientSecret || '')}`).toString('base64')}`;
    } else {
      form.set('client_id', c.clientId || '');
      if (this.cfg.clientAuth === 'body') form.set('client_secret', c.clientSecret || '');
    }
    const url = this.cfg.tokenUrl;
    const res = await send({ method: 'POST', url, headers, body: form.toString(), timeout: this.cfg.timeout, tls: this.tls, proxy: this.proxyFor(url) });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new SapError(`OAuth2 token request failed: HTTP ${res.statusCode} ${text.slice(0, 200)}`, { statusCode: res.statusCode, url, method: 'POST' });
    const json = JSON.parse(text);
    const ttl = (Number(json.expires_in) || 3600) * 1000;
    this.oauth = { token: json.access_token, expires: Date.now() + Math.max(ttl - 60000, ttl / 2), refreshToken: json.refresh_token };
    return this.oauth.token;
  }

  async rawRequest(method, url, headers, body, sink) {
    const u = new URL(url);
    const dest = this.destination;
    const hdrs = { Accept: 'application/json', ...(this.cfg.headers || {}), ...(dest ? dest.headers : {}), ...headers };
    if (this.cfg.authType === 'apikey') {
      // SAP Business Accelerator Hub sandbox (sandbox.api.sap.com) expects the key in the "APIKey" header
      hdrs.APIKey = this.credentials.token;
    } else {
      const auth = await this.authHeader(url);
      if (auth && !hdrs.Authorization) hdrs.Authorization = auth;
    }
    const cookie = this.jar.header(u.pathname);
    if (cookie) hdrs.Cookie = hdrs.Cookie ? `${hdrs.Cookie}; ${cookie}` : cookie;
    const tls = dest && dest.tls ? { ...this.tls, ...dest.tls } : this.tls;
    const proxy = dest && dest.proxy ? dest.proxy : this.proxyFor(url);
    const res = await send({ method, url, headers: hdrs, body, timeout: this.cfg.timeout, tls, proxy, sink });
    this.jar.store(res.headers['set-cookie']);
    return res;
  }

  /** Fetches (once, shared by concurrent callers) a CSRF token for the session. */
  async fetchCsrfToken(servicePath, force = false) {
    if (!force && this.csrfToken) return this.csrfToken;
    if (this.csrfPromise) return this.csrfPromise;
    const target = `${servicePath || '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2'}/`;
    this.csrfPromise = (async () => {
      // SAP Gateway: GET on the service document with "X-CSRF-Token: Fetch"
      const res = await this.rawRequest('GET', this.absoluteUrl(target), { 'X-CSRF-Token': 'Fetch' });
      const token = res.headers['x-csrf-token'];
      if (res.statusCode >= 400) {
        const e = parseError(res.statusCode, res.headers, res.body.toString('utf8'));
        throw new SapError(`CSRF token fetch failed: ${e.message}`, { statusCode: res.statusCode, code: e.code, url: target, method: 'GET' });
      }
      if (!token || /^required$/i.test(token)) throw new SapError('SAP did not return an X-CSRF-Token', { url: target, method: 'GET' });
      this.csrfToken = token;
      return token;
    })();
    try {
      return await this.csrfPromise;
    } finally {
      this.csrfPromise = null;
    }
  }

  /**
   * Performs an OData request.
   * @param {string} method
   * @param {string} pathOrUrl   absolute path (/sap/opu/...) or absolute URL
   * @param {object} [opts]
   * @param {string} [opts.query]        already encoded query string
   * @param {object} [opts.headers]
   * @param {*} [opts.body]              object -> JSON; string/Buffer as is; function returning a Readable for streaming uploads
   * @param {string} [opts.servicePath]  used for CSRF token fetch
   * @param {boolean} [opts.raw]         return body as Buffer/text without JSON parsing
   * @param {import('stream').Writable} [opts.sink] stream a successful response body into this writable
   * @returns {Promise<{statusCode:number, headers:object, body:*, text:string, url:string, messages:Array}>}
   */
  async request(method, pathOrUrl, opts = {}) {
    method = method.toUpperCase();
    if (this.cfg.authType === 'destination') await this.resolveDestination();
    const url = this.absoluteUrl(pathOrUrl, opts.query);
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const needsCsrf = !SAFE_METHODS.has(method);

    let attempt = 0;
    let oauthRetried = false;
    for (;;) {
      if (needsCsrf) headers['X-CSRF-Token'] = await this.fetchCsrfToken(opts.servicePath, attempt > 0);
      const res = await this.rawRequest(method, url, headers, body, opts.sink);
      const csrfHeader = String(res.headers['x-csrf-token'] || '');
      if (needsCsrf && res.statusCode === 403 && /required/i.test(csrfHeader) && attempt === 0) {
        this.csrfToken = null;
        attempt += 1;
        continue;
      }
      if (res.statusCode === 401 && this.cfg.authType === 'oauth2' && !oauthRetried) {
        oauthRetried = true;
        await this.oauthToken(true);
        continue;
      }
      const text = res.body.toString('utf8');
      if (res.statusCode >= 400) {
        const e = parseError(res.statusCode, res.headers, text);
        throw new SapError(e.message, { statusCode: res.statusCode, code: e.code, details: e.details, body: e.body, url, method });
      }
      let parsed = text;
      if (!opts.raw && text && /json/i.test(res.headers['content-type'] || '')) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      }
      return { statusCode: res.statusCode, headers: res.headers, body: opts.raw ? res.body : parsed, text, url, messages: parseSapMessages(res.headers), streamed: res.streamed === true };
    }
  }

  /** Returns (cached) parsed $metadata for a service path. */
  async metadata(servicePath, { force = false } = {}) {
    const cached = this.metadataCache.get(servicePath);
    if (!force && cached && cached.expires > Date.now()) return cached.promise;
    const promise = this.request('GET', `${servicePath}/$metadata`, { headers: { Accept: 'application/xml' }, raw: true }).then((res) => ({
      model: parseMetadata(res.text),
      xml: res.text,
    }));
    this.metadataCache.set(servicePath, { promise, expires: Date.now() + this.cfg.metadataTtl });
    promise.catch(() => this.metadataCache.delete(servicePath));
    return promise;
  }

  /** Lists services from the Gateway V2 catalog and (if available) the V4 catalog. */
  async catalog({ v4 = true } = {}) {
    const services = [];
    const errors = [];
    try {
      const res = await this.request('GET', '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection', { query: '$format=json' });
      const list = (res.body && res.body.d && res.body.d.results) || [];
      for (const s of list) {
        const url = s.ServiceUrl || '';
        let path = url;
        try {
          path = new URL(url).pathname;
        } catch {
          /* relative */
        }
        services.push({
          version: 'v2',
          id: s.ID,
          name: s.TechnicalServiceName,
          serviceVersion: s.TechnicalServiceVersion,
          title: s.Title,
          description: s.Description,
          path: path.replace(/\/+$/, ''),
        });
      }
    } catch (e) {
      errors.push({ catalog: 'v2', message: e.message });
    }
    if (v4) {
      try {
        const res = await this.request('GET', '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups', {
          query: '$expand=DefaultSystem($expand=Services)',
        });
        for (const g of (res.body && res.body.value) || []) {
          for (const s of (g.DefaultSystem && g.DefaultSystem.Services) || []) {
            services.push({
              version: 'v4',
              id: `${g.GroupId}/${s.ServiceId}/${s.ServiceVersion}`,
              name: s.ServiceId,
              serviceVersion: s.ServiceVersion,
              group: g.GroupId,
              description: s.Description,
              path: String(s.ServiceUrl || '').replace(/\?.*$/, '').replace(/\/+$/, ''),
            });
          }
        }
      } catch (e) {
        errors.push({ catalog: 'v4', message: e.message });
      }
    }
    return { services, errors };
  }

  reset() {
    this.jar.clear();
    this.csrfToken = null;
    this.oauth = null;
    this.destination = null;
    this.metadataCache.clear();
  }
}

module.exports = { SapClient, SapError, parseError, parseSapMessages };
