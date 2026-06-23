# Email Tracker for Freshdesk

## Product Summary

This app tracks opens on Freshdesk ticket replies through the app-owned tracked-send flow and through the native Freshdesk conversation-editor assist flow.

The Freshworks app owns:

- ticket-level tracking status in the sidebar
- aggregate reporting in the full-page dashboard
- first-open private note creation
- mapped Freshdesk field updates for Seen and Count
- the external-event hook that receives bridge relays

The public bridge owns:

- the tracking pixel endpoint
- request signing validation
- bridge-to-Freshworks relay delivery

## Current v1 Behavior

- Agents can send tracked replies from the ticket sidebar.
- Each tracked reply gets a unique token and pixel URL.
- The public bridge records the pixel hit and relays an `open` event to `onExternalEvent`.
- First real opens update tracking fields and add one private note.
- Repeated opens update counters and timeline data without note spam.
- IP blacklist entries keep scanner traffic auditable but excluded from primary read metrics.

## Important Limitation

The app now supports two tracked reply paths:

- Sidebar tracked-send, where the app sends the reply itself.
- Native Freshdesk conversation-editor assist, where the app inserts the tracking snippet into the open editor and the agent sends from Freshdesk normally.

The native editor flow is still intentionally explicit rather than silent. Freshworks documents editor insertion through the `ticket_conversation_editor` placeholder, but does not document a universal background hook that can silently mutate every outbound email composer.

## Repo Surfaces

- `app/sidebar.html` and `app/scripts/sidebar.js`
  Ticket-level status plus tracked-send fallback flow.
- `app/editor.html` and `app/scripts/editor.js`
  Native Freshdesk conversation-editor helper for inserting tracking before an agent sends from Freshdesk.
- `app/index.html` and `app/scripts/dashboard.js`
  Aggregate dashboard for tracked/read/unread/open totals and recent events.
- `app/runtime.html` and `app/scripts/runtime.js`
  Background runtime sync for live field metadata.
- `server/server.js`
  Tracker state, reply sending, external-event handling, field sync, and dashboard/sidebar data.
- `external-email-tracker-bridge/`
  Tiny public Node service for the tracking pixel and relay behavior.
