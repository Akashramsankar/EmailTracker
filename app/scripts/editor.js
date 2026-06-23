let client;

let state = {
  ticketId: 0,
  loading: true,
  inserting: false,
  runtimeReady: false,
  inserted: false,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    bindEvents();

    client.events.on("app.activated", () => {
      state.inserted = false;
      void hydrate(false);
    });

    await hydrate(false);
  } catch (error) {
    console.error("Editor helper init failed:", error);
    setStatus(resolveErrorMessage(error, "Unable to load the native editor helper."));
  }
}

function bindEvents() {
  document.getElementById("insertTrackingBtn").addEventListener("click", () => {
    void insertTracking();
  });

  document.getElementById("refreshEditorBtn").addEventListener("click", () => {
    state.inserted = false;
    void hydrate(false);
  });
}

async function hydrate(silent) {
  state.loading = true;
  if (!silent) {
    render();
  }

  try {
    const ticketData = await client.data.get("ticket");
    const ticket = ticketData && ticketData.ticket ? ticketData.ticket : ticketData;
    state.ticketId = Number(ticket && ticket.id) || 0;

    if (!state.ticketId) {
      throw new Error("Ticket context is unavailable in the conversation editor.");
    }

    const response = await client.request.invoke("getTicketTrackerData", {
      ticket_id: state.ticketId,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to load email tracker ticket data.");
    }

    state.runtimeReady = Boolean(
      payload.runtime &&
      payload.runtime.external_hook_url_present &&
      payload.runtime.bridge_public_url
    );
  } catch (error) {
    console.error("Unable to hydrate editor helper:", error);
    setStatus(resolveErrorMessage(error, "Unable to prepare the native editor helper."));
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  const insertButton = document.getElementById("insertTrackingBtn");
  const modePill = document.getElementById("editorModePill");

  insertButton.disabled = state.loading || state.inserting || !state.runtimeReady || state.inserted;
  insertButton.textContent = state.inserting
    ? "Inserting..."
    : state.inserted
      ? "Tracking Inserted"
      : "Insert Open Tracking";

  modePill.textContent = state.runtimeReady ? "Native Editor Assist" : "Runtime Setup Needed";

  if (!state.loading && !state.runtimeReady) {
    setStatus("Tracking setup is not ready yet. Refresh the ticket or reinstall the app first.");
  } else if (!state.loading && !state.inserted) {
    setStatus("Ready to insert tracking into the current editor.");
  }
}

async function insertTracking() {
  if (state.inserting || state.loading || !state.runtimeReady || !state.ticketId) {
    return;
  }

  state.inserting = true;
  render();

  try {
    const response = await client.request.invoke("prepareConversationTracking", {
      ticket_id: state.ticketId,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to prepare the tracked editor snippet.");
    }

    await client.interface.trigger("setValue", {
      id: "editor",
      text: payload.html_snippet,
      replace: false,
      position: "end",
    });

    state.inserted = true;
    setStatus("Tracking pixel inserted. Send the email from Freshdesk normally.", true);
    notify("success", "Tracking inserted into the open editor.");
  } catch (error) {
    console.error("Unable to insert editor tracking:", error);
    const message = resolveErrorMessage(error, "Unable to insert tracking into the native editor.");
    setStatus(message);
    notify("error", message);
  } finally {
    state.inserting = false;
    render();
  }
}

function setStatus(message, success) {
  const statusEl = document.getElementById("editorStatus");
  statusEl.className = success ? "status success" : "status";
  statusEl.textContent = message;
}

function parseInvokeResponse(result) {
  if (!result) return null;
  if (typeof result === "string") {
    try { return JSON.parse(result); } catch { return null; }
  }
  if (typeof result.response === "string") {
    try { return JSON.parse(result.response); } catch { return null; }
  }
  if (result.response && typeof result.response === "object") {
    return result.response;
  }
  return typeof result === "object" ? result : null;
}

function resolveInvokeError(payload) {
  if (!payload) return "";
  return payload.message || payload.detail || (payload.error && payload.error.message) || "";
}

function resolveErrorMessage(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function notify(type, message) {
  client.interface.trigger("showNotify", {
    type: type === "error" ? "danger" : type,
    message,
  });
}
