let client;

let state = {
  ticketId: 0,
  loading: true,
  summary: {
    tracked_count: 0,
    read_count: 0,
    unread_count: 0,
    total_open_count: 0,
    blacklisted_open_count: 0,
  },
  runtime: {
    external_hook_url_present: false,
    bridge_public_url: "",
    native_reply_injection_supported: true,
  },
  senderOptions: [],
  messages: [],
  sending: false,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    bindEvents();

    client.events.on("app.activated", () => {
      void loadSidebar(true);
    });

    await loadSidebar(false);
  } catch (error) {
    console.error("Sidebar init failed:", error);
    document.getElementById("sidebarLoading").textContent = "Unable to load the email tracker sidebar.";
  }
}

function bindEvents() {
  document.getElementById("sendTrackedReplyBtn").addEventListener("click", () => {
    void sendTrackedReply();
  });

  document.getElementById("refreshBtn").addEventListener("click", () => {
    void loadSidebar(false);
  });
}

async function loadSidebar(silent) {
  state.loading = true;
  if (!silent) {
    render();
  }

  try {
    const ticketData = await client.data.get("ticket");
    const ticket = ticketData && ticketData.ticket ? ticketData.ticket : ticketData;
    state.ticketId = Number(ticket && ticket.id) || 0;

    const response = await client.request.invoke("getTicketTrackerData", {
      ticket_id: state.ticketId,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to load ticket tracker data.");
    }

    state.summary = payload.summary || state.summary;
    state.runtime = payload.runtime || state.runtime;
    state.senderOptions = Array.isArray(payload.sender_options) ? payload.sender_options : [];
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
  } catch (error) {
    console.error("Unable to load ticket tracker data:", error);
    notify("error", resolveErrorMessage(error, "Unable to load ticket tracker data."));
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  const loadingEl = document.getElementById("sidebarLoading");
  const mainEl = document.getElementById("sidebarMain");

  if (state.loading) {
    loadingEl.classList.remove("hidden");
    mainEl.classList.add("hidden");
    return;
  }

  loadingEl.classList.add("hidden");
  mainEl.classList.remove("hidden");
  renderRuntimeBanner();
  renderMetrics();
  renderSenderOptions();
  renderTimeline();
}

function renderRuntimeBanner() {
  const banner = document.getElementById("runtimeBanner");
  if (state.runtime.external_hook_url_present) {
    banner.className = "banner";
    banner.textContent = "Tracking is ready. You can send through the app flow or insert tracking from the native Freshdesk conversation editor.";
  } else {
    banner.className = "banner banner-error";
    banner.textContent = "The tracking hook is not initialized yet. Trigger a ticket event or reinstall the app before sending tracked replies or using the native editor helper.";
  }
}

function renderMetrics() {
  const metrics = [
    { label: "Tracked", value: state.summary.tracked_count || 0 },
    { label: "Read", value: state.summary.read_count || 0 },
    { label: "Opens", value: state.summary.total_open_count || 0 },
  ];

  document.getElementById("metricsGrid").innerHTML = metrics.map((metric) => {
    return [
      '<div class="metric">',
      `<div class="metric-label">${escapeHtml(metric.label)}</div>`,
      `<div class="metric-value">${escapeHtml(metric.value)}</div>`,
      "</div>",
    ].join("");
  }).join("");
}

function renderSenderOptions() {
  const select = document.getElementById("senderSelect");
  const currentValue = select.value;
  const options = ['<option value="">Default mailbox</option>']
    .concat(state.senderOptions.map((option) => {
      return `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
    }));
  select.innerHTML = options.join("");
  select.value = currentValue;
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  const emptyEl = document.getElementById("timelineEmpty");

  if (!state.messages.length) {
    timeline.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  timeline.innerHTML = state.messages.map((message) => {
    const statusClass = message.status === "read" ? "tag-read" : "tag-unread";
    const statusLabel = message.status === "read" ? "Read" : "Unread";
    const blacklistTag = Number(message.blacklisted_open_count) > 0
      ? `<span class="tag tag-blacklisted">${escapeHtml(`${message.blacklisted_open_count} blacklisted`)}</span>`
      : "";

    const recentEvents = (Array.isArray(message.opens) ? message.opens : []).slice(0, 3);
    const eventMarkup = recentEvents.length
      ? recentEvents.map((eventRecord) => {
          const eventTag = eventRecord.blacklisted
            ? '<span class="tag tag-blacklisted">Blacklisted</span>'
            : '<span class="tag tag-read">Counted</span>';
          return [
            '<div class="event-row">',
            eventTag,
            `<span>${escapeHtml(formatDate(eventRecord.occurred_at))}</span>`,
            `<span>${escapeHtml(eventRecord.browser || "Unknown browser")}</span>`,
            `<span>${escapeHtml(eventRecord.source_ip || "Unknown IP")}</span>`,
            "</div>",
          ].join("");
        }).join("")
      : '<div class="event-row">No open events yet.</div>';

    return [
      '<div class="message-card">',
      '<div class="message-top">',
      `<div class="stack"><strong>${escapeHtml(message.reply_subject || "Tracked reply")}</strong><span class="muted">${escapeHtml(message.body_preview || "")}</span></div>`,
      `<div class="stack"><span class="tag ${statusClass}">${statusLabel}</span>${blacklistTag}</div>`,
      "</div>",
      `<div class="event-row"><span>Sent: ${escapeHtml(formatDate(message.created_at))}</span><span>Opens: ${escapeHtml(message.open_count || 0)}</span><span>Unique: ${escapeHtml(message.unique_open_count || 0)}</span></div>`,
      eventMarkup,
      "</div>",
    ].join("");
  }).join("");
}

async function sendTrackedReply() {
  if (state.sending) {
    return;
  }

  const bodyText = normalizeText(document.getElementById("replyBody").value);
  if (!bodyText) {
    notify("error", "Reply body is required.");
    return;
  }

  state.sending = true;
  const button = document.getElementById("sendTrackedReplyBtn");
  button.disabled = true;
  button.textContent = "Sending...";

  try {
    const response = await client.request.invoke("sendTrackedReply", {
      ticket_id: state.ticketId,
      body_text: bodyText,
      sender_email: document.getElementById("senderSelect").value,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to send the tracked reply.");
    }

    document.getElementById("replyBody").value = "";
    notify("success", "Tracked reply sent.");
    await loadSidebar(true);
  } catch (error) {
    console.error("Unable to send tracked reply:", error);
    notify("error", resolveErrorMessage(error, "Unable to send the tracked reply."));
  } finally {
    state.sending = false;
    button.disabled = false;
    button.textContent = "Send Tracked Reply";
  }
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

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function formatDate(value) {
  if (!value) return "Pending";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === null || value === undefined ? "" : String(value);
  return div.innerHTML;
}
