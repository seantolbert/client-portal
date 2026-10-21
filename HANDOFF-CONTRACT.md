# Handoff Contract v1.0

This is the only thing the CRM project and the client portal project share.
Both repos keep a copy of this file. If you change it, update both copies in the same change and bump the version.

## Purpose

When a prospect is marked "won" in the CRM, the CRM sends it to the portal, which creates the client record. The portal owns client data after handoff.

## Endpoint

`POST https://<portal-domain>/api/clients`

Content-Type: `application/json`

## Authentication

Every request is signed with HMAC-SHA256 using the shared secret in the env var `HANDOFF_SECRET` (same value in both projects, never committed to git).

Headers:

- `X-Handoff-Timestamp`: current Unix time in seconds, as a string.
- `X-Handoff-Signature`: lowercase hex of `HMAC_SHA256(secret, timestamp + "." + raw_body)`.

Rules:

- `raw_body` is the exact bytes sent. Sign the string as sent, never re-serialize it.
- The portal rejects a request if the timestamp is more than 300 seconds from the portal's current time.
- The portal compares signatures in constant time.

## Request body

JSON object. Unknown fields are rejected with 400.

| Field | Type | Required | Rules |
|---|---|---|---|
| `prospect_id` | string | yes | Stable CRM prospect ID, 1–128 chars. Never changes for a given prospect. Used as the idempotency key. |
| `business_name` | string | yes | 1–200 chars |
| `contact_name` | string | no | up to 200 chars |
| `email` | string | yes | valid email, up to 254 chars |
| `phone` | string | no | up to 32 chars, E.164 preferred (e.g. `+17035550123`) |
| `address` | string | no | up to 500 chars, single line |

Example:

```json
{
  "prospect_id": "p_01HZX3K9Q2",
  "business_name": "Example Plumbing LLC",
  "contact_name": "Jordan Lee",
  "email": "jordan@example-plumbing.com",
  "phone": "+17035550123",
  "address": "123 Main St, Alexandria, VA 22314"
}
```

## Responses

| Status | When | Body |
|---|---|---|
| 201 | New client created | `{"client_id": "<uuid>", "created": true}` |
| 200 | `prospect_id` already exists (idempotent replay) | `{"client_id": "<uuid>", "created": false}` |
| 400 | Validation failed | `{"error": "validation_failed", "fields": {"<field>": "<reason>"}}` |
| 401 | Missing headers, bad signature, or stale timestamp | `{"error": "unauthorized"}` |
| 500 | Portal error | `{"error": "internal"}` |

Only `201` and `200` mean success. Any other status is a failure.

## Idempotency

`prospect_id` is the key. The portal enforces this with a unique constraint on `clients.prospect_id`. A retry with the same `prospect_id` never creates a second client, and it returns the existing `client_id` with status 200.

If a retry sends different field values for the same `prospect_id`, the portal keeps the original record and returns 200. It does not overwrite.

## CRM retry behavior

- Retry on network errors, timeouts, and 5xx, with exponential backoff (for example 1s, 4s, 16s, then stop).
- Do not retry on 400 or 401. Mark the prospect `sync_status = failed` and show the error.
- A manual "resync" action re-sends with the same `prospect_id`.

## Logging

The portal logs every request with: `prospect_id`, outcome (`created`, `existing`, `rejected`), error reason if any, and timestamp. Never log the secret or the signature.

## Out of scope for v1

- Portal-to-CRM callbacks or webhooks
- CRM reading billing status (possible later via `GET /api/clients/:id/status`, not yet specified)
- Updating or deleting clients through this endpoint
