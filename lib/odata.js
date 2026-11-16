'use strict';

/**
 * OData URL / literal helpers for V2 (SAP Gateway /sap/opu/odata) and
 * V4 (/sap/opu/odata4). Literal syntax follows:
 *  - V2: https://www.odata.org/documentation/odata-version-2-0/overview/ (section 6, primitive types)
 *  - V4: OData ABNF (odata-abnf-construction-rules), primitive literals
 */

const V2_PATH_PREFIX = '/sap/opu/odata/sap/';

function detectVersion(servicePath) {
  return /\/odata4\//i.test(servicePath || '') ? 'v4' : 'v2';
}

/**
 * Normalises the service setting to an absolute path below the host.
 *  "API_BUSINESS_PARTNER"           -> /sap/opu/odata/sap/API_BUSINESS_PARTNER
 *  "ZMY_SRV;v=0002"                 -> /sap/opu/odata/sap/ZMY_SRV;v=0002
 *  "/sap/opu/odata4/sap/x/srvd_a2x/sap/x/0001/" -> unchanged (trailing slash trimmed)
 */
function servicePath(service) {
  if (!service) throw new Error('No OData service configured');
  let s = String(service).trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (!s.startsWith('/')) s = V2_PATH_PREFIX + s;
  return s.replace(/\/+$/, '');
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(String(value));
  if (m) return new Date(parseInt(m[1], 10));
  return new Date(value);
}

function isoNoMillis(d, keepMillis) {
  const iso = d.toISOString();
  return keepMillis ? iso : iso.replace(/\.000Z$/, 'Z');
}

/**
 * Formats a value as an OData URL literal.
 * @param {*} value
 * @param {string} [type] Edm type (e.g. "Edm.String"); inferred from JS type when omitted
 * @param {'v2'|'v4'} version
 */
function formatLiteral(value, type, version = 'v2') {
  if (value === null || value === undefined) return 'null';
  const t = (type || '').replace(/^Edm\./, '');
  const v4 = version === 'v4';

  if (!t) {
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : v4 ? String(value) : `${value}d`;
    if (typeof value === 'boolean') return String(value);
    if (value instanceof Date) return v4 ? isoNoMillis(value, true) : `datetime'${isoNoMillis(value).replace(/Z$/, '')}'`;
    return quote(value);
  }

  switch (t) {
    case 'String':
      return quote(value);
    case 'Guid':
      return v4 ? String(value) : `guid'${value}'`;
    case 'Boolean':
      return String(value === true || value === 'true' || value === 'X');
    case 'Byte':
    case 'SByte':
    case 'Int16':
    case 'Int32':
      return String(value);
    case 'Int64':
      return v4 ? String(value) : `${value}L`;
    case 'Decimal':
      return v4 ? String(value) : `${value}M`;
    case 'Double':
      return v4 ? String(value) : `${value}d`;
    case 'Single':
      return v4 ? String(value) : `${value}f`;
    case 'DateTime': {
      // V2 only. Already-formatted strings without timezone are passed through.
      const s = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value) ? value : isoNoMillis(toDate(value)).replace(/Z$/, '');
      return `datetime'${s}'`;
    }
    case 'DateTimeOffset': {
      let s;
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+([Zz]|[+-]\d{2}:\d{2})$/.test(value)) s = value;
      else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value)) s = `${value}Z`; // no offset given -> UTC, never server local time
      else s = isoNoMillis(toDate(value));
      return v4 ? s : `datetimeoffset'${s}'`;
    }
    case 'Date': // V4
      return typeof value === 'string' ? value.slice(0, 10) : toDate(value).toISOString().slice(0, 10);
    case 'Time': // V2 (Edm.Time as xs:duration, e.g. PT13H20M00S)
      return `time'${value}'`;
    case 'TimeOfDay': // V4
      return String(value);
    case 'Duration':
      return `duration'${value}'`;
    case 'Binary':
      return v4 ? `binary'${value}'` : `X'${value}'`;
    default:
      // Enum types (V4: Namespace.Enum'Member') or unknown -> treat as string
      if (v4 && type && type.includes('.') && !type.startsWith('Edm.')) return `${type}'${value}'`;
      return typeof value === 'number' ? String(value) : quote(value);
  }
}

