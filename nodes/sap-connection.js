'use strict';

const { SapClient } = require('../lib/client');
const { servicePath } = require('../lib/odata');
const { summarize } = require('../lib/metadata');

module.exports = function (RED) {
  function SapConnectionNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.client = new SapClient({
      url: config.url,
      client: config.client,
      language: config.language,
      authType: config.authType || 'basic',
      tokenUrl: config.tokenUrl,
      grantType: config.grantType || 'client_credentials',
      clientAuth: config.clientAuth || 'basic',
      scope: config.scope,
      spn: config.spn || undefined,
      destinationName: config.destinationName,
      proxy:
        config.proxyMode === 'manual'
          ? { url: config.proxyUrl, auth: config.proxyAuth || 'none', noProxy: config.noProxy, domain: config.proxyDomain, workstation: config.proxyWorkstation, spn: config.proxySpn || undefined }
          : config.proxyMode === 'env'
            ? { useEnv: true, auth: config.proxyAuth || undefined, domain: config.proxyDomain, workstation: config.proxyWorkstation, spn: config.proxySpn || undefined }
            : undefined,
      rejectUnauthorized: config.rejectUnauthorized !== false,
      timeout: Number(config.timeout) || 60000,
      metadataTtl: (Number(config.metadataTtl) || 3600) * 1000,
      credentials: this.credentials, // SapClient falls back to {}
    });
    this.on('close', () => this.client.reset());
  }

  RED.nodes.registerType('sap-connection', SapConnectionNode, {
    credentials: {
      user: { type: 'text' },
      password: { type: 'password' },
      token: { type: 'password' },
      clientId: { type: 'text' },
      clientSecret: { type: 'password' },
      assertion: { type: 'password' },
      cert: { type: 'text' },
      key: { type: 'password' },
      pfx: { type: 'password' },
      passphrase: { type: 'password' },
      ca: { type: 'text' },
      proxyUser: { type: 'text' },
      proxyPassword: { type: 'password' },
      userJwt: { type: 'password' },
    },
  });

  // ---- editor helpers (work for deployed connections) ----
  const permission = RED.auth.needsPermission('sap-connection.read');

  const withConnection = (handler) => async (req, res) => {
    const conn = RED.nodes.getNode(req.params.id);
    if (!conn || !conn.client) {
      res.status(404).json({ error: 'Connection not found - deploy the sap-connection first' });
      return;
    }
    try {
      res.json(await handler(conn.client, req));
    } catch (e) {
      res.status(502).json({ error: e.message, statusCode: e.statusCode });
    }
  };

  RED.httpAdmin.get(
    '/sap-connection/:id/services',
    permission,
    withConnection((client) => client.catalog())
  );

  RED.httpAdmin.get(
    '/sap-connection/:id/metadata',
    permission,
    withConnection(async (client, req) => summarize((await client.metadata(servicePath(req.query.service), { force: req.query.refresh === 'true' })).model))
  );
};
