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

## Run locally

```bash
cd external-email-tracker-bridge
npm start
```

The bridge listens on `http://localhost:8787` by default.

## Environment variables

```text
PORT=8787
BRIDGE_SECRET=dev-email-tracker-bridge-secret
```

`BRIDGE_SECRET` must match the bridge secret configured in the Freshdesk app install page, or the shared default used during local development.

## Pixel URL contract

The Freshworks app generates pixel URLs in this shape:

```text
/pixel?token=<tracking-token>&hook=<freshworks-hook-url>&sig=<sha256-signature>
```

The bridge validates the signature before relaying the event.

## Deploy

Host this folder anywhere you can run a tiny Node web service:

- Render
- Railway
- Fly.io
- a small VM/container

If you use a custom domain, point the public tracker URL in the app runtime settings or app-owned defaults to that domain so generated pixel URLs stay stable.