/**
 * Builds the key predicate, including parentheses.
 *  key = "1000"                          -> ('1000')   (or typed by metadata)
 *  key = 1000                            -> (1000)
 *  key = { BusinessPartner: '1000' }     -> (BusinessPartner='1000')
 *  key = "BusinessPartner='1000'"        -> raw, used as is
 *  key = "('1000')"                      -> raw, used as is
 * @param {*} key
 * @param {Array<{name:string,type:string}>} [keyProps] key properties from metadata
 * @param {'v2'|'v4'} version
 */
function formatKey(key, keyProps, version = 'v2') {
  if (key === undefined || key === null || key === '') throw new Error('Missing entity key');
  if (typeof key === 'string') {
    const s = key.trim();
    if (s.startsWith('(') && s.endsWith(')')) return s;
    if (s.includes('=') || s.includes("'")) return `(${s})`;
  }
  if (typeof key === 'object' && !(key instanceof Date)) {
    const names = Object.keys(key);
    if (names.length === 0) throw new Error('Empty entity key object');
    const typeOf = (n) => (keyProps || []).find((p) => p.name === n)?.type;
    return `(${names.map((n) => `${n}=${formatLiteral(key[n], typeOf(n), version)}`).join(',')})`;
  }
  // scalar
  if (keyProps && keyProps.length > 1) {
    throw new Error(`Entity has a composite key (${keyProps.map((p) => p.name).join(', ')}); provide the key as an object`);
  }
  const type = keyProps && keyProps[0] ? keyProps[0].type : undefined;
  return `(${formatLiteral(key, type, version)})`;
}

const QUERY_OPTIONS = ['filter', 'select', 'expand', 'orderby', 'top', 'skip', 'search', 'apply', 'skiptoken', 'format', 'compute', 'levels'];

/**
 * Builds a query string from an options object. Known OData system options
 * may be given with or without the "$" prefix; everything else is passed as
 * a custom query option (e.g. "sap-client", "search" in V2 SAP services).
 */
function buildQuery(options = {}, version = 'v2') {
  const parts = [];
  for (const [rawKey, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue;
    const bare = rawKey.replace(/^\$/, '');
    if (bare === 'count' || bare === 'inlinecount') {
      if (value === false || value === 'false') continue;
      if (version === 'v4') parts.push(`$count=true`);
      else parts.push(`$inlinecount=${value === true || value === 'true' ? 'allpages' : encodeURIComponent(value)}`);
      continue;
    }
    let key = QUERY_OPTIONS.includes(bare.toLowerCase()) ? `$${bare.toLowerCase()}` : rawKey;
    // OData V2 has no $search; SAP Gateway V2 services use the custom query option "search"
    if (key === '$search' && version !== 'v4' && !rawKey.startsWith('$')) key = 'search';
    const val = Array.isArray(value) ? value.join(',') : String(value);
    parts.push(`${encodeKey(key)}=${encodeValue(val)}`);
  }
  return parts.join('&');
}

function encodeKey(k) {
  return encodeURIComponent(k).replace(/%24/g, '$');
}

function encodeValue(v) {
  // keep OData-friendly characters readable; encodeURIComponent already leaves ' ( ) * ! untouched
  return encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%24/g, '$');
}

/** Builds "/EntitySet(key)/Navigation" relative to the service root. */
function resourcePath({ entitySet, key, navigation, keyProps, version }) {
  if (!entitySet) throw new Error('No entity set configured');
  let p = `/${String(entitySet).replace(/^\/+/, '')}`;
  if (key !== undefined && key !== null && key !== '') p += formatKey(key, keyProps, version);
  if (navigation) p += `/${String(navigation).replace(/^\/+/, '')}`;
  return p;
}

/**
 * Builds the request for a function import / action.
 *  V2 function import: GET|POST /Name?Param='x'   (parameters always in the query string)
 *  V4 function:        GET /Name(Param='x')       (parameters in the path)
 *  V4 action:          POST /Name                 (parameters as JSON body)
 * @returns {{method:string, path:string, query:string, body:(object|undefined)}}
 */
