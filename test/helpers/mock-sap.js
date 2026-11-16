'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fixtures = path.join(__dirname, '..', 'fixtures');
const TLS = {
  key: fs.readFileSync(path.join(fixtures, 'server.key')),
  cert: fs.readFileSync(path.join(fixtures, 'server.crt')),
};

/**
 * Mock SAP Gateway reproducing the behaviour relevant for clients:
 *  - "X-CSRF-Token: Fetch" on GET returns a token bound to a session cookie
 *    (SAP_SESSIONID_<SID>_<client>) plus sap-usercontext.
 *  - Modifying requests without a valid token+cookie pair get
 *    403 with "X-CSRF-Token: Required" (SAP Gateway behaviour).
 *  - Routes are registered per test: mock.on(method, matcher, handler).
 */
async function createMockSap({ secure = false, csrf = true } = {}) {
  const sessions = new Map(); // sessionId -> token
  const requests = [];
  const routes = [];

  const mock = {
    requests,
    sessions,
    csrf,
    on(method, matcher, handler) {
      routes.unshift({ method, matcher, handler });
      return mock;
    },
    reset() {
      requests.length = 0;
      routes.length = 0;
      sessions.clear();
    },
    expireTokens() {
      for (const k of sessions.keys()) sessions.set(k, `expired-${k}`);
    },
    last() {
      return requests[requests.length - 1];
    },
  };

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://x');
      const record = { method: req.method, url: req.url, path: u.pathname, query: u.searchParams, headers: req.headers, body };
      requests.push(record);

      const cookies = Object.fromEntries(
        String(req.headers.cookie || '')
          .split(';')
          .map((c) => c.trim().split('='))
          .filter((p) => p[0])
      );
      let session = cookies.SAP_SESSIONID_ABC_100;
      const setCookie = [];
      if (!session) {
        session = crypto.randomUUID();
        setCookie.push(`SAP_SESSIONID_ABC_100=${session}; path=/; HttpOnly`, 'sap-usercontext=sap-client=100; path=/');
      }
      if (setCookie.length) res.setHeader('set-cookie', setCookie);

      const tokenHeader = req.headers['x-csrf-token'];
      if (mock.csrf && /^fetch$/i.test(tokenHeader || '') && req.method === 'GET') {
        const token = crypto.randomBytes(8).toString('hex');
        sessions.set(session, token);
        res.setHeader('x-csrf-token', token);
      } else if (mock.csrf && !['GET', 'HEAD'].includes(req.method)) {
        if (!tokenHeader || sessions.get(session) !== tokenHeader) {
          res.writeHead(403, { 'x-csrf-token': 'Required', 'content-type': 'text/plain' });
          res.end('CSRF token validation failed');
          return;
        }
      }

      const route = routes.find(
        (r) => (r.method === '*' || r.method === req.method) && (typeof r.matcher === 'string' ? r.matcher === u.pathname : r.matcher.test(req.url))
      );
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: { lang: 'en', value: `No mock route for ${req.method} ${req.url}` } } }));
        return;
      }
      route.handler(record, res);
    });
  };

  const server = secure ? https.createServer(TLS, handler) : http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  mock.server = server;
  mock.url = `${secure ? 'https' : 'http'}://127.0.0.1:${port}`;
  mock.close = () => new Promise((r) => server.close(r));
  return mock;
}

/** Sends a JSON response. */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain', ...headers });
  res.end(body);
}

module.exports = { createMockSap, json, text, TLS };
