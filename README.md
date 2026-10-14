# Somali Date Proposal

Requires Node.js 20 or newer. Run locally with:

```sh
npm start
```

Then open `http://localhost:3000`. The appointment API must be served from the same origin as the page; opening `index.html` directly is unsupported.

## Sharing and security

- **Send via WhatsApp** shares only the recipient invitation. **Copy Invitation Link** copies that same link. Invitation and organizer tokens are separate, random 256-bit bearer secrets.
- New links put their token in the URL fragment, so browsers do not send it in HTTP request paths or referrers. API calls send the token in the `Authorization` header. Configure the reverse proxy and any APM/access logging to redact `Authorization` headers.
- The recipient link can view and accept or decline. It cannot cancel or act as the organizer. The private organizer link can view status and cancel; keep it private.
- New links expire after 180 days. There is no account or identity system; creator is stored as “Website visitor” and recipient is unknown.
- The same-origin API does not enable CORS. It checks browser request origin and Fetch Metadata on state changes. The server applies per-IP limits: 120 requests/minute overall, 8 appointment-create attempts/15 minutes, and 60 appointment-token requests/minute. Limits are in-memory per process.
- The server applies a nonce-based CSP and security headers, caps JSON request bodies at 4 KiB, serves only the app page, and writes generic server errors without request/token details.

## Existing appointment data

No data migration is required. Existing JSON records keep their current IDs, token hashes, details, and status; records without an `expiresAt` field remain valid without an expiry. New records include `expiresAt`. Old query-style links are redirected to fragment-style links so future requests do not send their token in the URL. A legacy link’s first redirect request still contains its old query token; avoid retaining query strings in proxy logs during this transition.

The server does not automatically remove expired records. Back up `appointments.json` before any manual cleanup. The file store is intended for one server process/instance; multiple instances can overwrite each other and need a shared transactional database plus a shared rate limiter.

## Production deployment

Terminate TLS at a reverse proxy and restrict network access to the Node server so only that proxy can reach it. Production startup requires `NODE_ENV=production`, an HTTPS `PUBLIC_URL`, and `TRUSTED_PROXY_IPS`. The proxy must overwrite `X-Forwarded-Proto` with the client-facing scheme and append the actual client IP to `X-Forwarded-For`; only the rightmost forwarded IP is used, and only when the direct peer matches the configured trusted IP list.

Configure:

- `PORT`: listening port, default `3000`.
- `PUBLIC_URL`: canonical origin, required as `https://your-domain` in production. It must not include a path, query, fragment, or credentials. It prevents Host-header poisoning in generated links.
- `TRUSTED_PROXY_IPS`: comma-separated exact IP addresses of the HTTPS-terminating proxy. Required in production; do not trust all forwarded headers or expose the Node port publicly.
- `APPOINTMENTS_FILE`: optional absolute path to the JSON file. The default is `data/appointments.json`. Keep the parent directory private and persistent; the app creates new directories with restrictive permissions and writes the file with owner-only permissions where supported.
- `NODE_ENV=production`: enables HTTPS proxy enforcement, HSTS, and insecure-request upgrades.

Without persistent storage, a restart or redeploy can lose appointments. Custom storage mounts must enforce private filesystem/volume ACLs. The JSON file and in-memory rate limiter are not suitable for multi-instance or high-traffic deployments.