function operationRequest({ name, params = {}, version, definition, httpMethod, bindingPath }) {
  if (!name) throw new Error('No function/action name configured');
  const paramType = (n) => definition?.parameters?.find((p) => p.name === n)?.type;
  const prefix = bindingPath ? `/${bindingPath.replace(/^\/+/, '')}` : '';
  if (version === 'v4') {
    const isAction = definition ? definition.kind === 'action' : (httpMethod || '').toUpperCase() === 'POST';
    if (isAction) {
      return { method: 'POST', path: `${prefix}/${name}`, query: '', body: params };
    }
    const args = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeValue(formatLiteral(v, paramType(k), 'v4'))}`)
      .join(',');
    return { method: 'GET', path: `${prefix}/${name}(${args})`, query: '', body: undefined };
  }
  const method = (httpMethod || definition?.httpMethod || 'GET').toUpperCase();
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeKey(k)}=${encodeValue(formatLiteral(v, paramType(k), 'v2'))}`)
    .join('&');
  return { method, path: `${prefix}/${name}`, query, body: undefined };
}

const V2_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** Recursively converts V2 "/Date(ms)/" values to ISO strings. */
function convertV2Dates(value) {
  if (typeof value === 'string') {
    const m = V2_DATE_RE.exec(value);
    return m ? new Date(parseInt(m[1], 10)).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map(convertV2Dates);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertV2Dates(v);
    return out;
  }
  return value;
}

/** Removes V2 __metadata / __deferred and V4 @odata.* control information. */
function stripMetadata(value) {
  if (Array.isArray(value)) return value.map(stripMetadata);
  if (value && typeof value === 'object') {
    if (value.__deferred && Object.keys(value).length === 1) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__metadata' || k.startsWith('@odata.') || k.includes('@odata.')) continue;
      const s = stripMetadata(v);
      if (s !== undefined) out[k] = s;
    }
    // V2 expanded collections: { results: [...] } -> [...]
    if (Object.keys(out).length === 1 && Array.isArray(out.results)) return out.results;
    return out;
  }
  return value;
}

/**
 * Normalises an OData JSON response body.
 * @returns {{data:*, count:(number|undefined), nextLink:(string|undefined), deltaLink:(string|undefined), etag:(string|undefined), isCollection:boolean}}
 */
function normalize(body, version) {
  if (body === undefined || body === null || body === '') return { data: null, isCollection: false };
  if (typeof body !== 'object') return { data: body, isCollection: false };
  if (version === 'v4') {
    if (Array.isArray(body.value) && ('@odata.context' in body || Object.keys(body).every((k) => k === 'value' || k.startsWith('@')))) {
      return {
        data: body.value,
        count: body['@odata.count'] !== undefined ? Number(body['@odata.count']) : undefined,
        nextLink: body['@odata.nextLink'],
        deltaLink: body['@odata.deltaLink'],
        isCollection: true,
      };
    }
    if ('value' in body && Object.keys(body).every((k) => k === 'value' || k.startsWith('@'))) {
      return { data: body.value, isCollection: false }; // primitive / complex return value
    }
    return { data: body, etag: body['@odata.etag'], isCollection: false };
  }
  const d = body.d !== undefined ? body.d : body;
  if (d && Array.isArray(d.results)) {
    return {
      data: d.results,
      count: d.__count !== undefined ? Number(d.__count) : undefined,
      nextLink: d.__next,
      deltaLink: d.__delta,
      isCollection: true,
    };
  }
  if (Array.isArray(d)) return { data: d, isCollection: true };
  return { data: d, etag: d && d.__metadata ? d.__metadata.etag : undefined, isCollection: false };
}

module.exports = {
  V2_PATH_PREFIX,
  detectVersion,
  servicePath,
  formatLiteral,
  formatKey,
  buildQuery,
  encodeValue,
  resourcePath,
  operationRequest,
  convertV2Dates,
  stripMetadata,
  normalize,
};
