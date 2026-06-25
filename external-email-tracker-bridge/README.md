# External Email Tracker Bridge

This is the tiny public service that receives tracking-pixel requests and relays normalized open events back into the Freshworks app `onExternalEvent` hook.

## Why it exists

- Freshworks `onExternalEvent` endpoints are webhook-style callbacks.
- A traditional email open tracker needs a public `GET` image endpoint.
- The bridge signs pixel URLs, returns the 1x1 image, and then posts the open event server-to-server to Freshworks.

## Endpoints

- `GET /health`
- `GET /pixel`
- `GET /click` (future-ready redirect flow)
- `POST /freshdesk/reply` (tracked reply delivery with attachments)

`/freshdesk/reply` is used by the Freshworks app server when the Email Tracker composer includes attachments. The app server sends a JSON payload containing the Freshdesk domain, API authorization value, tracked HTML body, optional sender/cc/bcc fields, and base64 file payloads. The bridge converts that into Freshdesk's required `multipart/form-data` shape with `attachments[]`.

## Cloudflare Workers

This folder now includes a Worker entrypoint at `src/index.js` plus `wrangler.toml`.

### Deploy with Workers

```bash
cd external-email-tracker-bridge
wrangler login
wrangler secret put BRIDGE_SIGNING_PRIVATE_KEY
wrangler deploy
```

After deploy, note the `workers.dev` URL and set it as the app-owned `bridge_public_url`.

Deploy the Worker after changing attachment handling; the Freshworks app package alone cannot add attachment delivery because multipart upload happens in this bridge.

## Run locally

```bash
cd external-email-tracker-bridge
npm start
```

The bridge listens on `http://localhost:8787` by default.

## Environment variables

```text
PORT=8787
BRIDGE_SIGNING_PRIVATE_KEY=<private-key-pem>
```

The Worker signs relay payloads with the private key. The Freshdesk app verifies them with the matching public key embedded in the app code.

## Pixel URL contract

The Freshworks app generates pixel URLs in this shape:

```text
/pixel?token=<tracking-token>&hook=<freshworks-hook-url>
```

The bridge validates basic request structure before relaying the event.

## Deploy

Host this folder anywhere you can run a tiny Node web service:

- Render
- Railway
- Fly.io
- a small VM/container

If you use a custom domain, point the public tracker URL in the app runtime settings or app-owned defaults to that domain so generated pixel URLs stay stable.
