'use strict';

const optional = require('./optional');

/**
 * Service principal name for HTTP services.
 * Windows SSPI expects "HTTP/host", GSSAPI (Linux, macOS) "HTTP@host".
 */
function spnFor(host, spn, platform = process.platform) {
  return spn || `HTTP${platform === 'win32' ? '/' : '@'}${host}`;
}

/**
 * Creates a SPNEGO (Negotiate) token with the "kerberos" package
 * (https://github.com/mongodb-js/kerberos), using the current Kerberos
 * credentials of the process (Windows logon session or kinit ticket cache).
 * @returns {Promise<string>} base64 token for "Authorization: Negotiate <token>"
 */
async function negotiateToken(host, { spn, challenge } = {}) {
  const kerberos = optional.load('kerberos');
  const service = spnFor(host, spn);
  const client = await kerberos.initializeClient(service, { mechOID: kerberos.GSS_MECH_OID_SPNEGO });
  const token = await client.step(challenge || '');
  if (!token) throw new Error(`Kerberos returned no token for ${service}`);
  return token;
}

module.exports = { negotiateToken, spnFor };
