'use strict';

/**
 * Loader for optional peer dependencies (kerberos, @sap-cloud-sdk/connectivity).
 * They are only needed for specific authentication modes, so they are not
 * installed by default.
 */

const PURPOSE = {
  kerberos: 'Kerberos / SPNEGO (Negotiate) authentication',
  '@sap-cloud-sdk/connectivity': 'SAP BTP destinations',
};

const overrides = new Map();

function load(name) {
  if (overrides.has(name)) return overrides.get(name);
  try {
    return require(name);
  } catch (e) {
    // only "this package is missing", not a missing dependency of it (whose require stack also names the package)
    if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).split('\n')[0].includes(`'${name}'`)) throw e;
    throw new Error(`${PURPOSE[name] || name} needs the optional package "${name}". Install it in your Node-RED user directory: npm install ${name}`);
  }
}

/** Replaces a module (tests) - pass undefined to restore normal loading. */
function set(name, mod) {
  if (mod === undefined) overrides.delete(name);
  else overrides.set(name, mod);
}

module.exports = { load, set };
