'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { ntlm } = require('httpntlm');
const { negotiateToken } = require('./negotiate');

/**
 * Proxy support.
 *  - https:// targets: CONNECT tunnel (https-proxy-agent; NTLM handshake on one connection here)
 *  - http:// targets:  absolute-form request to the proxy (RFC 9112 3.2.2)
 * Proxy authentication: none, basic, bearer (SAP BTP Connectivity), ntlm (httpntlm), negotiate (kerberos).
 */

function envProxy(protocol, env) {
  const first = (...names) => names.map((n) => env[n]).find(Boolean);
  const url = protocol === 'https:' ? first('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy') : first('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  return url ? { url, noProxy: first('NO_PROXY', 'no_proxy') } : null;
}

function inCidr(host, cidr) {
  const [ip, bits] = cidr.split('/');
  const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  if (net.isIP(host) !== (type === 'ipv6' ? 6 : 4)) return false;
  try {
    const list = new net.BlockList();
    list.addSubnet(ip, Number(bits), type);
    return list.check(host, type);
  } catch {
    return false;
  }
}

/**
 * NO_PROXY matching (curl semantics): "*", host names (also matching sub domains),
 * ".suffix", "*.suffix" / wildcards, optional ":port", IPv4/IPv6 CIDR ranges.
 */
function bypass(hostname, port, noProxy) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  for (const raw of String(noProxy || '').split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    const pattern = (m ? m[1] : entry).replace(/^\[|\]$/g, '');
    if (m && m[2] !== String(port)) continue;
    if (pattern.includes('/')) {
      if (inCidr(host, pattern)) return true;
    } else if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (re.test(host)) return true;
    } else {
      const p = pattern.replace(/^\./, '');
      if (host === p || host.endsWith(`.${p}`)) return true;
    }
  }
  return false;
}

/**
 * Resolves the proxy for a target URL.
 * @param {string} targetUrl
 * @param {object} [cfg] { url, auth, user, password, domain, workstation, spn, token, headers, noProxy, useEnv }
 * @returns {null|{url:URL, auth:string, user:string, password:string, domain?:string, workstation?:string, spn?:string, token?:string, headers:object}}
 */
function resolveProxy(targetUrl, cfg = {}, env = process.env) {
  const target = new URL(targetUrl);
  const chosen = cfg.url ? { url: cfg.url, noProxy: cfg.noProxy } : cfg.useEnv ? envProxy(target.protocol, env) : null;
  if (!chosen) return null;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (bypass(target.hostname, port, chosen.noProxy)) return null;
  const url = new URL(/^[a-z]+:\/\//i.test(chosen.url) ? chosen.url : `http://${chosen.url}`);
  const user = cfg.user || decodeURIComponent(url.username);
  const password = cfg.password || decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return {
    url,
    auth: cfg.auth || (user ? 'basic' : 'none'),
    user,
    password,
    domain: cfg.domain,
    workstation: cfg.workstation,
    spn: cfg.spn,
    token: cfg.token,
    headers: { ...(cfg.headers || {}) },
  };
}

/** Headers sent to the proxy for single-round authentication schemes (+ static proxy headers). */
async function proxyHeaders(proxy) {
  const headers = { ...proxy.headers };
  if (proxy.auth === 'basic') headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${proxy.user}:${proxy.password}`).toString('base64')}`;
  else if (proxy.auth === 'bearer') headers['Proxy-Authorization'] = `Bearer ${proxy.token}`;
  else if (proxy.auth === 'negotiate') headers['Proxy-Authorization'] = `Negotiate ${await negotiateToken(proxy.url.hostname, { spn: proxy.spn })}`;
  return headers;
}

function proxyPort(url) {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

/** TCP or TLS connection to the proxy itself. */
function openSocket(proxy, timeout, tlsOpts) {
  return new Promise((resolve, reject) => {
    const host = proxy.url.hostname.replace(/^\[|\]$/g, '');
    const port = proxyPort(proxy.url);
    const secure = proxy.url.protocol === 'https:';
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: tlsOpts.rejectUnauthorized !== false, ca: tlsOpts.ca || undefined })
      : net.connect({ host, port });
    socket.setTimeout(timeout, () => socket.destroy(new Error(`Proxy ${proxy.url.host} timed out after ${timeout} ms`)));
    socket.once('error', reject);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

/** Buffered reader for HTTP response heads on a raw socket. */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let failure = null;
  // replaced by until(); a no-op until then, so data arriving before the first read is only buffered
  let wake = () => {};
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    wake();
  };
  const onEnd = () => {
    failure = new Error('Proxy closed the connection');
    wake();
  };
  const onError = (e) => {
    failure = e;
    wake();
  };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);
  const until = (probe) =>
    new Promise((resolve, reject) => {
      wake = () => {
        const r = probe();
        if (r !== undefined) resolve(r);
        else if (failure) reject(failure);
      };
      wake();
    });
  return {
    async head() {
      const end = await until(() => {
        const i = buf.indexOf('\r\n\r\n');
        return i < 0 ? undefined : i;
      });
      const [statusLine, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
      buf = buf.subarray(end + 4);
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine);
      const headers = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        headers[k] = headers[k] === undefined ? v : [].concat(headers[k], v);
      }
      return { status: m ? Number(m[1]) : 0, statusText: m ? m[2] : statusLine, headers };
    },
    async skip(n) {
      await until(() => (buf.length >= n ? true : undefined));
      buf = buf.subarray(n);
    },
    release() {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      if (buf.length) socket.unshift(buf);
    },
  };
}

