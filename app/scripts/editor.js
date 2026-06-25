let client;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const state = {
  ticketId: 0,
  ticketSubject: "",
  requesterEmail: "",
  requesterName: "",
  loading: true,
  runtimeReady: false,
  senderOptions: [],
  interceptRegistered: false,
  sending: false,
  lastHelperError: "",
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    void logServerDiagnostic("editor_initialized", {
      location: "ticket_conversation_editor",
    });
    bindEvents();
    registerSendReplyIntercept();

    client.events.on("app.activated", () => {
      void logServerDiagnostic("editor_activated", {
        ticket_id: state.ticketId,
      });
      void hydrate(true);
    });

    await hydrate(false);
  } catch (error) {
    console.error("Native reply tracker init failed:", error);
    void logServerDiagnostic("editor_init_failed", {
      error: resolveErrorMessage(error, "Unable to load native reply tracking."),
    });
    setStatus(resolveErrorMessage(error, "Unable to load native reply tracking."));
  }
}

function bindEvents() {
  document.getElementById("editorSendTrackedReplyBtn").addEventListener("click", () => {
    void sendTrackedReplyFromEditor();
  });

  document.getElementById("editorAttachments").addEventListener("change", renderAttachmentList);

  document.getElementById("refreshEditorBtn").addEventListener("click", () => {
    void logServerDiagnostic("editor_refresh_clicked", {
      ticket_id: state.ticketId,
    });
    void hydrate(false);
  });
}

function registerSendReplyIntercept() {
  if (state.interceptRegistered) {
    return;
  }

  client.events.on("ticket.sendReply", handleSendReplyIntercept, { intercept: true });
  state.interceptRegistered = true;
  void logServerDiagnostic("send_reply_intercept_registered", {
    ticket_id: state.ticketId,
  });
}

async function hydrate(silent) {
  state.loading = true;
  void logServerDiagnostic("hydrate_started", {
    ticket_id: state.ticketId,
    silent: Boolean(silent),
  });
  if (!silent) {
    render();
  }

  try {
    const ticketData = await client.data.get("ticket");
    const ticket = ticketData && ticketData.ticket ? ticketData.ticket : ticketData;
    state.ticketId = Number(ticket && ticket.id) || 0;
    state.ticketSubject = normalizeText(ticket && ticket.subject);
    state.requesterEmail = normalizeText(
      ticket && ticket.requester
        ? ticket.requester.email || ticket.requester.primary_email
        : ticket && ticket.email
    );
    state.requesterName = normalizeText(
      ticket && ticket.requester
        ? ticket.requester.name || ticket.requester.email
        : ticket && ticket.requester_name
    );

    if (!state.ticketId) {
      throw new Error("Ticket context is unavailable in the conversation editor.");
    }
    void logServerDiagnostic("hydrate_ticket_context_loaded", {
      ticket_id: state.ticketId,
    });

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
    state.senderOptions = Array.isArray(payload.sender_options) ? payload.sender_options : [];

    void logServerDiagnostic("hydrate_completed", {
      ticket_id: state.ticketId,
      runtime_ready: state.runtimeReady,
      hook_present: Boolean(payload.runtime && payload.runtime.external_hook_url_present),
      bridge_present: Boolean(payload.runtime && payload.runtime.bridge_public_url),
      tracked_count: Number(payload.summary && payload.summary.tracked_count) || 0,
      messages_count: Array.isArray(payload.messages) ? payload.messages.length : 0,
    });

    if (state.runtimeReady) {
      setStatus("Tracking is ready. Use Email Tracker's send button for tracked replies.", true);
    } else {
      setStatus("Tracking setup is not ready yet. Refresh the ticket or reinstall the app first.");
    }
  } catch (error) {
    console.error("Unable to hydrate native reply tracker:", error);
    void logServerDiagnostic("hydrate_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to prepare native reply tracking."),
    });
    setStatus(resolveErrorMessage(error, "Unable to prepare native reply tracking."));
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  const modePill = document.getElementById("editorModePill");
  const refreshButton = document.getElementById("refreshEditorBtn");
  const sendButton = document.getElementById("editorSendTrackedReplyBtn");
  const attachmentInput = document.getElementById("editorAttachments");

  modePill.textContent = state.runtimeReady ? "Tracking Ready" : "Setup Needed";
  refreshButton.disabled = state.loading || state.sending;
  sendButton.disabled = state.loading || state.sending || !state.runtimeReady;
  attachmentInput.disabled = state.loading || state.sending || !state.runtimeReady;
  sendButton.textContent = state.sending ? "Sending..." : "Send Tracked Reply";
  renderSenderOptions();
  renderAttachmentList();
}

