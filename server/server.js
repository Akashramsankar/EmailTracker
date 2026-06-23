const crypto = require("node:crypto");

const RUNTIME_KEY = "email_tracker_runtime_v1";
const MESSAGES_KEY = "email_tracker_messages_v1";
const LIVE_FIELD_METADATA_KEY = "email_tracker_live_field_metadata_v1";
const PAGE_SIZE = 100;
const MAX_TRACKED_MESSAGES = 1000;
const MAX_EVENTS_PER_MESSAGE = 80;
const EVENT_HOOK_OPTION = "email-tracker-open-v1";
const DEFAULT_PUBLIC_TRACKER_BRIDGE_URL = normalizeUrl("https://email-tracker-bridge.onrender.com");
const DEFAULT_BRIDGE_SECRET = "dev-email-tracker-bridge-secret";
const TRACKING_TOKEN_PATTERN = /(?:data-email-tracker-token=["']|token=)([a-f0-9]{32})/gi;

function parseArgs(args) {
  if (!args) {
    return {};
  }

  if (typeof args.body === "string") {
    try {
      return JSON.parse(args.body);
    } catch {
      return {};
    }
  }

  if (args.body && typeof args.body === "object") {
    return args.body;
  }

  return args;
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function normalizeBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === "") {
    return Boolean(fallbackValue);
  }

  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }

  return Boolean(fallbackValue);
}

