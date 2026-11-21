# WhatsApp Business verified media contract (TASK-008)

Purpose: satisfy the mandatory prerequisite in
[whatsapp-business-prerequisite.md](whatsapp-business-prerequisite.md) for the
WhatsApp **Business** (Cloud API) media mapper, and replace the `NOT READ`
status recorded in contract-inventory **E3**.

Status: **READ — VERIFIED**. The primary current contract was read from Meta's
live documentation before any mapper code was written. The historical v13
screenshot was **not** used as a source of response shape.

- Report written: `2026-10-16` (UTC).
- Connector configured version: `apiVersion` from `WhatsAppConfig`, defaulting to
  `v18.0` (`src/channels/connectors/whatsapp-business/whatsapp-connector.ts:36`,
  `:156`). The base URL is `https://graph.facebook.com` (same file, `:37`).
- No operator credentials and no live API call were used. Only public
  documentation was read.

---

## 1. How the contract was read (reproducible)

The `source-manifest.json` pin
`https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media/`
(`documents.whatsapp-media`) is a **redirect**, and it behaves differently per
user agent:

| Attempt | Request | Result |
| --- | --- | --- |
| 1 | `curl -sSL` with the default curl UA against the pinned URL | `HTTP 400`, 1 543 bytes — unusable |
| 2 | `curl -sSL` with a browser UA + `Accept-Language: en-US,en;q=0.9` against the pinned URL | `HTTP 200`, 697 KB, effective URL `https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media` |
| 3 | `curl -sSL` browser UA against `https://developers.facebook.com/docs/whatsapp/reference/media/media-api` (the page's own "Media API" link) | `HTTP 404` |
| 4 | `curl -sSL` browser UA against `https://developers.facebook.com/docs/whatsapp/reference/media/media-download-api` (the page's own "Media Download API" link) | `HTTP 404` |
| 5 | `curl -sSL` browser UA against `https://developers.facebook.com/docs/whatsapp/cloud-api/reference/versioning` | `HTTP 404` |

Attempt 2 is the authoritative read. The page body is a Meta component tree
(`DMCCommon*` / `DeveloperCode` nodes) embedded as escaped JSON inside the HTML,
so the prose and code blocks were extracted from that tree rather than from
rendered text. Section anchors used: `#get-media-url`, `#request-syntax`,
`#response-syntax`, `#download-media`, `#supported-media-types`.

**Citation form used below.** These are live-doc citations (URL + section anchor
+ verbatim quote), not `file:line` citations, because the source is a versioned
web page rather than a cached tarball. Attempt 2 is reproducible with the exact
UA/headers recorded above; the in-page links from attempts 3–5 are recorded as
dead so a later reviewer does not re-chase them.

---

## 2. Media-ID lookup (metadata) — VERIFIED

### 2.1 Request

Verbatim request syntax from `#get-media-url` → "Request syntax":

```
curl 'https://graph.facebook.com/<API_VERSION>/<MEDIA_ID>?phone_number_id=<BUSINESS_PHONE_NUMBER_ID>' \
-H 'Authorization: Bearer EAAJB'
```

Consumed properties:

| Element | Verified value | Mapper consequence |
| --- | --- | --- |
| Method | `GET` (the operation table lists `GET /MEDIA_ID` → "Retrieve the URL for a specific media.") | Lookup is a GET, no body, no `messaging_product` parameter |
| Host | `https://graph.facebook.com` | Matches the connector's existing `GRAPH_API_BASE` |
| Version | `<API_VERSION>` placeholder | The connector substitutes **its configured `apiVersion`** (`v18.0` default). Never a hardcoded literal in the mapper |
| Path | `/<MEDIA_ID>` | The media ID from the inbound webhook is the whole path segment; it is URL-path-encoded by the mapper |
| Query | `phone_number_id=<BUSINESS_PHONE_NUMBER_ID>` | Sent as the connector's configured `phoneNumberId` |
| Auth | `Authorization: Bearer <access token>` | The connector's existing `accessToken`; no other auth scheme |

`phone_number_id` semantics, verbatim:

> "Note that `phone_number_id` is optional. If included, the request will only be
> processed if the business phone number ID included in the query matches the ID
> of the business phone number that the media was uploaded on."

Decision recorded: the mapper **does** send `phone_number_id` from the connector
config. It is documented as optional, and sending it binds every lookup to the
connector's own phone number, so a media ID from another account cannot be
resolved with a leaked token. This is hardening, not a new policy.

### 2.2 Response envelope — VERIFIED

Verbatim from `#get-media-url` → "Response syntax":

> "A successful response includes an object with a media URL. The URL is only
> valid for 5 minutes. To use this URL, see Download Media"

```
{
  "messaging_product": "whatsapp",
  "url": "<MEDIA_URL>",
  "mime_type": "<MEDIA_MIME_TYPE>",
  "sha256": "<SHA_256_HASH>",
  "file_size": "<MEDIA_FILE_SIZE>",
  "id": "<MEDIA_ID>"
}
```

This is a **direct** (unwrapped) envelope — there is no `data`, `ok`, or `result`
wrapper, which is exactly what E3 recorded from the v13 evidence and what is now
confirmed on the current page.

Fields consumed by the mapper and why:

| Field | Consumed | Use |
| --- | --- | --- |
| `messaging_product` | yes | Must equal `"whatsapp"`; any other value fails the envelope check **before** any download URL is selected |
| `url` | yes | The only mandatory field; must be a non-empty `https:` URL before it is ever opened |
| `mime_type` | yes | Authoritative post-lookup MIME; gates eligibility (`image/*` + supported formats) before bytes are requested |
| `file_size` | yes | Declared size; compared against `images.maxInputBytes` so a confirmed oversized asset is rejected **without** downloading it |
| `sha256` | no | Not used: there is no expected digest to compare against, so verifying it would add no assurance |
| `id` | no | Echo only; the mapper already owns the requested ID |

URL lifetime, verbatim:

> "Media URLs **expire after 5 minutes**, after which you must query the ID again
> to get a new URL."

Consequence: the URL is used immediately and is treated as sensitive transient
material — it is never persisted, never returned in an Attachment, and never
logged (a media URL is pre-signed).

### 2.3 Media-ID lifetime

Verbatim from `#get-media-id`:

> "Media IDs returned by the API expire after 30 days. Media IDs in webhooks
> expire after 7 days."

The mapper consumes webhook IDs, so the effective window is 7 days. This is not
modelled as a distinct rejection reason; an expired ID fails the lookup and maps
to the closed `download_failed`.

---

## 3. Byte download — VERIFIED separately

### 3.1 Request and authentication

Verbatim request syntax from `#download-media`:

```
curl '<MEDIA_URL>' \
-H 'Authorization: Bearer EAAJB...' \
-o '<DESIRED_FILE_NAME>'
```

Authentication is **not** inherited from the lookup and is required again,
verbatim (emphasis is Meta's):

> "Include your access token in the request. **If you omit your token, the
> request will fail.**"

So the mapper sends `Authorization: Bearer <accessToken>` on the byte request as
a separate, independently verified step, using the same existing connector token.

### 3.2 Byte response

Verbatim:

> "Upon success, the API will respond with the binary data of the media asset.
> Response headers contain a content-type header to indicate the MIME type of
> returned data."

Consequences:

- The successful body is **raw bytes, not JSON** (the same trap as Telegram E2).
- `content-type` is the response MIME. The mapper reads it only as a fallback for
  the payload MIME when the metadata envelope declared none; it never widens
  eligibility from a response header.
- Non-2xx, or an unusable body, is an open failure and maps to `download_failed`.

### 3.3 Failure and retry guidance

Verbatim:

> "If the download attempt fails, you will receive a `404 Not Found` response
> code. In that case, try to get a new media URL and download it again. If doing
> so doesn't resolve the issue, renew your access token and attempt to download
> the media asset again."

**Decision recorded (deliberate non-implementation):** the mapper does **not**
auto-refresh the URL and retry. The lookup and the download happen back to back
inside one message handling, far inside the documented 5-minute window, so URL
expiry is not the realistic failure mode this retry addresses; a second lookup +
download would only double the work of a failure that Talon already reports as
retryable `download_failed` at the Image layer. Retrying is the pipeline's job,
and any retry must share the message fetch budget rather than start a new one.
This is a deviation from Meta's suggestion, made knowingly, and it is not a
silently invented contract field.

---

## 4. Supported media types and eligibility — VERIFIED

Verbatim from `#supported-media-types`, Image group ("Images must be 8-bit, RGB
or RGBA."):

| Type | Extension | MIME | Max size |
| --- | --- | --- | --- |
| JPEG | `.jpeg` | `image/jpeg` | 5 MB |
| PNG | `.png` | `image/png` | 5 MB |

Sticker group: WebP images "can only be sent in sticker messages". Documents
(`text/plain`, Office types, `application/pdf`) are capped at 100 MB; audio types
at 16 MB.

Mapper consequences:

- **Stickers are excluded before any request.** `type: 'sticker'` produces no
  candidate and consumes no slot; the WebP-sticker case is covered by the same
  flag path, matching the shared `MEDIA_EXCLUSION_REASONS` `sticker` rule.
- **Non-image documents are excluded before any request** using the **declared**
  webhook MIME through the shared `document`-origin rule (absent or non-`image/*`
  MIME → silent exclusion, no slot). A filename never establishes MIME.
- A `document` that declares an image MIME stays eligible; an image MIME outside
  the shared supported set (HEIC, SVG, …) consumes its slot as
  `unsupported_mime` without a download.
- **No channel-specific byte cap is introduced.** The 5 MB image figure is
  Meta's supported-media table, not a documented download ceiling for received
  media, and the brief forbids channel policy changes. Sizing therefore uses only
  the shared `images.maxInputBytes`: the verified `file_size` rejects confirmed
  oversized assets before download, and `fetchImage` enforces **actual** bytes
  during streaming. `size_limit` is the closed reason in both cases.

---

## 5. Timeouts and the shared message budget

The contract itself documents no request timeout. The only timeout Meta states is
the 5-minute URL lifetime (§2.2) and the ID lifetimes (§2.3). Talon's bound is
therefore entirely the shared TASK-004 `createMessageFetchBudget()` — one fixed
60-second wall clock per message (`MESSAGE_FETCH_BUDGET_MS`) shared by the
metadata lookup **and** every byte download, with no per-call reset, and actual
bytes enforced by `fetchImage`'s during-consumption cutoff.

---

## 6. NOT READ / explicitly unverified

Recorded so a reviewer does not mistake inference for evidence:

1. **Per-version response differences for `v18.0` specifically: NOT READ.** The
   readable page documents the media contract once, version-agnostically, using
   the `<API_VERSION>` placeholder; no version-specific media page was reachable
   (attempts 3–5 above returned 404). The mapper therefore uses the connector's
   configured version verbatim instead of assuming a version-specific shape.
2. **Whether `v18.0` is the newest Graph API version: NOT VERIFIED.** The
   WhatsApp changelog was fetched successfully (`HTTP 200`, entries dated up to
   2026-10-08) and mentions `v14.0`–`v18.0`, but the only `v18.0` occurrence found
   concerns WhatsApp Flows field deprecation, not the media API, and no
   version-support or sunset table was found. Nothing found contradicts `v18.0`
   serving the media endpoints. **Follow-up for the operator, not this task:**
   consider pinning a newer `apiVersion` in config.
3. **Media-lookup error envelope field semantics: NOT READ.** The page does not
   document the lookup failure body. The connector's existing send path already
   types an error shape (`whatsapp-types.ts` `WhatsAppSendResult.error`), and the
   mapper treats any non-ok or unparseable lookup as a failure while **never**
   echoing the server-provided message text (Meta error text can carry URLs or
   token material).
4. **Webhook media objects carrying `url` directly: observed in prose, NOT
   implemented.** §Get media URL states that incoming media webhooks "include the
   media URL, which is assigned to the `url` property." The webhook type the
   connector actually models (`WhatsAppMediaBody`) carries `id`, `mime_type`,
   `sha256`, `caption`, `filename` — no `url` — and the task's declared contract
   is the media-ID lookup. The mapper therefore **always** performs the verified
   lookup and does not trust an unmodelled webhook `url`. Flagged for the
   reviewer as a possible later optimization, not a silent scope change.

---

## 7. How the mapper uses this contract

- `src/channels/connectors/whatsapp-business/whatsapp-media.ts` — pure planning
  (`planWhatsAppMedia`) plus the bounded fetch orchestration
  (`fetchWhatsAppMedia`) on the shared `selectImages` / `fetchImage` ports.
- `src/channels/connectors/whatsapp-business/whatsapp-connector.ts` — the only
  token-aware layer: `lookupWhatsAppMedia` (verifies `messaging_product`, `url`,
  `mime_type`, `file_size` before a URL is selected) and `openWhatsAppMedia`
  (re-sends the bearer token, verifies the byte response separately). Both accept
  the shared budget's `AbortSignal`, and both throw **fixed-text** errors with no
  token, no media URL, and no cause object, so nothing sensitive can reach the
  closed transport errors, durable results, or logs.
- Authorization ordering lives in the connector's `handleMessage`: webhook
  signature verification (`whatsapp-webhook-server.ts`), the
  `object === 'whatsapp_business_account'` gate, the `field === 'messages'` gate,
  and event admission all resolve **before** `fetchWhatsAppMedia` is reached, so a
  denied or ignored payload performs zero media requests.
