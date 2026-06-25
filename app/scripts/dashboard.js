let client;

const EMPTY_METRICS = {
  tracked: 0,
  read: 0,
  unread: 0,
  opens: 0,
  blacklisted: 0,
};

let state = {
  loading: true,
  metrics: { ...EMPTY_METRICS },
  tickets: [],
  recentEvents: [],
  runtime: {
    external_hook_url_present: false,
    bridge_public_url: "",
  },
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    bindEvents();

    client.events.on("app.activated", () => {
      void loadDashboard(true);
    });

    await loadDashboard(false);
  } catch (error) {
    console.error("Dashboard init failed:", error);
    document.getElementById("ticketsLoading").textContent = "Failed to initialize the dashboard.";
  }
}

function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => {
    void loadDashboard(false);
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchInput").value = "";
    document.getElementById("statusFilter").value = "all";
    renderTickets();
    renderEvents();
  });

  document.getElementById("searchInput").addEventListener("input", () => {
    renderTickets();
    renderEvents();
  });

  document.getElementById("statusFilter").addEventListener("change", () => {
    renderTickets();
    renderEvents();
  });
}

async function loadDashboard(silent) {
  state.loading = true;
  if (!silent) {
    renderTickets();
  }

  try {
    const response = await client.request.invoke("getTrackerDashboardData", {});
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to load dashboard data.");
    }

    state.metrics = normalizeMetrics(payload.metrics);
    state.tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
    state.recentEvents = Array.isArray(payload.recent_events) ? payload.recent_events : [];
    state.runtime = payload.runtime || state.runtime;
  } catch (error) {
    console.error("Unable to load dashboard data:", error);
    notify("error", resolveErrorMessage(error, "Unable to load dashboard data."));
  } finally {
    state.loading = false;
    renderMetrics();
    renderRuntime();
    renderTickets();
    renderEvents();
  }
}

function normalizeMetrics(metrics) {
  return {
    tracked: Number(metrics && metrics.tracked) || 0,
    read: Number(metrics && metrics.read) || 0,
    unread: Number(metrics && metrics.unread) || 0,
    opens: Number(metrics && metrics.opens) || 0,
    blacklisted: Number(metrics && metrics.blacklisted) || 0,
  };
}

function renderMetrics() {
  const metrics = [
    { label: "Tracked Replies", value: state.metrics.tracked },
    { label: "Read Replies", value: state.metrics.read },
    { label: "Unread Replies", value: state.metrics.unread },
    { label: "Total Opens", value: state.metrics.opens },
    { label: "Blacklisted Opens", value: state.metrics.blacklisted },
  ];

  document.getElementById("metricsGrid").innerHTML = metrics
    .map((metric) => {
      return [
        '<div class="metric-card">',
        `<div class="metric-label">${escapeHtml(metric.label)}</div>`,
        `<strong>${escapeHtml(metric.value)}</strong>`,
        "</div>",
      ].join("");
    })
    .join("");
}

function renderRuntime() {
  const pill = document.getElementById("runtimePill");
  const hookReady = Boolean(state.runtime.external_hook_url_present);
  pill.className = `pill ${hookReady ? "tag-runtime-ok" : "tag-runtime-warn"}`;
  pill.textContent = hookReady
    ? "Tracking hook ready"
    : "Tracking hook not initialized yet";
}

function getFilters() {
  return {
    search: normalizeText(document.getElementById("searchInput").value).toLowerCase(),
    status: document.getElementById("statusFilter").value,
  };
}

function filterTickets() {
  const filters = getFilters();

  return state.tickets.filter((ticket) => {
    const searchable = [
      ticket.ticket_subject,
      ticket.requester_email,
      ticket.requester_name,
      ticket.latest_message_subject,
      String(ticket.ticket_id),
    ]
      .join(" ")
      .toLowerCase();

    if (filters.search && !searchable.includes(filters.search)) {
      return false;
    }

    if (filters.status === "read" && !(Number(ticket.read_count) > 0)) {
      return false;
    }

    if (filters.status === "unread" && !(Number(ticket.unread_count) > 0)) {
      return false;
    }

    if (filters.status === "blacklisted" && !(Number(ticket.blacklisted_open_count) > 0)) {
      return false;
    }

    return true;
  });
}

