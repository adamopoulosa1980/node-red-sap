'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { ntlm } = require('httpntlm');
const { TLS } = require('./mock-sap');

/**
 * Forward proxy for tests: CONNECT tunnels and absolute-form requests.
 * auth: none | basic | bearer | negotiate | ntlm
 * NTLM is verified cryptographically ([MS-NLMP] NTLMv2): the proxy recomputes NTProofStr
 * from the password, exactly like a domain controller would.
 */
async function createMockProxy({ secure = false, auth = 'none', user = 'proxyuser', password = 'proxypass', domain = 'CORP', token = 'TOKEN', closeAfter407 = false, badChallenge = false, rejectConnect = false } = {}) {
  const log = [];
  const challenge = crypto.randomBytes(8);

  const type2 = () => ntlmType2(challenge);

  const verifyType3 = (header) => {
    const m = /^NTLM (.+)$/.exec(header || '');
    if (!m) return false;
    const msg = Buffer.from(m[1], 'base64');
    if (msg.readUInt32LE(8) !== 3) return false;
    const field = (off) => msg.subarray(msg.readUInt32LE(off + 4), msg.readUInt32LE(off + 4) + msg.readUInt16LE(off));
    const nt = field(20);
    const dom = field(28).toString('utf16le');
    const usr = field(36).toString('utf16le');
    const ntHash = ntlm.create_NT_hashed_password(password);
    const key = crypto.createHmac('md5', ntHash).update(Buffer.from(usr.toUpperCase() + dom, 'utf16le')).digest();
    const proof = crypto.createHmac('md5', key).update(Buffer.concat([challenge, nt.subarray(16)])).digest();
    return usr === user && dom.toUpperCase() === domain && proof.equals(nt.subarray(0, 16));
  };

  const sockets = new Set();
  const track = (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    return sock;
  };
  const sessions = new WeakMap(); // socket -> 'challenged' | 'ok'

  // returns null when authorised, otherwise the 407 header value
  const check = (headers, socket) => {
    const h = headers['proxy-authorization'];
    switch (auth) {
      case 'basic':
        return h === `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` ? null : 'Basic realm="proxy"';
      case 'bearer':
        return h === `Bearer ${token}` ? null : 'Bearer';
      case 'negotiate':
        return h === `Negotiate ${token}` ? null : 'Negotiate';
      case 'ntlm': {
        if (sessions.get(socket) === 'challenged' && verifyType3(h)) {
          sessions.set(socket, 'ok');
          return null;
        }
        if (/^NTLM /.test(h || '') && Buffer.from(h.slice(5), 'base64').readUInt32LE(8) === 1) {
          sessions.set(socket, 'challenged');
          return badChallenge ? 'NTLM bm90LW50bG0=' : `NTLM ${type2()}`;
        }
        return 'NTLM';
      }
      default:
        return null;
    }
  };

  const deny = (write, value) => {
    const body = 'proxy auth required';
    write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${value}\r\nContent-Length: ${body.length}\r\n${closeAfter407 ? 'Connection: close\r\n' : ''}\r\n${body}`);
  };

  const handler = (req, res) => {
    log.push({ type: 'request', method: req.method, url: req.url, headers: req.headers });
    const challengeValue = check(req.headers, req.socket);
    if (challengeValue) {
      res.writeHead(407, { 'Proxy-Authenticate': challengeValue, 'Content-Length': 19, ...(closeAfter407 ? { Connection: 'close' } : {}) });
      res.end('proxy auth required');
      if (closeAfter407) req.socket.destroy();
      return;
    }
    // absolute-form forwarding
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    log.push({ type: 'forward', url: req.url });
    const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url.slice(target.origin.length), headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  };

  const server = secure ? https.createServer(TLS, handler) : http.createServer(handler);
  server.keepAliveTimeout = 5000;
  server.on('connection', track);
  server.on('secureConnection', track);
  // after a CONNECT node detaches the socket from its HTTP parser, so follow-up CONNECTs (NTLM) are parsed here
  const nextConnect = (clientSocket) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clientSocket.removeListener('data', onData);
      const [line, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
      const headers = {};
      for (const l of lines) {
        const i = l.indexOf(':');
        headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      onConnect({ url: line.split(' ')[1], headers }, clientSocket, buf.subarray(end + 4));
    };
    clientSocket.on('data', onData);
  };

  const onConnect = (req, clientSocket, head) => {
    log.push({ type: 'connect', url: req.url, headers: req.headers });
    if (rejectConnect) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const challengeValue = check(req.headers, clientSocket);
    if (challengeValue) {
      deny((t) => clientSocket.write(t), challengeValue);
      if (closeAfter407) clientSocket.end();
      else nextConnect(clientSocket);
      return;
    }
    const [name, port] = req.url.split(':');
    const host = name === 'localhost' ? '127.0.0.1' : name; // the mock servers listen on IPv4 only
    const upstream = track(net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.once('data', () => log.push({ type: 'tunnel', url: req.url }));
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }));
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  };
  server.on('connect', onConnect);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    log,
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
        for (const sock of sockets) sock.destroy();
      }),
  };
}

/** An NTLM type 2 (challenge) message with target info, base64. */
function ntlmType2(challenge) {
  const targetInfo = Buffer.concat([Buffer.from('02000800', 'hex'), Buffer.from('CORP', 'utf16le'), Buffer.from('00000000', 'hex')]);
  const name = Buffer.from('CORP', 'utf16le');
  const buf = Buffer.alloc(48);
  buf.write('NTLMSSP\0', 0, 'latin1');
  buf.writeUInt32LE(2, 8);
  buf.writeUInt16LE(name.length, 12);
  buf.writeUInt16LE(name.length, 14);
  buf.writeUInt32LE(48, 16);
  buf.writeUInt32LE(0x00888205 | 0x00080000, 20);
  challenge.copy(buf, 24);
  buf.writeUInt16LE(targetInfo.length, 40);
  buf.writeUInt16LE(targetInfo.length, 42);
  buf.writeUInt32LE(48 + name.length, 44);
  return Buffer.concat([buf, name, targetInfo]).toString('base64');
}

module.exports = { createMockProxy, ntlmType2 };