function splitLinesAndCsv(value) {
  return normalizeText(value)
    .split(/[\n,]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function uniqueStrings(items) {
  const seen = new Set();
  const result = [];

  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(normalized);
  });

  return result;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value) {
  return normalizeText(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildToken() {
  return crypto.randomBytes(16).toString("hex");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildRelaySignature(token, hookUrl, secret) {
  return hashValue([normalizeText(token), normalizeUrl(hookUrl), normalizeText(secret)].join("|"));
}

function getHeaderCaseInsensitive(headers, headerName) {
  if (!headers || !headerName) {
    return "";
  }

  if (Object.prototype.hasOwnProperty.call(headers, headerName)) {
    return headers[headerName];
  }

  const target = headerName.toLowerCase();
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === target);
  return matchingKey ? headers[matchingKey] : "";
}

function getErrorResponseBody(error) {
  return error && (error.response || error.responseText || error.body || "");
}

function buildErrorMessage(error, fallback) {
  if (!error) {
    return fallback || "Unknown error.";
  }

  const parts = [];
  if (error.status) {
    parts.push(`Status ${error.status}`);
  }

  if (error.message && error.message !== "UNKNOWN ERROR") {
    parts.push(String(error.message));
  }

  const responseBody = getErrorResponseBody(error);
  if (responseBody) {
    try {
      const parsed = typeof responseBody === "string" ? JSON.parse(responseBody) : responseBody;
      parts.push(
        parsed.description ||
          parsed.message ||
          (Array.isArray(parsed.errors) ? parsed.errors.join("; ") : JSON.stringify(parsed))
      );
    } catch {
      parts.push(String(responseBody));
    }
  }

  if (!parts.length) {
    parts.push(fallback || "Unknown error.");
  }

  return parts.join(" - ");
}

function buildResponse(data) {
  return renderData(null, data);
}

function buildErrorResponse(message, error) {
  const detail = buildErrorMessage(error, message);
  console.error(message, {
    detail,
    status: error && error.status,
    response: getErrorResponseBody(error),
    stack: error && error.stack,
  });

  return renderData(null, {
    success: false,
    message,
    detail,
  });
}

function getIparams(args) {
  return (args && args.iparams) || {};
}

function getAppSettings(args) {
  return (args && args.app_settings) || {};
}

function resolveBridgeUrl(args) {
  const iparams = getIparams(args);
  const appSettings = getAppSettings(args);
  return normalizeUrl(
    iparams.bridge_public_url ||
      appSettings.bridge_public_url ||
      DEFAULT_PUBLIC_TRACKER_BRIDGE_URL
  );
}

function resolveBridgeSecret(args) {
  const iparams = getIparams(args);
  const appSettings = getAppSettings(args);
  return normalizeText(
    iparams.bridge_secret ||
      appSettings.bridge_secret ||
      DEFAULT_BRIDGE_SECRET
  );
}

function shouldWriteFirstOpenNote(args) {
  const iparams = getIparams(args);
  const appSettings = getAppSettings(args);
  return normalizeBoolean(
    iparams.note_on_first_open !== undefined ? iparams.note_on_first_open : appSettings.note_on_first_open,
    true
  );
}

function getBlacklistEntries(args) {
  const iparams = getIparams(args);
  const appSettings = getAppSettings(args);
  return uniqueStrings(
    splitLinesAndCsv(iparams.ip_blacklist || appSettings.ip_blacklist)
  );
}

function mapFieldOptionEntry(value, label) {
  const normalizedValue = normalizeText(value);
  const normalizedLabel = normalizeText(label) || normalizedValue;
  if (!normalizedValue && !normalizedLabel) {
    return null;
  }

  return {
    value: normalizedValue || normalizedLabel,
    label: normalizedLabel || normalizedValue,
  };
}

function extractFieldOptions(field) {
  const rawOptions = [];

  if (Array.isArray(field && field.choices)) {
    field.choices.forEach((choice) => rawOptions.push(choice));
  }

  if (Array.isArray(field && field.options)) {
    field.options.forEach((choice) => rawOptions.push(choice));
  }

  const mapped = rawOptions
    .map((choice) => {
      if (choice && typeof choice === "object") {
        return mapFieldOptionEntry(
          choice.value !== undefined ? choice.value : choice.id,
          choice.label || choice.name || choice.value || choice.text
        );
      }
      return mapFieldOptionEntry(choice, choice);
    })
    .filter(Boolean);

  const seen = new Set();
  return mapped.filter((item) => {
    const key = `${normalizeLower(item.value)}::${normalizeLower(item.label)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeFieldDefinition(field) {
  const name = normalizeText(field && (field.name || field.id));
  if (!name) {
    return null;
  }

  return {
    id: normalizeText(field && field.id) || name,
    name,
    label: normalizeText(
      field &&
        (field.label_for_agents ||
          field.label ||
          field.label_for_customers ||
          field.title ||
          name)
    ),
    type: normalizeLower(field && (field.type || field.field_type || field.widget_type || "")),
    default: Boolean(field && (field.default || field.system)),
    options: extractFieldOptions(field),
  };
}

function normalizeFieldCollection(collection) {
  const seen = new Set();
  return (Array.isArray(collection) ? collection : [])
    .map(normalizeFieldDefinition)
    .filter(Boolean)
    .filter((field) => {
      const key = normalizeLower(field.name);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function readDbJson(key, fallbackValue) {
  try {
    return await $db.get(key);
  } catch (error) {
    if (error && error.status === 404) {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeDbJson(key, value) {
  await $db.set(key, value);
}

async function invokeRequestTemplate(name, options) {
  const requestOptions = {};

  if (options && Object.prototype.hasOwnProperty.call(options, "context")) {
    requestOptions.context = options.context || {};
  } else {
    requestOptions.context = options || {};
  }

  if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
    requestOptions.body =
      typeof options.body === "string" ? options.body : JSON.stringify(options.body || {});
  }

  let response;
  try {
    response = await $request.invokeTemplate(name, requestOptions);
  } catch (error) {
    error.request_template = name;
    error.request_context = requestOptions.context || {};
    throw error;
  }

  try {
    return JSON.parse(response.response || "null");
  } catch {
    return response.response;
  }
}

async function fetchPaginated(templateName, context) {
  const items = [];

  for (let page = 1; page < 50; page += 1) {
    const pageItems = await invokeRequestTemplate(templateName, {
      ...(context || {}),
      page,
      per_page: PAGE_SIZE,
    });

    if (!Array.isArray(pageItems) || !pageItems.length) {
      break;
    }

    items.push(...pageItems);

    if (pageItems.length < PAGE_SIZE) {
      break;
    }
  }

  return items;
}

async function readRuntimeConfig() {
  return await readDbJson(RUNTIME_KEY, {});
}

async function writeRuntimeConfig(value) {
  await writeDbJson(RUNTIME_KEY, value);
}

async function readTrackedMessages() {
  const stored = await readDbJson(MESSAGES_KEY, { items: [] });
  return Array.isArray(stored && stored.items) ? stored.items : [];
}

async function writeTrackedMessages(items) {
  const sorted = [...(Array.isArray(items) ? items : [])]
    .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0))
    .slice(0, MAX_TRACKED_MESSAGES);
  await writeDbJson(MESSAGES_KEY, { items: sorted });
}

async function readLiveFieldMetadata() {
  const stored = await readDbJson(LIVE_FIELD_METADATA_KEY, { fields: [] });
  return Array.isArray(stored && stored.fields) ? stored.fields : [];
}

async function writeLiveFieldMetadata(fields) {
  await writeDbJson(LIVE_FIELD_METADATA_KEY, {
    fields: Array.isArray(fields) ? fields : [],
  });
}

function buildPixelUrl(runtimeConfig, token, args) {
  const bridgeUrl = normalizeUrl(runtimeConfig && runtimeConfig.bridge_public_url);
  const hookUrl = normalizeText(runtimeConfig && runtimeConfig.external_hook_url);
  const secret = resolveBridgeSecret(args);

  if (!bridgeUrl || !hookUrl) {
    return "";
  }

  const signature = buildRelaySignature(token, hookUrl, secret);
  const params = new URLSearchParams({
    token,
    hook: hookUrl,
    sig: signature,
  });

  return `${bridgeUrl}/pixel?${params.toString()}`;
}

function buildTrackedEmailHtml(bodyText, pixelUrl) {
  const safeBody = escapeHtml(bodyText).replace(/\n/g, "<br>");
  const pixelMarkup = pixelUrl
    ? `<img src="${escapeHtml(pixelUrl)}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />`
    : "";

  return [
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#17324d;">',
    `<div>${safeBody || " "}</div>`,
    pixelMarkup,
    "</div>",
  ].join("");
}

function buildTrackedEditorHtmlSnippet(pixelUrl, token) {
  if (!pixelUrl || !token) {
    return "";
  }

  return [
    `<span data-email-tracker-token="${escapeHtml(token)}" style="display:none!important;visibility:hidden;opacity:0;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;">${escapeHtml(token)}</span>`,
    `<img src="${escapeHtml(pixelUrl)}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />`,
  ].join("");
}

function extractTrackingTokenFromBody(bodyHtml) {
  const source = String(bodyHtml === null || bodyHtml === undefined ? "" : bodyHtml);
  const matches = Array.from(source.matchAll(TRACKING_TOKEN_PATTERN));
  if (!matches.length) {
    return "";
  }

  const latestMatch = matches[matches.length - 1];
  return normalizeText(latestMatch && latestMatch[1]);
}

function isOutboundEmailConversation(conversation) {
  if (!conversation || conversation.incoming || conversation.private) {
    return false;
  }

  const kind = normalizeLower(conversation.kind);
  const categoryName = normalizeLower(conversation.category && conversation.category.name);
  const source = Number(conversation.source);

  if (kind.includes("reply") || kind.includes("forward")) {
    return true;
  }

  if (kind.includes("note") || categoryName.includes("note")) {
    return false;
  }

  if (categoryName.includes("response") || categoryName.includes("reply") || categoryName.includes("forward")) {
    return true;
  }

  return source === 2;
}

function buildTrackedMessageFromConversation(conversation, ticket, token) {
  const requesterInfo = getRequesterInfo(ticket);
  const createdAt = normalizeText(conversation && conversation.created_at);

  return {
    id: createId("msg"),
    token,
    ticket_id: Number(conversation && conversation.ticket_id) || Number(ticket && ticket.id) || 0,
    ticket_subject: normalizeText(ticket && ticket.subject),
    requester_email: requesterInfo.email,
    requester_name: requesterInfo.name,
    reply_subject: normalizeText(ticket && ticket.subject) || `Ticket #${Number(ticket && ticket.id) || 0}`,
    body_preview: truncate(
      normalizeText(conversation && conversation.body_text) || stripHtml(conversation && conversation.body),
      240
    ),
    created_at: createdAt ? Date.parse(createdAt) || Date.now() : Date.now(),
    open_count: 0,
    unique_open_count: 0,
    blacklisted_open_count: 0,
    first_opened_at: "",
    last_opened_at: "",
    first_open_note_added_at: 0,
    opens: [],
    sender_email: normalizeText(
      conversation && (conversation.from_email || conversation.support_email)
    ),
    sender_fallback_used: false,
    send_response_id: Number(conversation && conversation.id) || 0,
    conversation_kind: normalizeText(conversation && conversation.kind),
    conversation_source: Number(conversation && conversation.source) || 0,
  };
}

function parseEventBrowser(userAgent) {
  const agent = normalizeLower(userAgent);
  if (!agent) {
    return "Unknown";
  }

  if (agent.includes("edg/")) return "Edge";
  if (agent.includes("chrome/")) return "Chrome";
  if (agent.includes("firefox/")) return "Firefox";
  if (agent.includes("safari/") && !agent.includes("chrome/")) return "Safari";
  if (agent.includes("outlook")) return "Outlook";
  if (agent.includes("applewebkit")) return "WebKit";
  return "Unknown";
}

function parseEventDevice(userAgent) {
  const agent = normalizeLower(userAgent);
  if (!agent) {
    return "Unknown";
  }

  if (agent.includes("iphone") || agent.includes("android") || agent.includes("mobile")) {
    return "Mobile";
  }

  if (agent.includes("ipad") || agent.includes("tablet")) {
    return "Tablet";
  }

  return "Desktop";
}

function extractSourceIp(payload, headers) {
  const headerValue =
    getHeaderCaseInsensitive(headers, "x-forwarded-for") ||
    getHeaderCaseInsensitive(headers, "x-real-ip") ||
    payload.source_ip ||
    payload.ip;

  return normalizeText(String(headerValue || "").split(",")[0]);
}

function buildEventFingerprint(sourceIp, userAgent) {
  return hashValue(`${normalizeLower(sourceIp)}|${normalizeLower(userAgent)}`);
}

function isBlacklistedIp(sourceIp, blacklistEntries) {
  const normalizedIp = normalizeLower(sourceIp);
  if (!normalizedIp) {
    return false;
  }

  return (Array.isArray(blacklistEntries) ? blacklistEntries : []).some((entry) => {
    const normalizedEntry = normalizeLower(entry);
    return normalizedEntry && normalizedIp.includes(normalizedEntry);
  });
}

function getRequesterInfo(ticket) {
  const requester = (ticket && ticket.requester) || {};
  const fallbackName = normalizeText(ticket && ticket.requester_name);

  return {
    email: normalizeText(requester.email || requester.primary_email || ticket.email),
    name: normalizeText(requester.name || fallbackName || requester.email),
  };
}

function buildSenderOptions(emailConfigs) {
  return (Array.isArray(emailConfigs) ? emailConfigs : [])
    .filter((config) => config && config.active && normalizeText(config.reply_email))
    .map((config) => ({
      value: normalizeText(config.reply_email),
      label: normalizeText(config.name)
        ? `${normalizeText(config.name)} - ${normalizeText(config.reply_email)}`
        : normalizeText(config.reply_email),
    }));
}

async function fetchTicket(ticketId) {
  return await invokeRequestTemplate("get_ticket", {
    ticket_id: ticketId,
  });
}

async function fetchReplySenderOptions() {
  try {
    return buildSenderOptions(await invokeRequestTemplate("list_email_configs", {}));
  } catch (error) {
    console.warn("Unable to load reply sender options:", buildErrorMessage(error, "Unable to list email configs."));
    return [];
  }
}

async function fetchTicketFieldDefinitions(args) {
  try {
    const direct = await invokeRequestTemplate("list_admin_ticket_fields", {});
    const normalizedDirect = normalizeFieldCollection(direct);
    if (normalizedDirect.length) {
      return mergeFieldDefinitions(normalizedDirect, await readLiveFieldMetadata());
    }
  } catch (error) {
    console.warn("Unable to load admin ticket fields:", buildErrorMessage(error, "Unable to load admin ticket fields."));
  }

  try {
    const paginated = await fetchPaginated("list_ticket_fields", {});
    return mergeFieldDefinitions(normalizeFieldCollection(paginated), await readLiveFieldMetadata());
  } catch (error) {
    console.warn("Unable to load public ticket fields:", buildErrorMessage(error, "Unable to load ticket fields."));
  }

  return mergeFieldDefinitions([], await readLiveFieldMetadata());
}

function mergeFieldDefinitions(primaryFields, liveFields) {
  const map = new Map();

  (Array.isArray(primaryFields) ? primaryFields : []).forEach((field) => {
    map.set(normalizeLower(field.name), field);
  });

  (Array.isArray(liveFields) ? liveFields : []).forEach((field) => {
    const normalized = normalizeFieldDefinition(field);
    if (!normalized) {
      return;
    }

    const key = normalizeLower(normalized.name);
    if (!map.has(key)) {
      map.set(key, normalized);
      return;
    }

    const current = map.get(key);
    map.set(key, {
      ...current,
      options: current.options && current.options.length ? current.options : normalized.options,
      type: current.type || normalized.type,
      label: current.label || normalized.label,
    });
  });

  return Array.from(map.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function lookupFieldByName(fields, fieldName) {
  const key = normalizeLower(fieldName);
  return (Array.isArray(fields) ? fields : []).find((field) => normalizeLower(field.name) === key) || null;
}

function resolveSeenFieldValue(fieldDef) {
  if (!fieldDef) {
    return "Yes";
  }

  const fieldType = normalizeLower(fieldDef.type);
  if (fieldType.includes("checkbox") || fieldType.includes("boolean")) {
    return true;
  }

  const preferredOptions = (fieldDef.options || []).find((option) => {
    const label = normalizeLower(option.label);
    const value = normalizeLower(option.value);
    return label === "yes" ||
      value === "yes" ||
      label === "true" ||
      value === "true" ||
      label === "seen" ||
      value === "seen" ||
      label === "opened" ||
      value === "opened" ||
      label === "read" ||
      value === "read";
  });

  if (preferredOptions) {
    return preferredOptions.value;
  }

  if (fieldDef.options && fieldDef.options.length) {
    return fieldDef.options[0].value;
  }

  return "Yes";
}

function resolveCountFieldValue(fieldDef, count) {
  const normalizedCount = Number(count) || 0;
  if (!fieldDef) {
    return normalizedCount;
  }

  const fieldType = normalizeLower(fieldDef.type);
  if (fieldType.includes("number") || fieldType.includes("numeric") || fieldType.includes("decimal")) {
    return normalizedCount;
  }

  const matchingOption = (fieldDef.options || []).find((option) => {
    return normalizeText(option.value) === String(normalizedCount) ||
      normalizeText(option.label) === String(normalizedCount);
  });

  if (matchingOption) {
    return matchingOption.value;
  }

  return String(normalizedCount);
}

async function updateTicketTrackingFields(ticketId, message, args) {
  const iparams = getIparams(args);
  const seenFieldName = normalizeText(iparams.seen_field);
  const countFieldName = normalizeText(iparams.count_field);

  if (!seenFieldName && !countFieldName) {
    return;
  }

  const fields = await fetchTicketFieldDefinitions(args);
  const customFields = {};

  if (seenFieldName) {
    customFields[seenFieldName] = resolveSeenFieldValue(lookupFieldByName(fields, seenFieldName));
  }

  if (countFieldName) {
    customFields[countFieldName] = resolveCountFieldValue(
      lookupFieldByName(fields, countFieldName),
      message.open_count
    );
  }

  if (!Object.keys(customFields).length) {
    return;
  }

  try {
    await invokeRequestTemplate("update_ticket", {
      context: {
        ticket_id: ticketId,
      },
      body: {
        custom_fields: customFields,
      },
    });
  } catch (error) {
    console.warn("Unable to update ticket tracking fields:", buildErrorMessage(error, "Failed to update ticket fields."));
  }
}

async function addPrivateNote(ticketId, body) {
  try {
    await invokeRequestTemplate("add_ticket_note", {
      context: {
        ticket_id: ticketId,
      },
      body: {
        body,
        private: true,
      },
    });
  } catch (error) {
    console.warn("Unable to add private note:", buildErrorMessage(error, "Failed to add note."));
  }
}

function buildFirstOpenNote(message, eventRecord) {
  const lines = [
    "<strong>Email Tracker</strong>",
    "",
    `The tracked email "${escapeHtml(message.reply_subject || message.ticket_subject || "Untitled email")}" was opened for the first time.`,
    `Opened at: ${escapeHtml(eventRecord.occurred_at)}`,
  ];

  if (eventRecord.browser && eventRecord.browser !== "Unknown") {
    lines.push(`Browser: ${escapeHtml(eventRecord.browser)}`);
  }

  if (eventRecord.device && eventRecord.device !== "Unknown") {
    lines.push(`Device: ${escapeHtml(eventRecord.device)}`);
  }

  if (eventRecord.source_ip) {
    lines.push(`IP: ${escapeHtml(eventRecord.source_ip)}`);
  }

  lines.push(`Open count: ${Number(message.open_count) || 0}`);

  return lines.join("<br>");
}

function buildMessageStatus(message) {
  if (Number(message.open_count) > 0) {
    return "read";
  }
  return "unread";
}

function buildEventRecord(payload, headers, blacklistEntries) {
  const userAgent = normalizeText(payload.user_agent || getHeaderCaseInsensitive(headers, "user-agent"));
  const sourceIp = extractSourceIp(payload, headers);
  const browser = normalizeText(payload.browser) || parseEventBrowser(userAgent);
  const device = normalizeText(payload.device) || parseEventDevice(userAgent);
  const fingerprint = normalizeText(payload.fingerprint) || buildEventFingerprint(sourceIp, userAgent);
  const blacklisted = isBlacklistedIp(sourceIp, blacklistEntries);

  return {
    id: createId("evt"),
    event_type: normalizeLower(payload.event_type) === "click" ? "click" : "open",
    occurred_at: normalizeText(payload.occurred_at) || new Date().toISOString(),
    source_ip: sourceIp,
    user_agent: userAgent,
    browser,
    device,
    country: normalizeText(payload.country),
    city: normalizeText(payload.city),
    fingerprint,
    blacklisted,
  };
}

function computeUniqueOpenCount(message) {
  const fingerprints = new Set();
  (Array.isArray(message.opens) ? message.opens : []).forEach((eventRecord) => {
    if (!eventRecord || eventRecord.event_type !== "open" || eventRecord.blacklisted) {
      return;
    }

    const fingerprint = normalizeText(eventRecord.fingerprint);
    if (fingerprint) {
      fingerprints.add(fingerprint);
    }
  });

  return fingerprints.size;
}

function buildTicketSummary(ticketId, ticketMessages) {
  const sortedMessages = [...ticketMessages].sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0));
  const latest = sortedMessages[0] || {};
  const trackedCount = sortedMessages.length;
  const readCount = sortedMessages.filter((message) => Number(message.open_count) > 0).length;
  const unreadCount = trackedCount - readCount;
  const totalOpenCount = sortedMessages.reduce((sum, message) => sum + (Number(message.open_count) || 0), 0);
  const blacklistedOpenCount = sortedMessages.reduce((sum, message) => sum + (Number(message.blacklisted_open_count) || 0), 0);

  return {
    ticket_id: Number(ticketId) || 0,
    ticket_subject: latest.ticket_subject || "",
    requester_email: latest.requester_email || "",
    requester_name: latest.requester_name || "",
    tracked_count: trackedCount,
    read_count: readCount,
    unread_count: unreadCount,
    total_open_count: totalOpenCount,
    blacklisted_open_count: blacklistedOpenCount,
    first_opened_at: sortedMessages
      .map((message) => normalizeText(message.first_opened_at))
      .filter(Boolean)
      .sort()[0] || "",
    last_opened_at: sortedMessages
      .map((message) => normalizeText(message.last_opened_at))
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || "",
    latest_message_preview: latest.body_preview || "",
    latest_message_subject: latest.reply_subject || latest.ticket_subject || "",
    latest_status: buildMessageStatus(latest),
    latest_token: latest.token || "",
  };
}

function buildDashboardPayload(messages) {
  const trackedMessages = Array.isArray(messages) ? messages : [];
  const ticketsMap = new Map();
  const recentEvents = [];

  trackedMessages.forEach((message) => {
    const ticketId = Number(message.ticket_id) || 0;
    if (!ticketsMap.has(ticketId)) {
      ticketsMap.set(ticketId, []);
    }
    ticketsMap.get(ticketId).push(message);

    (Array.isArray(message.opens) ? message.opens : []).forEach((eventRecord) => {
      recentEvents.push({
        ...eventRecord,
        ticket_id: ticketId,
        ticket_subject: message.ticket_subject || "",
        requester_email: message.requester_email || "",
        reply_subject: message.reply_subject || "",
      });
    });
  });

  const tickets = Array.from(ticketsMap.entries())
    .map(([ticketId, items]) => buildTicketSummary(ticketId, items))
    .sort((left, right) => Number(right.ticket_id || 0) - Number(left.ticket_id || 0));

  const totalTracked = trackedMessages.length;
  const totalRead = trackedMessages.filter((message) => Number(message.open_count) > 0).length;
  const totalUnread = totalTracked - totalRead;
  const totalOpens = trackedMessages.reduce((sum, message) => sum + (Number(message.open_count) || 0), 0);
  const totalBlacklistedOpens = trackedMessages.reduce(
    (sum, message) => sum + (Number(message.blacklisted_open_count) || 0),
    0
  );

  return {
    metrics: {
      tracked: totalTracked,
      read: totalRead,
      unread: totalUnread,
      opens: totalOpens,
      blacklisted: totalBlacklistedOpens,
    },
    tickets,
    recent_events: recentEvents
      .sort((left, right) => String(right.occurred_at || "").localeCompare(String(left.occurred_at || "")))
      .slice(0, 100),
    messages: trackedMessages.map((message) => ({
      id: message.id,
      token: message.token,
      ticket_id: Number(message.ticket_id) || 0,
      ticket_subject: message.ticket_subject || "",
      requester_email: message.requester_email || "",
      requester_name: message.requester_name || "",
      reply_subject: message.reply_subject || "",
      body_preview: message.body_preview || "",
      created_at: message.created_at || 0,
      open_count: Number(message.open_count) || 0,
      unique_open_count: Number(message.unique_open_count) || 0,
      blacklisted_open_count: Number(message.blacklisted_open_count) || 0,
      first_opened_at: message.first_opened_at || "",
      last_opened_at: message.last_opened_at || "",
      status: buildMessageStatus(message),
    })),
  };
}

function getMessagePreview(message) {
  return truncate(message.body_preview || message.reply_subject || message.ticket_subject || "", 140);
}

function shouldRetryWithoutSender(error, senderEmail) {
  if (!normalizeText(senderEmail)) {
    return false;
  }

  if (!error || Number(error.status) !== 400) {
    return false;
  }

  const detail = normalizeLower(buildErrorMessage(error, ""));
  return detail.includes("from_email") ||
    detail.includes("from email") ||
    detail.includes("sender_email") ||
    detail.includes("validation failed");
}

async function initializeRuntimeConfig(args, options) {
  const currentConfig = await readRuntimeConfig();
  const nextConfig = {
    ...(currentConfig && typeof currentConfig === "object" ? currentConfig : {}),
  };
  const allowGenerate = Boolean(options && options.allowGenerate);
  const forceRefresh = Boolean(options && options.forceRefresh);
  let changed = false;

  if (allowGenerate && (forceRefresh || !normalizeText(nextConfig.external_hook_url))) {
    nextConfig.external_hook_url = await generateTargetUrl(EVENT_HOOK_OPTION);
    nextConfig.external_hook_generated_at = Date.now();
    changed = true;
  }

  const bridgeUrl = resolveBridgeUrl(args);
  if (normalizeUrl(nextConfig.bridge_public_url) !== bridgeUrl) {
    nextConfig.bridge_public_url = bridgeUrl;
    changed = true;
  }

  const relaySecretHash = hashValue(resolveBridgeSecret(args));
  if (normalizeText(nextConfig.bridge_secret_hash) !== relaySecretHash) {
    nextConfig.bridge_secret_hash = relaySecretHash;
    changed = true;
  }

  if (changed) {
    await writeRuntimeConfig(nextConfig);
  }

  return nextConfig;
}

async function touchRuntimeConfigFromEvent(args) {
  try {
    await initializeRuntimeConfig(args, {
      allowGenerate: true,
    });
  } catch (error) {
    console.error("Unable to initialize email tracker runtime config:", buildErrorMessage(error, "Runtime setup failed."));
  }
}

exports = {
  getTrackerDashboardData: async function (args) {
    try {
      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });
      const messages = await readTrackedMessages();
      const dashboard = buildDashboardPayload(messages);
      return buildResponse({
        success: true,
        ...dashboard,
        runtime: {
          bridge_public_url: normalizeUrl(runtimeConfig.bridge_public_url),
          external_hook_url_present: Boolean(normalizeText(runtimeConfig.external_hook_url)),
        },
      });
    } catch (error) {
      return buildErrorResponse("Unable to load email tracker dashboard data.", error);
    }
  },

  getTicketTrackerData: async function (args) {
    try {
      const payload = parseArgs(args);
      const ticketId = Number(payload.ticket_id);
      if (!ticketId) {
        throw new Error("ticket_id is required.");
      }

      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });
      const [ticket, senderOptions, messages] = await Promise.all([
        fetchTicket(ticketId),
        fetchReplySenderOptions(),
        readTrackedMessages(),
      ]);

      const requesterInfo = getRequesterInfo(ticket);
      const ticketMessages = messages
        .filter((message) => Number(message.ticket_id) === ticketId)
        .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0));

      const ticketSummary = buildTicketSummary(ticketId, ticketMessages);

      return buildResponse({
        success: true,
        ticket: {
          id: ticketId,
          subject: normalizeText(ticket && ticket.subject),
          requester_email: requesterInfo.email,
          requester_name: requesterInfo.name,
        },
        runtime: {
          external_hook_url_present: Boolean(normalizeText(runtimeConfig.external_hook_url)),
          bridge_public_url: normalizeUrl(runtimeConfig.bridge_public_url),
          native_reply_injection_supported: true,
        },
        sender_options: senderOptions,
        summary: ticketSummary,
        messages: ticketMessages.map((message) => ({
          id: message.id,
          token: message.token,
          reply_subject: message.reply_subject || "",
          body_preview: getMessagePreview(message),
          created_at: message.created_at || 0,
          open_count: Number(message.open_count) || 0,
          unique_open_count: Number(message.unique_open_count) || 0,
          blacklisted_open_count: Number(message.blacklisted_open_count) || 0,
          first_opened_at: message.first_opened_at || "",
          last_opened_at: message.last_opened_at || "",
          status: buildMessageStatus(message),
          opens: (Array.isArray(message.opens) ? message.opens : []).slice(0, 8),
        })),
      });
    } catch (error) {
      return buildErrorResponse("Unable to load ticket email tracker data.", error);
    }
  },

  sendTrackedReply: async function (args) {
    try {
      const payload = parseArgs(args);
      const ticketId = Number(payload.ticket_id);
      const replyBody = normalizeText(payload.body_text || payload.body || payload.reply_body);
      const senderEmail = normalizeText(payload.sender_email);

      if (!ticketId) {
        throw new Error("ticket_id is required.");
      }

      if (!replyBody) {
        throw new Error("Reply body is required.");
      }

      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });

      if (!normalizeText(runtimeConfig.external_hook_url)) {
        throw new Error("The tracking hook URL is not initialized yet. Refresh the ticket and try again.");
      }

      const ticket = await fetchTicket(ticketId);
      const requesterInfo = getRequesterInfo(ticket);
      if (!requesterInfo.email) {
        throw new Error("Requester email is unavailable for this ticket.");
      }

      const token = buildToken();
      const pixelUrl = buildPixelUrl(runtimeConfig, token, args);
      if (!pixelUrl) {
        throw new Error("Unable to build a tracking pixel URL.");
      }

      const replySubject = normalizeText(payload.subject || ticket.subject || `Ticket #${ticketId}`);
      const bodyHtml = buildTrackedEmailHtml(replyBody, pixelUrl);
      const requestBody = {
        body: bodyHtml,
        to_emails: [requesterInfo.email],
        cc_emails: [],
        bcc_emails: [],
      };

      if (senderEmail) {
        requestBody.from_email = senderEmail;
      }

      let response;
      let senderFallbackUsed = false;

      try {
        response = await invokeRequestTemplate("create_ticket_reply", {
          context: {
            ticket_id: ticketId,
          },
          body: requestBody,
        });
      } catch (error) {
        if (!shouldRetryWithoutSender(error, senderEmail)) {
          throw error;
        }

        delete requestBody.from_email;
        response = await invokeRequestTemplate("create_ticket_reply", {
          context: {
            ticket_id: ticketId,
          },
          body: requestBody,
        });
        senderFallbackUsed = true;
      }

      const messages = await readTrackedMessages();
      messages.unshift({
        id: createId("msg"),
        token,
        ticket_id: ticketId,
        ticket_subject: normalizeText(ticket && ticket.subject) || replySubject,
        requester_email: requesterInfo.email,
        requester_name: requesterInfo.name,
        reply_subject: replySubject,
        body_preview: truncate(replyBody, 240),
        created_at: Date.now(),
        open_count: 0,
        unique_open_count: 0,
        blacklisted_open_count: 0,
        first_opened_at: "",
        last_opened_at: "",
        first_open_note_added_at: 0,
        opens: [],
        sender_email: senderEmail,
        sender_fallback_used: senderFallbackUsed,
        send_response_id: response && response.id ? response.id : 0,
      });

      await writeTrackedMessages(messages);

      return buildResponse({
        success: true,
        token,
        pixel_url: pixelUrl,
        sender_fallback_used: senderFallbackUsed,
      });
    } catch (error) {
      return buildErrorResponse("Unable to send the tracked reply.", error);
    }
  },

  prepareConversationTracking: async function (args) {
    try {
      const payload = parseArgs(args);
      const ticketId = Number(payload.ticket_id);
      if (!ticketId) {
        throw new Error("ticket_id is required.");
      }

      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });

      if (!normalizeText(runtimeConfig.external_hook_url)) {
        throw new Error("The tracking hook URL is not initialized yet. Refresh the ticket and try again.");
      }

      const ticket = await fetchTicket(ticketId);
      const requesterInfo = getRequesterInfo(ticket);
      if (!requesterInfo.email) {
        throw new Error("Requester email is unavailable for this ticket.");
      }

      const token = buildToken();
      const pixelUrl = buildPixelUrl(runtimeConfig, token, args);
      if (!pixelUrl) {
        throw new Error("Unable to build a tracking pixel URL.");
      }

      const htmlSnippet = buildTrackedEditorHtmlSnippet(pixelUrl, token);
      if (!htmlSnippet) {
        throw new Error("Unable to build the tracked editor snippet.");
      }

      return buildResponse({
        success: true,
        token,
        pixel_url: pixelUrl,
        html_snippet: htmlSnippet,
        requester_email: requesterInfo.email,
      });
    } catch (error) {
      return buildErrorResponse("Unable to prepare the tracked editor snippet.", error);
    }
  },

  syncLiveTicketFieldMetadata: async function (args) {
    try {
      const payload = parseArgs(args);
      const fields = Array.isArray(payload.fields) ? payload.fields : [];
      await writeLiveFieldMetadata(fields);
      return buildResponse({
        success: true,
        fields: fields.length,
      });
    } catch (error) {
      return buildErrorResponse("Unable to sync live ticket field metadata.", error);
    }
  },

  onTicketCreateHandler: async function (args) {
    await touchRuntimeConfigFromEvent(args);
  },

  onTicketUpdateHandler: async function (args) {
    await touchRuntimeConfigFromEvent(args);
  },

  onConversationCreateHandler: async function (args) {
    await touchRuntimeConfigFromEvent(args);

    try {
      const conversation = args && args.data && args.data.conversation;
      if (!isOutboundEmailConversation(conversation)) {
        return;
      }

      const token = extractTrackingTokenFromBody(conversation.body);
      if (!token) {
        return;
      }

      const messages = await readTrackedMessages();
      const existing = messages.find((item) => normalizeText(item.token) === token);
      if (existing) {
        if (!Number(existing.send_response_id) && Number(conversation.id)) {
          existing.send_response_id = Number(conversation.id) || 0;
          await writeTrackedMessages(messages);
        }
        return;
      }

      const ticketId = Number(conversation.ticket_id);
      if (!ticketId) {
        return;
      }

      const ticket = await fetchTicket(ticketId);
      messages.unshift(buildTrackedMessageFromConversation(conversation, ticket, token));
      await writeTrackedMessages(messages);
    } catch (error) {
      console.error(
        "Unable to finalize native editor tracking record:",
        buildErrorMessage(error, "Conversation tracking finalization failed.")
      );
    }
  },

  onAppInstallHandler: async function (args) {
    try {
      await initializeRuntimeConfig(args, {
        allowGenerate: true,
        forceRefresh: true,
      });
      renderData();
    } catch (error) {
      console.error("onAppInstallHandler failed:", buildErrorMessage(error, "App install setup failed."));
      renderData({
        message: "Unable to initialize the email tracking hook during installation.",
      });
    }
  },

  onExternalEventHandler: async function (args) {
    try {
      const payload = (args && args.data) || {};
      const headers = (args && args.headers) || {};
      const token = normalizeText(payload.token);
      if (!token) {
        return buildResponse({
          success: false,
          processed: false,
          message: "Missing tracking token.",
        });
      }

      const relaySecret = resolveBridgeSecret(args);
      const suppliedSecret =
        normalizeText(getHeaderCaseInsensitive(headers, "x-email-tracker-bridge-secret")) ||
        normalizeText(payload.relay_secret);

      if (normalizeText(relaySecret) && suppliedSecret !== relaySecret) {
        return buildResponse({
          success: false,
          processed: false,
          message: "Bridge authentication failed.",
        });
      }

      const blacklistEntries = getBlacklistEntries(args);
      const eventRecord = buildEventRecord(payload, headers, blacklistEntries);
      const messages = await readTrackedMessages();
      const message = messages.find((item) => normalizeText(item.token) === token);

      if (!message) {
        return buildResponse({
          success: true,
          processed: false,
          message: "No tracked message matched the supplied token.",
        });
      }

      message.opens = [eventRecord, ...(Array.isArray(message.opens) ? message.opens : [])].slice(0, MAX_EVENTS_PER_MESSAGE);
      message.last_event_at = eventRecord.occurred_at;

      let firstHumanOpen = false;

      if (eventRecord.event_type === "open") {
        if (eventRecord.blacklisted) {
          message.blacklisted_open_count = (Number(message.blacklisted_open_count) || 0) + 1;
          message.last_blacklisted_open_at = eventRecord.occurred_at;
        } else {
          message.open_count = (Number(message.open_count) || 0) + 1;
          message.unique_open_count = computeUniqueOpenCount(message);
          if (!normalizeText(message.first_opened_at)) {
            message.first_opened_at = eventRecord.occurred_at;
            firstHumanOpen = true;
          }
          message.last_opened_at = eventRecord.occurred_at;
        }
      }

      await writeTrackedMessages(messages);

      if (eventRecord.event_type === "open" && !eventRecord.blacklisted) {
        await updateTicketTrackingFields(message.ticket_id, message, args);

        if (firstHumanOpen && shouldWriteFirstOpenNote(args)) {
          await addPrivateNote(message.ticket_id, buildFirstOpenNote(message, eventRecord));
          message.first_open_note_added_at = Date.now();
          await writeTrackedMessages(messages);
        }
      }

      return buildResponse({
        success: true,
        processed: true,
        ticket_id: Number(message.ticket_id) || 0,
        token,
        blacklisted: Boolean(eventRecord.blacklisted),
        open_count: Number(message.open_count) || 0,
        blacklisted_open_count: Number(message.blacklisted_open_count) || 0,
        event_type: eventRecord.event_type,
      });
    } catch (error) {
      return buildErrorResponse("Unable to process the external tracking event.", error);
    }
  },
};