function renderTickets() {
  const loadingEl = document.getElementById("ticketsLoading");
  const emptyEl = document.getElementById("ticketsEmpty");
  const table = document.getElementById("ticketsTable");
  const tbody = document.getElementById("ticketsTableBody");

  if (state.loading) {
    loadingEl.classList.remove("hidden");
    table.classList.add("hidden");
    emptyEl.classList.add("hidden");
    return;
  }

  const filteredTickets = filterTickets();
  if (!filteredTickets.length) {
    loadingEl.classList.add("hidden");
    table.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  loadingEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  table.classList.remove("hidden");

  tbody.innerHTML = filteredTickets
    .map((ticket) => {
      const latestStatusClass = Number(ticket.read_count) > 0 ? "tag-read" : "tag-unread";
      const latestStatusText = Number(ticket.read_count) > 0 ? "Read" : "Unread";
      const blacklistTag = Number(ticket.blacklisted_open_count) > 0
        ? `<span class="tag tag-blacklisted">${escapeHtml(`${ticket.blacklisted_open_count} blacklisted`)}</span>`
        : "";

      return [
        "<tr>",
        `<td><div class="stack"><strong>#${escapeHtml(ticket.ticket_id)}</strong><span class="muted">${escapeHtml(ticket.ticket_subject || "Untitled ticket")}</span></div></td>`,
        `<td><div class="stack"><strong>${escapeHtml(ticket.requester_name || "Requester")}</strong><span class="muted">${escapeHtml(ticket.requester_email || "No email")}</span></div></td>`,
        `<td><div class="stack"><span class="tag ${latestStatusClass}">${latestStatusText}</span>${blacklistTag}</div></td>`,
        `<td>${escapeHtml(ticket.tracked_count || 0)}</td>`,
        `<td>${escapeHtml(ticket.total_open_count || 0)}</td>`,
        `<td>${escapeHtml(formatDate(ticket.first_opened_at))}</td>`,
        `<td>${escapeHtml(formatDate(ticket.last_opened_at))}</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
}

function filterEvents() {
  const filters = getFilters();
  return state.recentEvents.filter((eventRecord) => {
    const searchable = [
      eventRecord.ticket_subject,
      eventRecord.requester_email,
      eventRecord.reply_subject,
      String(eventRecord.ticket_id),
      eventRecord.browser,
      eventRecord.source_ip,
    ]
      .join(" ")
      .toLowerCase();

    if (filters.search && !searchable.includes(filters.search)) {
      return false;
    }

    if (filters.status === "read" && eventRecord.blacklisted) {
      return false;
    }

    if (filters.status === "blacklisted" && !eventRecord.blacklisted) {
      return false;
    }

    return true;
  });
}

function renderEvents() {
  const events = filterEvents();
  const eventsList = document.getElementById("eventsList");
  const emptyEl = document.getElementById("eventsEmpty");

  if (!events.length) {
    eventsList.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  eventsList.innerHTML = events.slice(0, 30).map((eventRecord) => {
    const statusTag = eventRecord.blacklisted
      ? '<span class="tag tag-blacklisted">Blacklisted</span>'
      : '<span class="tag tag-read">Counted</span>';

    return [
      '<div class="event-card">',
      `<div><strong>#${escapeHtml(eventRecord.ticket_id)}</strong> ${escapeHtml(eventRecord.ticket_subject || "")}</div>`,
      `<div class="muted" style="margin-top:6px;">${escapeHtml(eventRecord.reply_subject || "Tracked reply")}</div>`,
      `<div class="event-meta">${statusTag}<span>${escapeHtml(formatDate(eventRecord.occurred_at))}</span><span>${escapeHtml(eventRecord.browser || "Unknown browser")}</span><span>${escapeHtml(eventRecord.source_ip || "Unknown IP")}</span></div>`,
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
  if (!value) return "Not opened";
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