/** "DOMAIN\\user" or "user@domain" -> { username, domain } (an explicit domain wins). */
function splitUser(user, domain) {
  const s = String(user || '');
  const bs = s.indexOf('\\');
  if (bs >= 0) return { username: s.slice(bs + 1), domain: domain || s.slice(0, bs) };
  const at = s.lastIndexOf('@');
  if (at > 0 && !domain) return { username: s.slice(0, at), domain: s.slice(at + 1) };
  return { username: s, domain: domain || '' };
}

function ntlmChallenge(headers) {
  return [].concat(headers['proxy-authenticate'] || []).find((h) => /^NTLM\s+\S/i.test(h));
}

function requestHead(firstLine, hostHeader, extra) {
  const lines = [firstLine, `Host: ${hostHeader}`, 'Proxy-Connection: Keep-Alive', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * NTLM handshake with the proxy on one connection ([MS-NTHT]).
 *  mode "connect": CONNECT host:port -> returns the tunnelled socket
 *  mode "http":    HEAD <absolute url> -> returns { socket, authorization } for the real request
 */
async function ntlmConnect(proxy, { mode, host, port, url }, timeout, tlsOpts) {
  const socket = await openSocket(proxy, timeout, tlsOpts);
  const rd = reader(socket);
  const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
  const firstLine = mode === 'connect' ? `CONNECT ${target} HTTP/1.1` : `HEAD ${url} HTTP/1.1`;
  const creds = { ...splitUser(proxy.user, proxy.domain), password: proxy.password, workstation: proxy.workstation || '' };
  try {
    socket.write(requestHead(firstLine, target, { ...proxy.headers, 'Proxy-Authorization': ntlm.createType1Message(creds) }));
    let res = await rd.head();
    const challenge = res.status === 407 ? ntlmChallenge(res.headers) : undefined;
    if (!challenge) throw new Error(`Proxy did not answer with an NTLM challenge (HTTP ${res.status} ${res.statusText})`);
    // a response to HEAD never has a body, whatever Content-Length says (RFC 9110 9.3.2)
    if (mode === 'connect') await rd.skip(Number(res.headers['content-length']) || 0);
    let authorization;
    try {
      const type2 = ntlm.parseType2Message(challenge, (e) => {
        throw e;
      });
      authorization = ntlm.createType3Message(type2, creds);
    } catch (e) {
      throw new Error(`Invalid NTLM challenge (type 2) from proxy: ${e.message}`);
    }
    if (mode === 'connect') {
      socket.write(requestHead(firstLine, target, { ...proxy.headers, 'Proxy-Authorization': authorization }));
      res = await rd.head();
      if (res.status !== 200) throw new Error(`Proxy CONNECT ${target} failed: HTTP ${res.status} ${res.statusText}`);
    }
    rd.release();
    socket.setTimeout(0); // the request timeout takes over from here
    return mode === 'connect' ? socket : { socket, authorization };
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

let agentModule;
/** https-proxy-agent is ESM-only; load it lazily with import(). */
async function httpsProxyAgent(proxy, tlsOpts) {
  agentModule = agentModule || (await import('https-proxy-agent'));
  return new agentModule.HttpsProxyAgent(proxy.url, {
    headers: await proxyHeaders(proxy),
    rejectUnauthorized: tlsOpts.rejectUnauthorized !== false,
    ca: tlsOpts.ca || undefined,
  });
}

module.exports = { resolveProxy, bypass, proxyHeaders, openSocket, ntlmConnect, httpsProxyAgent, proxyPort, splitUser, reader };