function renderSenderOptions() {
  const select = document.getElementById("editorSenderSelect");
  const currentValue = select.value;
  const options = ['<option value="">Default mailbox</option>']
    .concat(state.senderOptions.map((option) => {
      return `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
    }));
  select.innerHTML = options.join("");
  select.value = currentValue;
}

function getSelectedFiles() {
  const input = document.getElementById("editorAttachments");
  return Array.from(input && input.files ? input.files : []);
}

function formatFileSize(size) {
  if (!size) return "0 KB";
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function validateSelectedFiles(files) {
  let totalSize = 0;

  if (files.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach up to ${MAX_ATTACHMENTS} files per tracked reply.`);
  }

  files.forEach((file) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB file limit.`);
    }

    totalSize += file.size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed the ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB total limit.`);
    }
  });
}

function renderAttachmentList() {
  const list = document.getElementById("editorAttachmentList");
  if (!list) {
    return;
  }

  const files = getSelectedFiles();
  try {
    validateSelectedFiles(files);
    list.innerHTML = files.map((file) => {
      return `<div>${escapeHtml(file.name)} (${escapeHtml(formatFileSize(file.size))})</div>`;
    }).join("");
  } catch (error) {
    list.innerHTML = `<div>${escapeHtml(resolveErrorMessage(error, "Invalid attachment selection."))}</div>`;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error(`Unable to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function readSelectedAttachments() {
  const files = getSelectedFiles();
  validateSelectedFiles(files);

  return await Promise.all(files.map(async (file) => ({
    filename: file.name,
    content_type: file.type || "application/octet-stream",
    size: file.size,
    data_base64: await readFileAsBase64(file),
  })));
}

async function sendTrackedReplyFromEditor() {
  if (state.sending) {
    return;
  }

  const bodyText = normalizeText(document.getElementById("editorReplyBody").value);
  if (!bodyText) {
    notify("error", "Reply body is required.");
    return;
  }

  if (!state.ticketId || !state.runtimeReady) {
    await hydrate(true);
  }

  if (!state.ticketId || !state.runtimeReady) {
    notify("error", "Tracking setup is not ready yet. Refresh the ticket and try again.");
    return;
  }

  state.sending = true;
  render();
  setStatus("Sending tracked reply...");

  try {
    const attachments = await readSelectedAttachments();
    const response = await client.request.invoke("sendTrackedReply", {
      ticket_id: state.ticketId,
      body_text: bodyText,
      sender_email: document.getElementById("editorSenderSelect").value,
      attachments,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to send the tracked reply.");
    }

    document.getElementById("editorReplyBody").value = "";
    document.getElementById("editorAttachments").value = "";
    renderAttachmentList();
    setStatus("Tracked reply sent.", true);
    notify("success", "Tracked reply sent.");
    await hydrate(true);
  } catch (error) {
    const message = resolveErrorMessage(error, "Unable to send the tracked reply.");
    console.error("Unable to send tracked reply from editor:", error);
    setStatus(message);
    notify("error", message);
  } finally {
    state.sending = false;
    render();
  }
}

function handleSendReplyIntercept(event) {
  try {
    void logServerDiagnostic("send_reply_intercept_fired", {
      ticket_id: state.ticketId,
      runtime_ready: state.runtimeReady,
    });

    const eventData = safeGetEventData(event);
    const helperMethods = getHelperMethods(event);
    void logServerDiagnostic("native_send_allowed_untracked", {
      ticket_id: state.ticketId,
      ...summarizeNativeSendData(eventData),
      already_tracked: hasTrackingToken(eventData),
      helper_methods: helperMethods.join(","),
    });
    safeDone(event);
  } catch (error) {
    console.error("Unable to log native reply pass-through:", error);
    void logServerDiagnostic("send_reply_intercept_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to log native send pass-through."),
    });
    safeDone(event);
  }
}

function safeGetEventData(event) {
  try {
    return event && event.helper && typeof event.helper.getData === "function"
      ? event.helper.getData() || {}
      : {};
  } catch (error) {
    void logServerDiagnostic("send_reply_get_data_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to read send reply event data."),
    });
    return {};
  }
}

function getHelperMethods(event) {
  const helper = event && event.helper;
  if (!helper) {
    return [];
  }

  const methodNames = new Set();
  Object.keys(helper).forEach((key) => {
    if (typeof helper[key] === "function") {
      methodNames.add(key);
    }
  });

  [
    "getData",
    "setData",
    "updateData",
    "setValue",
    "done",
    "fail",
  ].forEach((key) => {
    if (typeof helper[key] === "function") {
      methodNames.add(key);
    }
  });

  return Array.from(methodNames).sort();
}

function summarizeNativeSendData(eventData) {
  const data = eventData && typeof eventData === "object" ? eventData : {};
  const bodyHtml = getFirstText(data, ["body_html", "bodyHtml", "html_body", "htmlBody"]);
  const body = getFirstText(data, ["body"]);
  const fullText = getFirstText(data, ["full_text", "fullText"]);
  const ccEmails = getEmailList(data, ["cc_emails", "ccEmails", "cc"]);
  const bccEmails = getEmailList(data, ["bcc_emails", "bccEmails", "bcc"]);
  const attachments = getAttachmentList(data);
  const attachmentSummary = summarizeAttachments(attachments);

  return {
    data_keys: Object.keys(data).sort().slice(0, 24).join(","),
    body_chars: body.length,
    body_html_chars: bodyHtml.length,
    full_text_chars: fullText.length,
    cc_count: ccEmails.length,
    bcc_count: bccEmails.length,
    attachment_count: attachments.length,
    attachment_keys: attachmentSummary.keys,
    attachment_has_url: attachmentSummary.has_url,
    attachment_has_ref: attachmentSummary.has_ref,
    attachment_has_content: attachmentSummary.has_content,
    sender_present: Boolean(getSenderEmail(data)),
  };
}

function getFirstText(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = normalizeText(value);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function getSenderEmail(source) {
  return getFirstText(source, [
    "from_email",
    "fromEmail",
    "sender_email",
    "senderEmail",
    "support_email",
    "supportEmail",
    "from",
  ]);
}

function getEmailList(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    const emails = normalizeEmailList(value);
    if (emails.length) {
      return emails;
    }
  }
  return [];
}

function normalizeEmailList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        return normalizeText(item);
      }
      return normalizeText(item && (item.email || item.address || item.value));
    }).filter(Boolean);
  }

  return normalizeText(value).split(/[\n,;]+/).map(normalizeText).filter(Boolean);
}

function getAttachmentList(source) {
  const value = source && (source.attachments || source.attachment || source.files);
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}

function summarizeAttachments(attachments) {
  const keys = new Set();
  let hasUrl = false;
  let hasRef = false;
  let hasContent = false;

  (Array.isArray(attachments) ? attachments : []).forEach((attachment) => {
    if (!attachment || typeof attachment !== "object") {
      return;
    }

    Object.keys(attachment).forEach((key) => keys.add(key));
    hasUrl = hasUrl || Boolean(attachment.url || attachment.attachment_url || attachment.download_url || attachment.href);
    hasRef = hasRef || Boolean(attachment.ref || attachment.file_ref || attachment.object_ref || attachment.id);
    hasContent = hasContent || Boolean(attachment.content || attachment.data || attachment.base64 || attachment.blob || attachment.file);
  });

  return {
    keys: Array.from(keys).sort().slice(0, 24).join(","),
    has_url: hasUrl,
    has_ref: hasRef,
    has_content: hasContent,
  };
}

function safeDone(event) {
  if (event && event.helper && typeof event.helper.done === "function") {
    Promise.resolve(event.helper.done()).catch((error) => {
      rememberHelperError(error);
      void logServerDiagnostic("send_reply_helper_done_failed", {
        ticket_id: state.ticketId,
        error: resolveErrorMessage(error, "Intercept helper done failed."),
      });
    });
  } else {
    void logServerDiagnostic("send_reply_helper_done_missing", {
      ticket_id: state.ticketId,
    });
  }
}

function rememberHelperError(error) {
  state.lastHelperError = resolveErrorMessage(error, "Intercept helper failed.");
}

function hasTrackingToken(eventData) {
  const source = [
    eventData && eventData.body,
    eventData && eventData.full_text,
  ].map(normalizeText).join("\n");

  return /data-email-tracker-token=["']?[a-f0-9]{32}/i.test(source) ||
    /token=[a-f0-9]{32}/i.test(source);
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

function logServerDiagnostic(eventName, details) {
  if (!client || !client.request || typeof client.request.invoke !== "function") {
    return Promise.resolve();
  }

  return client.request.invoke("logNativeReplyClientEvent", {
    event_name: eventName,
    details: details || {},
  }).catch((error) => {
    console.error("Unable to write native reply diagnostic log:", error);
  });
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === null || value === undefined ? "" : String(value);
  return div.innerHTML;
}
