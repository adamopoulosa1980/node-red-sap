'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { ntlmConnect, resolveProxy, splitUser, httpsProxyAgent } = require('../lib/proxy');
const { send } = require('../lib/http');
const { ntlmType2 } = require('./helpers/mock-proxy');

/**
 * A raw TCP "proxy" that plays a script: for each request head it receives, it runs the next step,
 * which writes chunks (with pauses), resets the socket or ends it. Lets the tests produce the
 * awkward answers a real proxy may give: split heads, repeated headers, a body after the head,
 * bytes after a 200, a bad status line, a reset.
 */
async function scripted(steps, greeting) {
  const heads = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    if (greeting) socket.write(greeting);
    let buf = Buffer.alloc(0);
    let step = 0;
    socket.on('data', async (d) => {
      buf = Buffer.concat([buf, d]);
      let end;
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
        heads.push(buf.subarray(0, end).toString('latin1'));
        buf = buf.subarray(end + 4);
        const action = steps[step++];
        if (!action) return;
        for (const part of [].concat(action)) {
          if (part === 'reset') return socket.resetAndDestroy();
          if (part === 'end') return socket.end();
          if (typeof part === 'number') await new Promise((r) => setTimeout(r, part));
          else socket.write(part);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    heads,
    proxy: (extra = {}) => resolveProxy('https://sap.example', { url: `http://127.0.0.1:${server.address().port}`, auth: 'ntlm', user: 'CORP\\u', password: 'p', ...extra }),
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(r);
      }),
  };
}

const challenge = () => `NTLM ${ntlmType2(crypto.randomBytes(8))}`;

test('NTLM handshake: head split in chunks, repeated Proxy-Authenticate, header without colon, body after a pause, bytes after 200', async () => {
  const p = await scripted([
    ['HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\n', 20, `Proxy-Authenticate: ${challenge()}\r\nX-Junk\r\nContent-Length: 4\r\n\r\n`, 20, 'BO', 20, 'DY'],
    // one write, so the bytes after the 200 arrive with it on every platform and must be given back to the socket
    ['HTTP/1.1 200 Connection Established\r\n\r\nLEFTOVER'],
  ]);
  try {
    const socket = await ntlmConnect(p.proxy(), { mode: 'connect', host: 'sap.example', port: 443 }, 2000, {});
    const first = await new Promise((r) => socket.once('data', r));
    assert.equal(first.toString(), 'LEFTOVER', 'bytes after the 200 are handed to the tunnel');
    socket.destroy();
    assert.match(p.heads[0], /^CONNECT sap\.example:443 HTTP\/1\.1\r\nHost: sap\.example:443\r\nProxy-Connection: Keep-Alive\r\nProxy-Authorization: NTLM /);
    assert.match(p.heads[1], /Proxy-Authorization: NTLM /);
  } finally {
    await p.close();
  }
});

test('NTLM handshake: IPv6 target, 407 without Content-Length, HTTP mode never reads a HEAD body', async () => {
  const p = await scripted([[`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${challenge()}\r\n\r\n`], ['HTTP/1.1 200 OK\r\n\r\n']]);
  try {
    const s = await ntlmConnect(p.proxy(), { mode: 'connect', host: '::1', port: 8443 }, 2000, {});
    s.destroy();
    assert.match(p.heads[0], /^CONNECT \[::1\]:8443 HTTP\/1\.1/);
  } finally {
    await p.close();
  }
  const q = await scripted([[`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${challenge()}\r\nContent-Length: 50\r\n\r\n`]]);
  try {
    const r = await ntlmConnect(q.proxy(), { mode: 'http', host: 'sap.example', port: 80, url: 'http://sap.example/x' }, 2000, {});
    assert.match(r.authorization, /^NTLM /);
    r.socket.destroy();
  } finally {
    await q.close();
  }
});

