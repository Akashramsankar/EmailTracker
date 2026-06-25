# Email Tracker for Freshdesk

## Product Summary

This app tracks opens on Freshdesk ticket replies by intercepting the native Freshdesk reply send action, inserting an app-owned tracking pixel into the already-open editor, and allowing the native send to continue.

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

- Agents write and send replies in the native Freshdesk editor.
- The `ticket_conversation_editor` app intercepts `ticket.sendReply`, inserts a tokenized tracking pixel with `setValue`, and then lets the native send continue.
- Each tracked email reply gets a unique token and pixel URL before it is sent.
- The public bridge records the pixel hit and relays an `open` event to `onExternalEvent`.
- First real opens update tracking fields and add one private note.
- Repeated opens update counters and timeline data without note spam.
- IP blacklist entries keep scanner traffic auditable but excluded from primary read metrics.

## Important Limitation

The app supports one primary v1 tracking entry point:

- Native Freshdesk reply send, where the app pauses the send click, prepares a tracking record, inserts the hidden pixel into the open editor, and resumes the send.

The sidebar is status-only in v1. The older app-owned compose fallback remains available as a server function for recovery/testing, but it is not exposed in the primary agent UI.

## Repo Surfaces

- `app/sidebar.html` and `app/scripts/sidebar.js`
  Ticket-level tracking status, metrics, and timeline visibility.
- `app/editor.html` and `app/scripts/editor.js`
  Native reply-area send intercept that inserts tracking into the already-open Freshdesk editor.
- `app/index.html` and `app/scripts/dashboard.js`
  Aggregate dashboard for tracked/read/unread/open totals and recent events.
- `app/runtime.html` and `app/scripts/runtime.js`
  Background runtime sync for live field metadata.
- `server/server.js`
  Tracker state, reply sending, external-event handling, field sync, and dashboard/sidebar data.
- `external-email-tracker-bridge/`
  Tiny public Node service for the tracking pixel and relay behavior.
