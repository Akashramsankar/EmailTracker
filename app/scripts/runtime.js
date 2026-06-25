let client;
const state = {
  ticketId: 0,
  ticketSubject: "",
  requesterEmail: "",
  requesterName: "",
  lastSignature: "",
  runtimeReady: false,
  interceptRegistered: false,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    registerSendReplyIntercept();
    await syncLiveTicketFieldMetadata(true);

    client.events.on("app.activated", () => {
      void logServerDiagnostic("runtime_activated", {
        ticket_id: state.ticketId,
      });
      void syncLiveTicketFieldMetadata(true);
    });

    client.events.on("ticket.propertiesUpdated", () => {
      window.setTimeout(() => {
        void syncLiveTicketFieldMetadata(true);
      }, 1000);
    });
  } catch (error) {
    console.error("Runtime init failed:", error);
  }
}

async function getCurrentTicket() {
  const response = await client.data.get("ticket");
  return response && response.ticket ? response.ticket : response;
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function humanizeFieldName(value) {
  return normalizeText(value)
    .replace(/^cf_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectOptionRecords(input, bucket) {
  if (input === null || input === undefined) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectOptionRecords(item, bucket));
    return;
  }

  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    const value = normalizeText(input);
    if (value) {
      bucket.push({ value, label: value });
    }
    return;
  }

  if (typeof input !== "object") {
    return;
  }

  const directValue = normalizeText(
    input.value !== undefined && input.value !== null ? input.value : input.id
  );
  const directLabel = normalizeText(
    input.label !== undefined && input.label !== null
      ? input.label
      : input.name !== undefined && input.name !== null
        ? input.name
        : input.text
  );

  if (directValue || directLabel) {
    bucket.push({
      value: directValue || directLabel,
      label: directLabel || directValue,
    });
  }

  Object.keys(input).forEach((key) => {
    const nested = [];
    collectOptionRecords(input[key], nested);
    if (nested.length) {
      bucket.push(...nested);
    }
  });
}

function dedupeOptionRecords(options) {
  const unique = [];
  const seen = new Set();

  (Array.isArray(options) ? options : []).forEach((option) => {
    const value = normalizeText(option && option.value);
    const label = normalizeText(option && option.label) || value;
    const key = `${value.toLowerCase()}::${label.toLowerCase()}`;
    if (!value || seen.has(key)) {
      return;
    }

    seen.add(key);
    unique.push({ value, label });
  });

  return unique;
}

async function fetchFieldOptions(fieldName) {
  const lookupNames = fieldName === "ticket_type"
    ? ["ticket_type_options", "type_options"]
    : [`${fieldName}_options`];

  for (const objectName of lookupNames) {
    try {
      const response = await client.data.get(objectName);
      const rawOptions = response && Object.prototype.hasOwnProperty.call(response, objectName)
        ? response[objectName]
        : response;
      const options = [];
      collectOptionRecords(rawOptions, options);
      const deduped = dedupeOptionRecords(options);
      if (deduped.length) {
        return deduped;
      }
    } catch {
      // Not every field has a runtime options object.
    }
  }

  return [];
}

function buildSignature(ticket) {
  const customFieldKeys = Object.keys((ticket && ticket.custom_fields) || {}).sort();
  return [normalizeText(ticket && ticket.id), ...customFieldKeys].join("|");
}

async function buildLiveFields(ticket) {
  const fieldNames = Array.from(new Set([
    "status",
    "priority",
    "ticket_type",
    ...Object.keys((ticket && ticket.custom_fields) || {}),
  ]));

  const fields = [];
  for (const fieldName of fieldNames) {
    const options = await fetchFieldOptions(fieldName);
    fields.push({
      id: fieldName,
      name: fieldName,
      label: fieldName === "ticket_type" ? "Type" : humanizeFieldName(fieldName),
      type: fieldName.startsWith("cf_") ? "custom_field" : "dropdown",
      options,
      source: "ticket_background_live",
      updated_at: Date.now(),
    });
  }

  return fields;
}

