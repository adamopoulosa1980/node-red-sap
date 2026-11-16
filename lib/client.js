'use strict';

const { CookieJar, send } = require('./http');
const { parseMetadata } = require('./metadata');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/**
 * SAP Gateway client: one instance per connection (= one SAP session).
 * Handles authentication, sap-client/sap-language, session cookies,
 * X-CSRF-Token fetch/refresh, metadata caching and error normalisation.
 */
class SapClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.url              e.g. https://my-sap:44300
   * @param {string} [cfg.client]         sap-client
   * @param {string} [cfg.language]       sap-language
   * @param {'none'|'basic'|'bearer'|'oauth2'|'cert'|'apikey'} [cfg.authType]
   * @param {object} [cfg.credentials]    user, password, token, clientId, clientSecret, cert, key, ca, passphrase
   * @param {string} [cfg.tokenUrl]       OAuth2 token endpoint (client credentials grant)
   * @param {string} [cfg.scope]
   * @param {boolean} [cfg.rejectUnauthorized=true]
   * @param {number} [cfg.timeout=60000]
   * @param {number} [cfg.metadataTtl=3600000]
   * @param {object} [cfg.headers]        extra headers for every request
   */
  constructor(cfg) {
    if (!cfg || !cfg.url) throw new Error('SAP connection URL is required');
    this.cfg = { authType: 'basic', timeout: 60000, metadataTtl: 3600000, rejectUnauthorized: true, ...cfg };
    this.baseUrl = String(cfg.url).replace(/\/+$/, '');
    this.credentials = cfg.credentials || {};
    this.jar = new CookieJar();
    this.csrfToken = null;
    this.csrfPromise = null;
    this.oauth = null; // { token, expires }
    this.metadataCache = new Map(); // servicePath -> { promise, expires }
  }

  get tls() {
    const c = this.credentials;
    return { rejectUnauthorized: this.cfg.rejectUnauthorized !== false, ca: c.ca, cert: c.cert, key: c.key, passphrase: c.passphrase };
  }

  absoluteUrl(pathOrUrl, query) {
    let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.baseUrl + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
    const extra = [];
    if (query) extra.push(query.replace(/^[?&]+/, ''));
    if (this.cfg.client && !/[?&]sap-client=/.test(url) && !/(^|&)sap-client=/.test(query || '')) extra.push(`sap-client=${encodeURIComponent(this.cfg.client)}`);
    if (this.cfg.language && !/[?&]sap-language=/.test(url) && !/(^|&)sap-language=/.test(query || '')) extra.push(`sap-language=${encodeURIComponent(this.cfg.language)}`);
    const qs = extra.filter(Boolean).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    return url;
  }

  async authHeader() {
    const c = this.credentials;
    switch (this.cfg.authType) {
      case 'basic':
        if (!c.user) return undefined;
        return `Basic ${Buffer.from(`${c.user}:${c.password || ''}`).toString('base64')}`;
      case 'bearer':
        return c.token ? `Bearer ${c.token}` : undefined;
      case 'oauth2':
        return `Bearer ${await this.oauthToken()}`;
      default:
        return undefined; // none / cert
    }
  }

  async oauthToken(force = false) {
    if (!force && this.oauth && this.oauth.expires > Date.now()) return this.oauth.token;
    const c = this.credentials;
    if (!this.cfg.tokenUrl) throw new Error('OAuth2 token URL is not configured');
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.cfg.scope) form.set('scope', this.cfg.scope);
    const res = await send({
      method: 'POST',
      url: this.cfg.tokenUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.clientId || ''}:${c.clientSecret || ''}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      timeout: this.cfg.timeout,
      tls: this.tls,
    });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new SapError(`OAuth2 token request failed: HTTP ${res.statusCode} ${text.slice(0, 200)}`, { statusCode: res.statusCode, url: this.cfg.tokenUrl, method: 'POST' });
    const json = JSON.parse(text);
    const ttl = (Number(json.expires_in) || 3600) * 1000;
    this.oauth = { token: json.access_token, expires: Date.now() + Math.max(ttl - 60000, ttl / 2) };
    return this.oauth.token;
  }

  async rawRequest(method, url, headers, body) {
    const u = new URL(url);
    const hdrs = { Accept: 'application/json', ...(this.cfg.headers || {}), ...headers };
    if (this.cfg.authType === 'apikey') {
      // SAP Business Accelerator Hub sandbox (sandbox.api.sap.com) expects the key in the "APIKey" header
      hdrs.APIKey = this.credentials.token;
    } else {
      const auth = await this.authHeader();
      if (auth && !hdrs.Authorization) hdrs.Authorization = auth;
    }
    const cookie = this.jar.header(u.pathname);
    if (cookie) hdrs.Cookie = hdrs.Cookie ? `${hdrs.Cookie}; ${cookie}` : cookie;
    const res = await send({ method, url, headers: hdrs, body, timeout: this.cfg.timeout, tls: this.tls });
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
   * @param {*} [opts.body]              object -> JSON, string/Buffer as is
   * @param {string} [opts.servicePath]  used for CSRF token fetch
   * @param {boolean} [opts.raw]         return body as Buffer/text without JSON parsing
   * @returns {Promise<{statusCode:number, headers:object, body:*, text:string, url:string}>}
   */
  async request(method, pathOrUrl, opts = {}) {
    method = method.toUpperCase();
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
      const res = await this.rawRequest(method, url, headers, body);
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
      return { statusCode: res.statusCode, headers: res.headers, body: opts.raw ? res.body : parsed, text, url };
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
    this.metadataCache.clear();
  }
}

module.exports = { SapClient, SapError, parseError };
