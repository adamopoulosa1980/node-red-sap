# node-red-contrib-sap-odata

[![ci](https://github.com/adamopoulosa1980/node-red-sap/actions/workflows/ci.yml/badge.svg)](https://github.com/adamopoulosa1980/node-red-sap/actions/workflows/ci.yml)

Node-RED nodes for **SAP Gateway OData V2 and V4** (S/4HANA on-premise and Cloud, ECC with Gateway, BTP ABAP environment, SAP BTP destinations).

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed or supported by SAP SE.
> SAP, S/4HANA, SAP HANA, SAP BTP and other SAP product names are trademarks or registered trademarks of SAP SE in Germany
> and other countries; they are used here only to say which systems the nodes work with.

- One `sap-odata` node for everything: **query, read, $count, create, update, delete, function imports, actions (bound and unbound), $batch, $metadata, service catalog** and raw requests (`$value` media, `$links`, …)
- Automatic **X-CSRF-Token** handling bound to the SAP session cookies, with a single refresh on `403 X-CSRF-Token: Required`
- **ETag / If-Match** for update, delete and bound actions (from `msg.etag`, the payload, or by reading the entity first)
- Key and parameter **literals typed from `$metadata`** (`guid'…'`, `datetime'…'`, `12.5M`, `1L`, V4 bare literals, enums …)
- **SAP business messages** (`sap-message`, `sap-messages`, RAP `SAP__Messages`) in `msg.odata.messages`
- Auth: **Basic, OAuth 2.0 (client credentials, password, SAML 2.0 bearer, JWT bearer, refresh tokens), X.509 (PEM or PFX), Kerberos / SPNEGO, SAP BTP destinations (Cloud Connector), Bearer, API Key**
- **HTTP(S) proxies**: manual or `HTTPS_PROXY`/`NO_PROXY`, authentication Basic, **NTLMv2** or **Kerberos**
- **Streaming** upload/download of media resources, gzip/deflate/br, custom CA, editor dropdowns for services and entity sets

## Install

```bash
cd ~/.node-red
npm install /path/to/node-red-sap      # or from npm once published
```

Requires **Node.js ≥ 22** and **Node-RED 4 or 5** (both tested in CI; Node-RED 5 needs Node.js ≥ 22.9). Two optional packages are needed only for the features that use them:

| Feature | Install in the Node-RED user directory |
|---|---|
| Kerberos / SPNEGO (to SAP or to the proxy) | `npm install kerberos` (native; Windows SSPI, GSSAPI elsewhere) |
| SAP BTP destinations / Connectivity (Cloud Connector) | `npm install @sap-cloud-sdk/connectivity` |

## Nodes

### sap-connection (config)

| Field | Meaning |
|---|---|
| Auth | Basic · OAuth 2.0 · X.509 client certificate · Kerberos / SPNEGO · SAP BTP destination · Bearer · API Key (`APIKey` header, api.sap.com sandbox) · None |
| Host URL | `https://host:port` only; service paths go on the `sap-odata` node (not used with a BTP destination) |
| SAP client / Language | sent as `sap-client` / `sap-language` on every request |
| OAuth 2.0 | grant (client credentials, resource owner password, SAML 2.0 bearer assertion RFC 7522, JWT bearer RFC 7523), token URL, client id/secret, client authentication (Basic header, body, or client id only for mTLS), scope, assertion. A `refresh_token` is used when the access token expires |
| X.509 | PEM certificate + key, or PFX/P12 (base64) + passphrase |
| Kerberos | uses the Kerberos credentials of the Node-RED process; SPN defaults to `HTTP/<host>` (Windows) or `HTTP@<host>` |
| BTP destination | destination name, optional user JWT (principal propagation). URL, authentication, `sap-client`, client certificates and the Connectivity proxy with the Cloud Connector location id come from the destination (SAP Cloud SDK) |
| Proxy | none · from environment (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`) · manual URL; *No proxy for* accepts host names (sub domains included), `.suffix`, wildcards, `host:port`, IPv4/IPv6 CIDR. Authentication: none / Basic / NTLM (user `DOMAIN\user` or `user@domain`) / Kerberos |
| CA (PEM), Verify certificate | for self-signed SAP or proxy certificates |

One connection = one SAP session. Session cookies, the CSRF token, the OAuth token, the resolved destination and parsed `$metadata` are shared by all nodes using it.

### sap-odata

**Service**: a V2 name (`API_BUSINESS_PARTNER`, `ZMY_SRV;v=0002` → `/sap/opu/odata/sap/…`) or a full path (`/sap/opu/odata4/sap/<group>/srvd_a2x/sap/<service>/0001`). The OData version is detected from the path (`/odata4/` → V4) or set explicitly.

| Operation | HTTP | Notes |
|---|---|---|
| `query` | `GET /Set` | `$filter $select $expand $orderby $top $skip`, search, inline count, custom options; optional "follow next links" |
| `get` | `GET /Set(key)[/nav]` | |
| `count` | `GET /Set/$count` | only `$filter` and search are sent |
| `create` | `POST /Set` | deep insert = nested JSON in `msg.payload` |
| `update` | V2 `MERGE`, V4 `PATCH` (or `PUT`) | `If-Match` handling; optional MERGE tunnelling via `POST` + `X-HTTP-Method` |
| `delete` | `DELETE /Set(key)` | `If-Match` handling |
| `function` | V2 function import: `GET\|POST /Name?P='x'` · V4 function: `GET /Name(P='x')` · V4 action: `POST /Name` + JSON | HTTP method and parameter types from `$metadata`; bound operations via "Bound to" (`Product('1')`), bound actions sent with `If-Match` |
| `batch` | `POST /$batch` | multipart/mixed (V2 and V4) or OData 4.01 JSON (V4); consecutive writes in one atomic change set (configurable) |
| `metadata` | `GET /$metadata` | parsed model in `msg.payload`, XML in `msg.metadataXml` |
| `catalog` | Gateway V2 + V4 catalog | list of services |
| `request` | any | `msg.method`, `msg.path` (relative to the service or `/sap/…`); `msg.uploadFile` / `msg.downloadFile` stream a file; binary answers as a Buffer |

#### Input (overrides node settings)

`msg.operation`, `msg.service`, `msg.entitySet`, `msg.key` (`"1000"`, `{SalesOrder:"1",SalesOrderItem:"10"}`, or raw `"SalesOrder='1'"`), `msg.navigation`, `msg.query` (`{filter, select, expand, orderby, top, skip, search, count, …custom}`), `msg.payload` (body / function parameters / batch list), `msg.params`, `msg.etag`, `msg.headers`, `msg.fetchAll`, `msg.functionName`, `msg.bindingPath`, `msg.method`, `msg.path`, `msg.uploadFile`, `msg.downloadFile`, `msg.atomic`, `msg.batchFormat`, `msg.odataVersion`, `msg.refresh`.

#### Output

- `msg.payload` – entity, array, number, function result, Buffer, `{file, bytes}` for a download, or for batch `[{status, ok, headers, body, data, messages}]` in request order (a failed change set's error is repeated for each of its requests)
- `msg.odata` – `{operation, version, service, statusCode, count, nextLink, etag, location, url, messages, …}`; `messages` are SAP's business messages (info, warnings) of a successful call

Errors go to a **catch** node; `msg.error` = `{message, statusCode, code, details[], url, method}` taken from the SAP error body (V2 `error.message.value` + `innererror.errordetails`, V4 `error.message` + `details`, or XML).

#### $batch example

```js
msg.payload = [
  { entitySet: "A_BusinessPartner", query: { top: 1 } },                    // GET
  { method: "POST",  entitySet: "A_BusinessPartner", body: { /* … */ } },   // ┐ one
  { method: "MERGE", entitySet: "A_BusinessPartner", key: "11",             // │ change
    body: { /* … */ }, headers: { "If-Match": "*" } },                      // ┘ set
  { method: "GET", url: "A_BusinessPartner('11')/to_BusinessPartnerAddress" }
];
```
A `changeset: "<label>"` property on a request groups requests explicitly; `dependsOn` is passed on in the JSON format.

## Protocol rules implemented

| Rule | Source |
|---|---|
| V2 literals: `'str'` (quotes doubled), `guid'…'`, `datetime'yyyy-mm-ddThh:mm[:ss]'`, `datetimeoffset'…'`, `time'PT…'`, `1L`, `1.5M`, `1.5d`, `1.5f`, `X'…'` | OData 2.0 URI conventions §6 |
| V4 literals: bare Guid / DateTimeOffset / Date / TimeOfDay / numbers, `duration'…'`, `binary'…'`, `Ns.Enum'Member'` | OData 4.0 ABNF |
| V2 partial update = `MERGE`, V4 = `PATCH`; `PUT` = full replace | OData 2.0 / 4.0 protocol |
| V2 `$inlinecount=allpages` + `__count`, `__next`; V4 `$count=true` + `@odata.count`, `@odata.nextLink` | OData 2.0 / 4.0 |
| V2 has no `$search`: `search` is sent as SAP custom query option; V4 uses `$search` | SAP Gateway |
| V2 function import parameters in the query string; V4 function parameters in the path; V4 action parameters as JSON body | OData 2.0 / 4.0 |
| An action bound to an entity with an ETag is sent with `If-Match` | OData 4.01 §11.5.4.1, enforced by SAP RAP |
| `$batch` multipart/mixed, `application/http` parts, `Content-Transfer-Encoding: binary`, `Content-ID` in change sets, GETs never inside change sets; JSON batch with `atomicityGroup` and `dependsOn` | OData 2.0 §2.2.7.6 / 4.0 §11.7 / 4.01 JSON §19 |
| CSRF: `GET` with `X-CSRF-Token: Fetch`, token sent with the same session cookies, refresh once on `403` + `X-CSRF-Token: Required` | SAP Gateway |
| Request target sent verbatim (no re-encoding of `'` to `%27`) | |
| A response to `HEAD` has no body whatever its `Content-Length` (proxy NTLM handshake) | RFC 9110 §9.3.2 |
| V2 `/Date(ms)/` → ISO 8601 (optional) | SAP JSON format |

## Verified against SAP

The live tests run the node in a Node-RED runtime against real systems:

- **`npm run test:trial`** – a local [ABAP Cloud Developer Trial](https://hub.docker.com/r/sapse/abap-cloud-developer-trial) (ABAP Platform 2025), **21 checks, writes included**:
  V2 `GWSAMPLE_BASIC` create, read with typed key and ETag, `$filter` + `$inlinecount`, MERGE with ETag read automatically, a stale ETag rejected (`412`), an expired CSRF token refreshed, a function import (`POST`), errors parsed;
  V2 `API_TRAVEL_U_V2` `$batch` with an atomic change set; V4 `/DMO/TRAVEL_U` create, PATCH with `@odata.etag`, bound action (`If-Match`), multipart `$batch`, delete.
- **`npm run test:live`** – read-only against `sandbox.api.sap.com` (S/4HANA Cloud `API_BUSINESS_PARTNER` V2, `API_PRODUCT` V4), including gzip answers and composite keys.

Found on the way and handled: SAP's **ABAP Gateway does not support the JSON `$batch` format** (`415` on ABAP Platform 2025, any headers) – the node says to use `multipart`; JSON batch remains for other OData V4 servers such as SAP CAP. `GWSAMPLE_BASIC` answers every change set with *"Missing response data in changeset deferred processing mode"* – a limitation of that demo service, not of the request.

Kerberos, NTLM proxies and BTP destinations are covered by the unit tests (NTLMv2 checked cryptographically by the mock proxy, the destination through a mock of the SAP Cloud SDK), not by a live system.

## Tests

```bash
npm test             # unit + Node-RED runtime tests (CI: Node 22, 24 and 26, each with Node-RED 4 and 5; see .github/workflows/ci.yml)
npm run test:ci      # the same, and coverage/lcov.info written in the same run against a mock SAP Gateway and mock proxies, 100 % line/branch/function coverage enforced
npm run test:trial   # live, writes: local ABAP trial (SAP_URL, SAP_USER, SAP_PASSWORD or sap-trial-credentials.txt)
npm run test:live    # live, read-only: sandbox.api.sap.com (SAP_SANDBOX_API_KEY or sap-api-key-sandbox.txt)
npm run coverage:lcov && npm run coverage:report   # what is not covered, with its source line
```

The credential files are git-ignored.

## Sandbox systems

- **SAP Business Accelerator Hub** – <https://api.sap.com> → log in → *Show API Key*. Base URL `https://sandbox.api.sap.com`, service e.g. `/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER`, Auth = API Key. Read-only.
- **ABAP Cloud Developer Trial** – a complete ABAP system in Docker (`sapse/abap-cloud-developer-trial`), with the EPM (`GWSAMPLE_BASIC`, `SEPMRA_*`) and Flight/Travel (`/DMO/`) demo services; its demo license lasts three months (renew with a [minisap](https://go.support.sap.com/minisap/#/minisap) key for system A4H). The Flight/Travel data is regenerated with the class `/DMO/CL_FLIGHT_DATA_GENERATOR` (run it from ADT).
- **SAP BTP ABAP environment (trial / free tier)** – your own RAP services with write access.
- *(The former SAP Gateway demo system ES5 was decommissioned in 2025.)*

## Limitations

- `$batch` answers and non-streamed bodies are held in memory; use `msg.downloadFile` for large media
- Browser-based SAML 2.0 single sign-on (redirect to an IdP login page) cannot work for unattended flows; use the OAuth 2.0 SAML bearer grant, X.509 or Kerberos instead
- NTLM is supported for proxies (SAP's ICM does not offer NTLM)

Example flow: `examples/sandbox-business-partner.json` (Import → Examples in Node-RED).
