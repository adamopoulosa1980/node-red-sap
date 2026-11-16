# node-red-contrib-sap-odata

Node-RED nodes for **SAP Gateway OData V2 and V4** (S/4HANA on-premise and Cloud, ECC with Gateway, BTP ABAP environment).

- One `sap-odata` node for everything: **query, read, $count, create, update, delete, function imports / actions, $batch, $metadata, service catalog** and raw requests (`$value`, `$links`, …)
- Automatic **X-CSRF-Token** handling bound to the SAP session cookies, with a single refresh on `403 X-CSRF-Token: Required`
- **ETag / If-Match** for update and delete (from `msg.etag`, the payload, or by reading the entity first)
- Key and parameter **literals typed from `$metadata`** (`guid'…'`, `datetime'…'`, `12.5M`, `1L`, V4 bare literals, enums …)
- Auth: **Basic, OAuth2 client credentials, Bearer, API Key (api.sap.com sandbox), X.509 client certificate**
- `sap-client` / `sap-language`, gzip/deflate/br responses, custom CA, editor dropdowns for services (Gateway catalog) and entity sets (`$metadata`)

## Install

```bash
cd ~/.node-red
npm install /path/to/node-red-sap      # or from npm once published
```

Requires Node.js ≥ 18 and Node-RED ≥ 3.

## Nodes

### sap-connection (config)

| Field | Meaning |
|---|---|
| Host URL | `https://host:port` only; service paths go on the `sap-odata` node |
| SAP client / Language | sent as `sap-client` / `sap-language` on every request |
| Auth | Basic · OAuth2 client credentials (token URL, client id/secret, scope) · Bearer · API Key (`APIKey` header) · X.509 (PEM cert/key) · None |
| CA (PEM), Verify certificate | for self-signed SAP certificates |

One connection = one SAP session. Session cookies, the CSRF token, the OAuth token and parsed `$metadata` are shared by all nodes using it.

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
| `function` | V2 function import: `GET\|POST /Name?P='x'` · V4 function: `GET /Name(P='x')` · V4 action: `POST /Name` + JSON | HTTP method and parameter types from `$metadata`; bound operations via "Bound to" (`Product('1')`) |
| `batch` | `POST /$batch` (multipart/mixed) | consecutive writes in one atomic change set (configurable) |
| `metadata` | `GET /$metadata` | parsed model in `msg.payload`, XML in `msg.metadataXml` |
| `catalog` | Gateway V2 + V4 catalog | list of services |
| `request` | any | `msg.method`, `msg.path` (relative to the service or `/sap/…`) |

#### Input (overrides node settings)

`msg.operation`, `msg.service`, `msg.entitySet`, `msg.key` (`"1000"`, `{SalesOrder:"1",SalesOrderItem:"10"}`, or raw `"SalesOrder='1'"`), `msg.navigation`, `msg.query` (`{filter, select, expand, orderby, top, skip, search, count, …custom}`), `msg.payload` (body / function parameters / batch list), `msg.params`, `msg.etag`, `msg.headers`, `msg.fetchAll`, `msg.functionName`, `msg.bindingPath`, `msg.method`, `msg.path`, `msg.atomic`, `msg.odataVersion`, `msg.refresh`.

#### Output

- `msg.payload` – entity, array, number, function result, or for batch `[{status, ok, headers, body, data}]` in request order (a failed change set's error is repeated for each of its requests)
- `msg.odata` – `{operation, version, service, statusCode, count, nextLink, etag, location, url, …}`

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
A `changeset: "<label>"` property on a request groups requests explicitly.

## Protocol rules implemented

| Rule | Source |
|---|---|
| V2 literals: `'str'` (quotes doubled), `guid'…'`, `datetime'yyyy-mm-ddThh:mm[:ss]'`, `datetimeoffset'…'`, `time'PT…'`, `1L`, `1.5M`, `1.5d`, `1.5f`, `X'…'` | OData 2.0 URI conventions §6 |
| V4 literals: bare Guid / DateTimeOffset / Date / TimeOfDay / numbers, `duration'…'`, `binary'…'`, `Ns.Enum'Member'` | OData 4.0 ABNF |
| V2 partial update = `MERGE`, V4 = `PATCH`; `PUT` = full replace | OData 2.0 / 4.0 protocol |
| V2 `$inlinecount=allpages` + `__count`, `__next`; V4 `$count=true` + `@odata.count`, `@odata.nextLink` | OData 2.0 / 4.0 |
| V2 has no `$search`: `search` is sent as SAP custom query option; V4 uses `$search` | SAP Gateway |
| V2 function import parameters in the query string; V4 function parameters in the path; V4 action parameters as JSON body | OData 2.0 / 4.0 |
| `$batch` multipart/mixed, `application/http` parts, `Content-Transfer-Encoding: binary`, `Content-ID` in change sets, GETs never inside change sets | OData 2.0 §2.2.7.6 / 4.0 §11.7 |
| CSRF: `GET` with `X-CSRF-Token: Fetch`, token sent with the same session cookies, refresh once on `403` + `X-CSRF-Token: Required` | SAP Gateway |
| Request target sent verbatim (no re-encoding of `'` to `%27`) | |
| V2 `/Date(ms)/` → ISO 8601 (optional) | SAP JSON format |

## Tests

```bash
npm test         # unit + Node-RED runtime tests against a mock SAP Gateway, enforces 100 % line/branch/function coverage
npm run test:live  # read-only smoke test against sandbox.api.sap.com (V2 API_BUSINESS_PARTNER, V4 API_PRODUCT)
```

`test:live` reads the key from `SAP_SANDBOX_API_KEY` or `sap-api-key-sandbox.txt` (git-ignored).

The mock Gateway reproduces session cookies, CSRF validation and SAP error bodies. The live test confirms the behaviour against real S/4HANA Cloud services, but the sandbox is read-only, so **write operations (create/update/delete, CSRF on a real system, actions) have been verified against the mock only**. Use a system where you are allowed to write (see below) to check them.

## Sandbox systems

- **SAP Business Accelerator Hub** – https://api.sap.com → log in → *Show API Key*. Base URL `https://sandbox.api.sap.com`, service e.g. `/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER`, Auth = API Key. Read-only.
- **SAP BTP ABAP environment (trial / free tier)** – build your own RAP service (V2 or V4) with write access; CSRF, ETags and actions behave like a real system.
- **ABAP Cloud Developer Trial** – a complete ABAP system (Docker image) running locally, including SAP Gateway.
- *(The former SAP Gateway demo system ES5 was decommissioned in 2025.)*

## Limitations

- No HTTP(S) proxy support yet
- No SAML / principal propagation (use OAuth2 / X.509 / Basic)
- `$batch` uses multipart format (also for V4); the V4 JSON batch format is not implemented
- Large media (`$value`) is buffered in memory

Example flow: `examples/sandbox-business-partner.json` (Import → Examples in Node-RED).