async function syncLiveTicketFieldMetadata(force) {
  const ticket = await getCurrentTicket();
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
    return;
  }

  const signature = buildSignature(ticket);
  if (!force && signature === state.lastSignature) {
    return;
  }

  state.lastSignature = signature;
  const fields = await buildLiveFields(ticket);
  await client.request.invoke("syncLiveTicketFieldMetadata", {
    fields,
  });

  await hydrateTrackingRuntime();
}

function registerSendReplyIntercept() {
  if (state.interceptRegistered) {
    return;
  }

  client.events.on("ticket.sendReply", handleRuntimeSendReplyIntercept, { intercept: true });
  state.interceptRegistered = true;
  void logServerDiagnostic("runtime_send_reply_intercept_registered", {
    ticket_id: state.ticketId,
  });
}

async function hydrateTrackingRuntime() {
  if (!state.ticketId) {
    return;
  }

  try {
    const response = await client.request.invoke("getTicketTrackerData", {
      ticket_id: state.ticketId,
    });
    const payload = parseInvokeResponse(response);
    state.runtimeReady = Boolean(
      payload &&
        payload.success !== false &&
        payload.runtime &&
        payload.runtime.external_hook_url_present &&
        payload.runtime.bridge_public_url
    );
    void logServerDiagnostic("runtime_tracking_hydrated", {
      ticket_id: state.ticketId,
      runtime_ready: state.runtimeReady,
      tracked_count: Number(payload && payload.summary && payload.summary.tracked_count) || 0,
    });
  } catch (error) {
    state.runtimeReady = false;
    void logServerDiagnostic("runtime_tracking_hydrate_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to hydrate runtime tracking state."),
    });
  }
}

function handleRuntimeSendReplyIntercept(event) {
  try {
    void logServerDiagnostic("runtime_send_reply_intercept_fired", {
      ticket_id: state.ticketId,
      runtime_ready: state.runtimeReady,
    });

    const eventData = getEventData(event);
    const helperMethods = getHelperMethods(event);
    void logServerDiagnostic("native_send_allowed_untracked", {
      ticket_id: state.ticketId,
      ...summarizeNativeSendData(eventData),
      already_tracked: hasTrackingToken(eventData),
      helper_methods: helperMethods.join(","),
    });
    doneIntercept(event);
  } catch (error) {
    void logServerDiagnostic("runtime_send_reply_intercept_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to log native send pass-through."),
    });
    doneIntercept(event);
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

function getEventData(event) {
  try {
    return event && event.helper && typeof event.helper.getData === "function"
      ? event.helper.getData() || {}
      : {};
  } catch (error) {
    void logServerDiagnostic("runtime_send_reply_get_data_failed", {
      ticket_id: state.ticketId,
      error: resolveErrorMessage(error, "Unable to read send reply event data."),
    });
    return {};
  }
}

function doneIntercept(event) {
  if (event && event.helper && typeof event.helper.done === "function") {
    Promise.resolve(event.helper.done()).catch((error) => {
      void logServerDiagnostic("runtime_helper_done_failed", {
        ticket_id: state.ticketId,
        error: resolveErrorMessage(error, "Intercept helper done failed."),
      });
    });
  }
}

function hasTrackingToken(eventData) {
  const source = [
    eventData && eventData.body,
    eventData && eventData.full_text,
  ].map(normalizeText).join("\n");

  return /data-email-tracker-token=["']?[a-f0-9]{32}/i.test(source) ||
    /token=[a-f0-9]{32}/i.test(source);
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

function resolveErrorMessage(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function logServerDiagnostic(eventName, details) {
  if (!client || !client.request || typeof client.request.invoke !== "function") {
    return Promise.resolve();
  }

  return client.request.invoke("logNativeReplyClientEvent", {
    event_name: eventName,
    details: details || {},
  }).catch((error) => {
    console.error("Unable to write runtime native reply diagnostic log:", error);
  });
}