test('NTLM handshake failures: bad status line, no Proxy-Authenticate, reset, closed connection', async () => {
  let p = await scripted(['GARBAGE\r\n\r\n']);
  await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /did not answer with an NTLM challenge \(HTTP 0 GARBAGE\)/);
  await p.close();

  p = await scripted(['HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n']);
  await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /did not answer with an NTLM challenge \(HTTP 407/);
  await p.close();

  p = await scripted([['HTTP/1.1 407 Proxy', 'reset']]);
  await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /ECONNRESET|closed the connection/);
  await p.close();

  p = await scripted([['end']]);
  await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /Proxy closed the connection/);
  await p.close();

  p = await scripted([[`HTTP/1.1 407 x\r\nProxy-Authenticate: ${challenge()}\r\nContent-Length: 10\r\n\r\nshort`, 'end']]);
  await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /Proxy closed the connection/);
  await p.close();
});

test('splitUser: DOMAIN\\user, user@domain, explicit domain, empty', () => {
  assert.deepEqual(splitUser('CORP\\anna'), { username: 'anna', domain: 'CORP' });
  assert.deepEqual(splitUser('CORP\\anna', 'OTHER'), { username: 'anna', domain: 'OTHER' });
  assert.deepEqual(splitUser('anna@corp.example'), { username: 'anna', domain: 'corp.example' });
  assert.deepEqual(splitUser('anna@corp.example', 'CORP'), { username: 'anna@corp.example', domain: 'CORP' });
  assert.deepEqual(splitUser('@nodomain'), { username: '@nodomain', domain: '' });
  assert.deepEqual(splitUser('anna'), { username: 'anna', domain: '' });
  assert.deepEqual(splitUser(undefined), { username: '', domain: '' });
});

test('httpsProxyAgent passes the CA and certificate check to the proxy connection', async () => {
  const agent = await httpsProxyAgent(resolveProxy('https://x', { url: 'https://proxy:3129' }), { ca: 'CA-PEM', rejectUnauthorized: false });
  assert.equal(agent.connectOpts.ca, 'CA-PEM');
  assert.equal(agent.connectOpts.rejectUnauthorized, false);
  const plain = await httpsProxyAgent(resolveProxy('https://x', { url: 'http://proxy:3128' }), {});
  assert.equal(plain.connectOpts.ca, undefined);
  assert.equal(plain.connectOpts.rejectUnauthorized, true);
});

test('default ports when the target URL has none (80 for http, 443 for https)', async () => {
  const p = await scripted([[`HTTP/1.1 407 x\r\nProxy-Authenticate: ${challenge()}\r\n\r\n`], ['HTTP/1.1 403 Forbidden\r\n\r\n']]);
  try {
    await assert.rejects(send({ method: 'GET', url: 'https://sap.example/x', proxy: p.proxy(), timeout: 2000 }), /Proxy CONNECT sap\.example:443 failed: HTTP 403/);
  } finally {
    await p.close();
  }
  const q = await scripted([[`HTTP/1.1 407 x\r\nProxy-Authenticate: ${challenge()}\r\n\r\n`], ['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok']]);
  try {
    const r = await send({ method: 'GET', url: 'http://sap.example/x', proxy: q.proxy(), timeout: 2000 });
    assert.equal(r.body.toString(), 'ok');
    assert.match(q.heads[0], /^HEAD http:\/\/sap\.example\/x HTTP\/1\.1\r\nHost: sap\.example:80/);
  } finally {
    await q.close();
  }
});

test('NTLM: a well-formed message of the wrong type is refused (httpntlm reports it through its callback)', async () => {
  const wrongType = Buffer.alloc(48);
  wrongType.write('NTLMSSP', 0, 'latin1');
  wrongType.writeUInt32LE(3, 8);
  const p = await scripted([[`HTTP/1.1 407 x\r\nProxy-Authenticate: NTLM ${wrongType.toString('base64')}\r\nContent-Length: 0\r\n\r\n`]]);
  try {
    await assert.rejects(ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {}), /Invalid NTLM challenge \(type 2\) from proxy: Server didn't return a type 2 message/);
  } finally {
    await p.close();
  }
});

test('NTLM: a proxy that answers before reading the request', async () => {
  const p = await scripted([[], ['HTTP/1.1 200 OK\r\n\r\n']], `HTTP/1.1 407 x\r\nProxy-Authenticate: ${challenge()}\r\nContent-Length: 0\r\n\r\n`);
  try {
    const s = await ntlmConnect(p.proxy(), { mode: 'connect', host: 'h', port: 443 }, 2000, {});
    s.destroy();
    assert.equal(p.heads.length, 2);
  } finally {
    await p.close();
  }
});
