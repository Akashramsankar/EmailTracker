let client;

const state = {
  ticketId: 0,
  loading: true,
  summary: {
    tracked_count: 0,
    read_count: 0,
    unread_count: 0,
    total_open_count: 0,
    blacklisted_open_count: 0,
  },
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
  renderMetrics();
}

function renderMetrics() {
  const metrics = [
    { label: "Tracked", value: state.summary.tracked_count || 0 },
    { label: "Read", value: state.summary.read_count || 0 },
    { label: "Unread", value: state.summary.unread_count || 0 },
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
  return payload.detail || payload.message || (payload.error && payload.error.message) || "";
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

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === null || value === undefined ? "" : String(value);
  return div.innerHTML;
}
