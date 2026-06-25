const { KJUR, KEYUTIL, b64tohex } = require("jsrsasign");

const RUNTIME_KEY = "email_tracker_runtime_v1";
const MESSAGES_KEY = "email_tracker_messages_v1";
const LIVE_FIELD_METADATA_KEY = "email_tracker_live_field_metadata_v1";
const NATIVE_REPLY_DIAGNOSTICS_KEY = "email_tracker_native_reply_diagnostics_v1";
const PAGE_SIZE = 100;
const MAX_TRACKED_MESSAGES = 1000;
const MAX_EVENTS_PER_MESSAGE = 80;
const MAX_DIAGNOSTIC_EVENTS = 120;
const MAX_TRACKED_REPLY_ATTACHMENTS = 5;
const MAX_TRACKED_REPLY_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TRACKED_REPLY_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const NATIVE_PENDING_SELF_OPEN_WINDOW_MS = 10 * 1000;
const NATIVE_PENDING_CONVERSATION_MATCH_WINDOW_MS = 10 * 60 * 1000;
const EVENT_HOOK_OPTION = "email-tracker-open-v1";
const DEFAULT_PUBLIC_TRACKER_BRIDGE_URL = normalizeUrl("https://email-tracker-bridge.akashram-trello-bridge.workers.dev");
const TRACKING_TOKEN_PATTERN = /(?:data-email-tracker-token=["']|token=)([a-f0-9]{32})/gi;
const BRIDGE_RELAY_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1i8OpMbRIyc8yNhyl9tO",
  "HCq7rrFJX5F8Sp0n0s91n1hLVHbk3sPRoBZt64Ss8pw2sjL/hGgLDsZg8sk6IXim",
  "CvgQz6AD05uatfsm9ks5HkNEDdUqUZzdsygpw1pJRT8g9xQ7CoNhQyc1DOaAHi2b",
  "NylJVxHUZAB2WijM5J4k1FlKL5t8ZjpNrKHMkJ6F4wvbnguF0sRt5BVzsTALW5KI",
  "01xp0IKyWNJ2Htk0b7xodEdOydUmmPZmz4tJyBEpFFujlHQ68tYEqgN1pJu4TE/b",
  "DzbtmLqbVTWORr6B2uRvtsQP3OPj04dNyCrOuf4ZvLhDt6/S1kqg7q77E4FOFAXJ",
  "rQIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");

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
  let token = Date.now().toString(16);
  while (token.length < 32) {
    token += Math.random().toString(16).slice(2);
  }
  return token.slice(0, 32);
}

function hashValue(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function tokenLogRef(token) {
  const normalized = normalizeText(token);
  if (!normalized) {
    return "";
  }

  return `${hashValue(normalized)}:${normalized.slice(-6)}`;
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
    appSettings.bridge_public_url ||
      iparams.bridge_public_url ||
      DEFAULT_PUBLIC_TRACKER_BRIDGE_URL
  );
}

function buildBridgeRequestContext(args, path) {
  const bridgeUrl = resolveBridgeUrl(args);
  const parsed = new URL(bridgeUrl);
  return {
    bridge_host: parsed.host,
    bridge_path: `${parsed.pathname.replace(/\/+$/, "")}${path}`.replace(/^\/?/, "/"),
  };
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

function buildPixelUrl(runtimeConfig, token) {
  const bridgeUrl = normalizeUrl(runtimeConfig && runtimeConfig.bridge_public_url);
  const hookUrl = normalizeText(runtimeConfig && runtimeConfig.external_hook_url);

  if (!bridgeUrl || !hookUrl) {
    return "";
  }

  const params = [
    `token=${encodeURIComponent(token)}`,
    `hook=${encodeURIComponent(hookUrl)}`,
  ].join("&");

  return `${bridgeUrl}/pixel?${params}`;
}

function buildTrackedEmailHtml(bodyText, pixelUrl) {
  const safeBody = escapeHtml(bodyText).replace(/\n/g, "<br>");
  const pixelMarkup = pixelUrl
    ? `<img src="${escapeHtml(pixelUrl)}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />`
    : "";

  return [
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#17324d;">',
    `<div>${safeBody || " "}</div>`,
    '<div style="display:none!important;visibility:hidden;opacity:0;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;">Tracked by Email Tracker</div>',
    pixelMarkup,
    "</div>",
  ].join("");
}

function buildTrackedEmailHtmlFromNativeBody(bodyHtml, pixelUrl) {
  const html = normalizeText(bodyHtml);
  const pixelMarkup = pixelUrl
    ? `<img src="${escapeHtml(pixelUrl)}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />`
    : "";
  const markerMarkup = '<div style="display:none!important;visibility:hidden;opacity:0;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;">Tracked by Email Tracker</div>';

  if (!html) {
    return buildTrackedEmailHtml(" ", pixelUrl);
  }

  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${markerMarkup}${pixelMarkup}</body>`);
  }

  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${markerMarkup}${pixelMarkup}</html>`);
  }

  return `${html}${markerMarkup}${pixelMarkup}`;
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

function flattenConversationContent(value, parts) {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenConversationContent(item, parts));
    return;
  }

  if (typeof value === "object") {
    Object.keys(value).forEach((key) => {
      flattenConversationContent(value[key], parts);
    });
    return;
  }

  const text = normalizeText(value);
  if (text) {
    parts.push(text);
  }
}

function buildConversationTrackingSource(conversation) {
  const parts = [];

  flattenConversationContent(conversation && conversation.body, parts);
  flattenConversationContent(conversation && conversation.body_html, parts);
  flattenConversationContent(conversation && conversation.bodyHtml, parts);
  flattenConversationContent(conversation && conversation.body_text, parts);
  flattenConversationContent(conversation && conversation.bodyText, parts);
  flattenConversationContent(conversation && conversation.full_text, parts);
  flattenConversationContent(conversation && conversation.plain_text, parts);

  return parts.join("\n");
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

function extractTrackingTokenFromConversation(conversation) {
  return extractTrackingTokenFromBody(buildConversationTrackingSource(conversation));
}

function looksLikeConversation(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Boolean(
    value.id ||
      value.ticket_id ||
      value.ticketId ||
      value.body ||
      value.body_html ||
      value.bodyText ||
      value.body_text ||
      value.plain_text ||
      value.kind ||
      value.source
  );
}

function getConversationFromEventArgs(args) {
  const data = (args && args.data) || {};
  const candidates = [
    data.conversation,
    data.ticket_conversation,
    data.ticketConversation,
    data.reply,
    data.note,
    data,
  ];

  return candidates.find(looksLikeConversation) || null;
}

function getConversationTicketId(conversation) {
  return Number(
    conversation &&
      (conversation.ticket_id ||
        conversation.ticketId ||
        (conversation.ticket && conversation.ticket.id))
  ) || 0;
}

function getConversationId(conversation) {
  return Number(conversation && (conversation.id || conversation.conversation_id)) || 0;
}

function sanitizeDiagnosticDetails(details) {
  const sanitized = {};
  Object.keys(details && typeof details === "object" ? details : {}).forEach((key) => {
    const value = details[key];
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
      return;
    }

    if (typeof value === "string") {
      sanitized[key] = truncate(value, 160);
    }
  });
  return sanitized;
}

function debugLog(message, details) {
  console.error("[EmailTrackerDebug]", message, sanitizeDiagnosticDetails(details));
}

async function appendDiagnosticEvent(eventName, details) {
  const stored = await readDbJson(NATIVE_REPLY_DIAGNOSTICS_KEY, { items: [] });
  const items = Array.isArray(stored && stored.items) ? stored.items : [];
  items.unshift({
    event_name: normalizeText(eventName) || "unknown",
    details: sanitizeDiagnosticDetails(details),
    created_at: new Date().toISOString(),
  });
  await writeDbJson(NATIVE_REPLY_DIAGNOSTICS_KEY, {
    items: items.slice(0, MAX_DIAGNOSTIC_EVENTS),
  });
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
  const ticketId = getConversationTicketId(conversation) || Number(ticket && ticket.id) || 0;
  const previewText =
    normalizeText(conversation && conversation.body_text) ||
    normalizeText(conversation && conversation.bodyText) ||
    normalizeText(conversation && conversation.plain_text) ||
    stripHtml(buildConversationTrackingSource(conversation));

  return {
    id: createId("msg"),
    token,
    ticket_id: ticketId,
    ticket_subject: normalizeText(ticket && ticket.subject),
    requester_email: requesterInfo.email,
    requester_name: requesterInfo.name,
    reply_subject: normalizeText(ticket && ticket.subject) || `Ticket #${ticketId}`,
    body_preview: truncate(previewText, 240),
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
    send_response_id: getConversationId(conversation),
    message_source: "conversation_token_detected",
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

function normalizeEmailList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      return item && (item.email || item.address || item.value);
    }));
  }

  return splitLinesAndCsv(value);
}

function normalizeReplyAttachments(value) {
  const attachments = Array.isArray(value) ? value : [];
  let totalBytes = 0;

  if (attachments.length > MAX_TRACKED_REPLY_ATTACHMENTS) {
    throw new Error(`Attach up to ${MAX_TRACKED_REPLY_ATTACHMENTS} files per tracked reply.`);
  }

  return attachments.map((attachment, index) => {
    const filename = normalizeText(
      attachment && (attachment.filename || attachment.name || `attachment-${index + 1}`)
    );
    const contentType = normalizeText(attachment && (attachment.content_type || attachment.type)) ||
      "application/octet-stream";
    const dataBase64 = normalizeText(attachment && (attachment.data_base64 || attachment.base64 || attachment.content));
    const size = Number(attachment && attachment.size) || Math.floor((dataBase64.length * 3) / 4);

    if (!filename) {
      throw new Error("Attachment filename is required.");
    }

    if (!dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
      throw new Error(`Attachment ${filename} is not a valid base64 payload.`);
    }

    if (size > MAX_TRACKED_REPLY_ATTACHMENT_BYTES) {
      throw new Error(`Attachment ${filename} exceeds the ${Math.floor(MAX_TRACKED_REPLY_ATTACHMENT_BYTES / 1024 / 1024)} MB limit.`);
    }

    totalBytes += size;
    if (totalBytes > MAX_TRACKED_REPLY_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed the ${Math.floor(MAX_TRACKED_REPLY_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB total limit.`);
    }

    return {
      filename,
      content_type: contentType,
      data_base64: dataBase64,
      size,
    };
  });
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
    debugLog("reply_sender_options_load_failed", {
      error: buildErrorMessage(error, "Unable to list email configs."),
    });
    return [];
  }
}

async function sendReplyWithAttachmentsViaBridge(args, requestBody, attachments, ticketId) {
  const iparams = getIparams(args);
  const domain = normalizeText(iparams.domain);
  const apiKey = normalizeText(iparams.api_key);

  if (!domain || !apiKey) {
    throw new Error("Freshdesk domain and API key are required for attachment replies.");
  }

  return await invokeRequestTemplate("bridge_create_ticket_reply", {
    context: buildBridgeRequestContext(args, "/freshdesk/reply"),
    body: {
      domain,
      api_key: apiKey.startsWith("Basic ") ? apiKey : `Basic ${apiKey}`,
      ticket_id: ticketId,
      body: requestBody.body,
      from_email: requestBody.from_email,
      cc_emails: requestBody.cc_emails || [],
      bcc_emails: requestBody.bcc_emails || [],
      attachments,
    },
  });
}

async function fetchTicketFieldDefinitions() {
  try {
    const direct = await invokeRequestTemplate("list_admin_ticket_fields", {});
    const normalizedDirect = normalizeFieldCollection(direct);
    if (normalizedDirect.length) {
      return mergeFieldDefinitions(normalizedDirect, await readLiveFieldMetadata());
    }
  } catch (error) {
    debugLog("admin_ticket_fields_load_failed", {
      error: buildErrorMessage(error, "Unable to load admin ticket fields."),
    });
  }

  try {
    const paginated = await fetchPaginated("list_ticket_fields", {});
    return mergeFieldDefinitions(normalizeFieldCollection(paginated), await readLiveFieldMetadata());
  } catch (error) {
    debugLog("public_ticket_fields_load_failed", {
      error: buildErrorMessage(error, "Unable to load ticket fields."),
    });
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

  const fields = await fetchTicketFieldDefinitions();
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
    debugLog("ticket_tracking_fields_update_failed", {
      ticket_id: ticketId,
      error: buildErrorMessage(error, "Failed to update ticket fields."),
    });
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
    debugLog("private_note_add_failed", {
      ticket_id: ticketId,
      error: buildErrorMessage(error, "Failed to add note."),
    });
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
  if (message.native_pending && Number(message.open_count) <= 0) {
    return "pending";
  }

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

function isLikelyNativeEditorSelfOpen(message, eventRecord) {
  if (!message || !eventRecord || eventRecord.event_type !== "open" || Number(message.open_count) > 0) {
    return false;
  }

  const createdAt = Number(message.created_at) || 0;
  const occurredAt = Date.parse(eventRecord.occurred_at) || Date.now();
  if (!createdAt) {
    return Boolean(message.native_pending);
  }

  const ageMs = occurredAt - createdAt;
  return ageMs >= 0 && ageMs <= NATIVE_PENDING_SELF_OPEN_WINDOW_MS;
}

function repairNativePendingSelfOpenCounters(messages) {
  let changed = false;
  const now = Date.now();

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (!message || !message.native_pending || Number(message.open_count) <= 0) {
      if (
        message &&
        message.native_pending &&
        Number(message.created_at) &&
        now - Number(message.created_at) > NATIVE_PENDING_SELF_OPEN_WINDOW_MS
      ) {
        message.native_pending = false;
        message.native_pending_expired_at = now;
        changed = true;
      }
      return;
    }

    const firstOpenedAt = Date.parse(message.first_opened_at) || 0;
    const createdAt = Number(message.created_at) || 0;
    if (createdAt && firstOpenedAt && firstOpenedAt - createdAt > NATIVE_PENDING_SELF_OPEN_WINDOW_MS) {
      return;
    }

    const previousOpenCount = Number(message.open_count) || 0;
    message.ignored_open_count = (Number(message.ignored_open_count) || 0) + previousOpenCount;
    message.last_ignored_open_at = message.last_opened_at || message.first_opened_at || message.last_ignored_open_at || "";
    message.open_count = 0;
    message.unique_open_count = 0;
    message.first_opened_at = "";
    message.last_opened_at = "";
    message.native_self_open_repaired_at = Date.now();

    (Array.isArray(message.opens) ? message.opens : []).forEach((eventRecord) => {
      if (!eventRecord || eventRecord.event_type !== "open") {
        return;
      }

      eventRecord.ignored = true;
      eventRecord.ignore_reason = eventRecord.ignore_reason || "native_editor_self_open";
    });

    changed = true;

    if (Number(message.created_at) && now - Number(message.created_at) > NATIVE_PENDING_SELF_OPEN_WINDOW_MS) {
      message.native_pending = false;
      message.native_pending_expired_at = now;
    }
  });

  return changed;
}

function finalizePendingNativeMessageFromConversation(messages, conversation, ticketId) {
  const normalizedTicketId = Number(ticketId) || getConversationTicketId(conversation);
  if (!normalizedTicketId) {
    return null;
  }

  const conversationCreatedAt = Date.parse(normalizeText(conversation && conversation.created_at)) || Date.now();
  const pending = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message || !message.native_pending || Number(message.ticket_id) !== normalizedTicketId) {
        return false;
      }

      const createdAt = Number(message.created_at) || 0;
      if (!createdAt) {
        return true;
      }

      return Math.abs(conversationCreatedAt - createdAt) <= NATIVE_PENDING_CONVERSATION_MATCH_WINDOW_MS;
    })
    .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0))[0];

  if (!pending) {
    return null;
  }

  const conversationId = getConversationId(conversation);
  if (!Number(pending.send_response_id) && conversationId) {
    pending.send_response_id = conversationId;
  }
  pending.native_pending = false;
  pending.message_source = pending.message_source || "native_send_intercept";
  pending.conversation_kind = normalizeText(conversation && conversation.kind);
  pending.conversation_source = Number(conversation && conversation.source) || 0;
  pending.sender_email = pending.sender_email || normalizeText(
    conversation && (conversation.from_email || conversation.support_email)
  );

  const preview = getMessagePreview(buildTrackedMessageFromConversation(conversation, { id: normalizedTicketId }, pending.token));
  if (preview) {
    pending.body_preview = preview;
  }

  return pending;
}

function buildRelaySigningPayload(payload) {
  return JSON.stringify({
    event_type: normalizeLower(payload && payload.event_type) === "click" ? "click" : "open",
    token: normalizeText(payload && payload.token),
    occurred_at: normalizeText(payload && payload.occurred_at),
    source_ip: normalizeText(payload && payload.source_ip),
    user_agent: normalizeText(payload && payload.user_agent),
    browser: normalizeText(payload && payload.browser),
    device: normalizeText(payload && payload.device),
    country: normalizeText(payload && payload.country),
    city: normalizeText(payload && payload.city),
    target: normalizeText(payload && payload.target),
  });
}

function verifyRelaySignature(payload, signature) {
  const normalizedSignature = normalizeText(signature);
  if (!normalizedSignature) {
    return false;
  }

  try {
    const publicKey = KEYUTIL.getKey(BRIDGE_RELAY_PUBLIC_KEY);
    const verifier = new KJUR.crypto.Signature({ alg: "SHA256withRSA" });
    verifier.init(publicKey);
    verifier.updateString(buildRelaySigningPayload(payload));
    return verifier.verify(b64tohex(normalizedSignature));
  } catch (error) {
    debugLog("bridge_relay_signature_verify_failed", {
      error: error && error.message ? error.message : error,
    });
    return false;
  }
}

function validateAppSettings(args) {
  const settings = getAppSettings(args);
  const bridgePublicUrl = normalizeText(settings.bridge_public_url);
  const noteOnFirstOpen = settings.note_on_first_open;
  const ipBlacklist = settings.ip_blacklist;

  if (bridgePublicUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(bridgePublicUrl);
    } catch {
      throw new Error("bridge_public_url must be a valid https URL.");
    }

    if (parsedUrl.protocol !== "https:") {
      throw new Error("bridge_public_url must use https.");
    }
  }

  if (
    noteOnFirstOpen !== undefined &&
    noteOnFirstOpen !== null &&
    !["true", "false", "1", "0", true, false, 1, 0].includes(noteOnFirstOpen)
  ) {
    throw new Error("note_on_first_open must be a boolean value.");
  }

  if (ipBlacklist !== undefined && ipBlacklist !== null && typeof ipBlacklist !== "string") {
    throw new Error("ip_blacklist must be a string.");
  }
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

async function persistPreparedNativeTracking(ticket, token, pixelUrl, bodyPreview) {
  const ticketId = Number(ticket && ticket.id) || 0;
  const requesterInfo = getRequesterInfo(ticket);
  const messages = await readTrackedMessages();
  const existing = messages.find((message) => normalizeText(message.token) === token);

  if (existing) {
    debugLog("native_prepare_reused_existing_tracking_record", {
      ticket_id: ticketId,
      token_ref: tokenLogRef(token),
      total_records: messages.length,
    });
    return existing;
  }

  const replySubject = normalizeText(ticket && ticket.subject) || `Ticket #${ticketId}`;
  const messageRecord = {
    id: createId("msg"),
    token,
    ticket_id: ticketId,
    ticket_subject: replySubject,
    requester_email: requesterInfo.email,
    requester_name: requesterInfo.name,
    reply_subject: replySubject,
    body_preview: truncate(bodyPreview || "Native Freshdesk reply tracking prepared.", 240),
    created_at: Date.now(),
    open_count: 0,
    unique_open_count: 0,
    blacklisted_open_count: 0,
    first_opened_at: "",
    last_opened_at: "",
    first_open_note_added_at: 0,
    opens: [],
    ignored_open_count: 0,
    last_ignored_open_at: "",
    sender_email: "",
    sender_fallback_used: false,
    send_response_id: 0,
    message_source: "native_send_intercept",
    native_pending: true,
    pixel_url: pixelUrl,
  };

  messages.unshift(messageRecord);
  await writeTrackedMessages(messages);
  debugLog("native_prepare_persisted_pending_tracking_record", {
    ticket_id: ticketId,
    message_id: messageRecord.id,
    token_ref: tokenLogRef(token),
    total_records_before: messages.length - 1,
    total_records_after: messages.length,
  });
  return messageRecord;
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
  onSettingsUpdate: function (args) {
    try {
      validateAppSettings(args);
      return renderData();
    } catch (error) {
      return renderData({
        message: "Invalid app settings.",
        detail: buildErrorMessage(error, "Invalid app settings."),
      });
    }
  },

  getTrackerDashboardData: async function (args) {
    try {
      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });
      const messages = await readTrackedMessages();
      if (repairNativePendingSelfOpenCounters(messages)) {
        await writeTrackedMessages(messages);
        debugLog("native_pending_self_open_counters_repaired_on_dashboard_load", {
          total_records: messages.length,
        });
      }
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
      if (repairNativePendingSelfOpenCounters(messages)) {
        await writeTrackedMessages(messages);
        debugLog("native_pending_self_open_counters_repaired_on_sidebar_load", {
          ticket_id: ticketId,
          total_records: messages.length,
        });
      }

      const requesterInfo = getRequesterInfo(ticket);
      const ticketMessages = messages
        .filter((message) => Number(message.ticket_id) === ticketId)
        .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0));

      const ticketSummary = buildTicketSummary(ticketId, ticketMessages);
      debugLog("sidebar_ticket_data_loaded", {
        ticket_id: ticketId,
        total_records: messages.length,
        ticket_records: ticketMessages.length,
        pending_records: ticketMessages.filter((message) => message && message.native_pending).length,
        runtime_hook_present: Boolean(normalizeText(runtimeConfig.external_hook_url)),
      });

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
          ignored_open_count: Number(message.ignored_open_count) || 0,
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
      const nativeBodyHtml = normalizeText(payload.body_html || payload.native_body_html);
      const replyBody = normalizeText(payload.body_text || payload.body || payload.reply_body);
      const bodyPreview = truncate(stripHtml(nativeBodyHtml || replyBody), 240);
      const senderEmail = normalizeText(payload.sender_email);
      const ccEmails = normalizeEmailList(payload.cc_emails || payload.cc);
      const bccEmails = normalizeEmailList(payload.bcc_emails || payload.bcc);
      const attachments = normalizeReplyAttachments(payload.attachments);

      if (!ticketId) {
        throw new Error("ticket_id is required.");
      }

      if (!replyBody && !nativeBodyHtml) {
        throw new Error("Reply body is required.");
      }

      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });

      if (!normalizeText(runtimeConfig.external_hook_url)) {
        throw new Error("The tracking hook URL is not initialized yet. Refresh the ticket and try again.");
      }

      const ticket = payload.native_send
        ? {
            id: ticketId,
            subject: normalizeText(payload.ticket_subject),
            requester: {
              email: normalizeText(payload.requester_email),
              name: normalizeText(payload.requester_name),
            },
          }
        : await fetchTicket(ticketId);
      const requesterInfo = getRequesterInfo(ticket);

      const token = buildToken();
      const pixelUrl = buildPixelUrl(runtimeConfig, token);
      if (!pixelUrl) {
        throw new Error("Unable to build a tracking pixel URL.");
      }

      const replySubject = normalizeText(payload.subject || ticket.subject || `Ticket #${ticketId}`);
      const bodyHtml = nativeBodyHtml
        ? buildTrackedEmailHtmlFromNativeBody(nativeBodyHtml, pixelUrl)
        : buildTrackedEmailHtml(replyBody, pixelUrl);
      const requestBody = {
        body: bodyHtml,
      };

      if (senderEmail) {
        requestBody.from_email = senderEmail;
      }
      if (ccEmails.length) {
        requestBody.cc_emails = ccEmails;
      }
      if (bccEmails.length) {
        requestBody.bcc_emails = bccEmails;
      }

      let response;
      let senderFallbackUsed = false;

      try {
        response = attachments.length
          ? await sendReplyWithAttachmentsViaBridge(args, requestBody, attachments, ticketId)
          : await invokeRequestTemplate("create_ticket_reply", {
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
        response = attachments.length
          ? await sendReplyWithAttachmentsViaBridge(args, requestBody, attachments, ticketId)
          : await invokeRequestTemplate("create_ticket_reply", {
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
        body_preview: bodyPreview,
        created_at: Date.now(),
        open_count: 0,
        unique_open_count: 0,
        blacklisted_open_count: 0,
        first_opened_at: "",
        last_opened_at: "",
        first_open_note_added_at: 0,
        opens: [],
        sender_email: senderEmail,
        cc_emails: ccEmails,
        bcc_emails: bccEmails,
        attachment_count: attachments.length,
        attachment_names: attachments.map((attachment) => attachment.filename),
        sender_fallback_used: senderFallbackUsed,
        send_response_id: response && response.id ? response.id : 0,
        message_source: payload.native_send ? "native_send_api_intercept" : "tracked_send_api",
      });

      await writeTrackedMessages(messages);
      debugLog("tracked_reply_sent_via_api", {
        ticket_id: ticketId,
        token_ref: tokenLogRef(token),
        send_response_id: response && response.id ? response.id : 0,
        sender_fallback_used: senderFallbackUsed,
        native_send: Boolean(payload.native_send),
        cc_count: ccEmails.length,
        bcc_count: bccEmails.length,
        attachment_count: attachments.length,
        total_records: messages.length,
      });

      return buildResponse({
        success: true,
        token,
        pixel_url: pixelUrl,
        sender_fallback_used: senderFallbackUsed,
        attachment_count: attachments.length,
      });
    } catch (error) {
      return buildErrorResponse("Unable to send the tracked reply.", error);
    }
  },

  prepareNativeReplyTracking: async function (args) {
    try {
      const payload = parseArgs(args);
      const ticketId = Number(payload.ticket_id);
      const ticketSubject = normalizeText(payload.ticket_subject) || `Ticket #${ticketId}`;
      const requesterEmail = normalizeText(payload.requester_email);
      const requesterName = normalizeText(payload.requester_name);
      const bodyPreview = normalizeText(payload.body_preview);

      if (!ticketId) {
        throw new Error("ticket_id is required.");
      }

      debugLog("native_prepare_requested", {
        ticket_id: ticketId,
        body_preview_chars: bodyPreview.length,
      });

      const runtimeConfig = await initializeRuntimeConfig(args, {
        allowGenerate: false,
      });

      if (!normalizeText(runtimeConfig.external_hook_url)) {
        throw new Error("The tracking hook URL is not initialized yet. Refresh the ticket and try again.");
      }

      const ticket = {
        id: ticketId,
        subject: ticketSubject,
        requester: {
          email: requesterEmail,
          name: requesterName,
        },
      };
      const token = buildToken();
      const pixelUrl = buildPixelUrl(runtimeConfig, token);
      if (!pixelUrl) {
        throw new Error("Unable to build a tracking pixel URL.");
      }

      const htmlSnippet = buildTrackedEditorHtmlSnippet(pixelUrl, token);
      if (!htmlSnippet) {
        throw new Error("Unable to build the native reply tracking snippet.");
      }

      await persistPreparedNativeTracking(ticket, token, pixelUrl, bodyPreview);
      debugLog("native_prepare_completed", {
        ticket_id: ticketId,
        token_ref: tokenLogRef(token),
        snippet_chars: htmlSnippet.length,
      });

      return buildResponse({
        success: true,
        token,
        pixel_url: pixelUrl,
        html_snippet: htmlSnippet,
      });
    } catch (error) {
      return buildErrorResponse("Unable to prepare native reply tracking.", error);
    }
  },

  logNativeReplyClientEvent: async function (args) {
    try {
      const payload = parseArgs(args);
      const eventName = normalizeText(payload.event_name) || "unknown";
      const details = sanitizeDiagnosticDetails(payload.details);
      debugLog("native_client_checkpoint", {
        event_name: eventName,
        ...details,
      });
      await appendDiagnosticEvent(eventName, details);

      return buildResponse({
        success: true,
      });
    } catch (error) {
      debugLog("native_client_checkpoint_log_failed", {
        error: buildErrorMessage(error, "Client checkpoint logging failed."),
      });
      return buildResponse({
        success: false,
      });
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
      const conversation = getConversationFromEventArgs(args);
      const dataKeys = Object.keys((args && args.data) || {}).slice(0, 12);
      if (!conversation) {
        debugLog("conversation_event_no_payload", {
          data_keys: dataKeys,
        });
        return;
      }

      const conversationId = getConversationId(conversation);
      const ticketId = getConversationTicketId(conversation);
      debugLog("conversation_event_received", {
        conversation_id: conversationId,
        ticket_id: ticketId,
        kind: normalizeText(conversation && conversation.kind),
        source: Number(conversation && conversation.source) || 0,
        incoming: Boolean(conversation && conversation.incoming),
        private: Boolean(conversation && conversation.private),
        data_keys: dataKeys,
      });

      if (!isOutboundEmailConversation(conversation)) {
        debugLog("conversation_event_ignored_not_outbound", {
          conversation_id: conversationId,
          ticket_id: ticketId,
          kind: normalizeText(conversation && conversation.kind),
          source: Number(conversation && conversation.source) || 0,
          incoming: Boolean(conversation && conversation.incoming),
          private: Boolean(conversation && conversation.private),
        });
        return;
      }

      const token = extractTrackingTokenFromConversation(conversation);
      if (!token) {
        const messages = await readTrackedMessages();
        const pending = finalizePendingNativeMessageFromConversation(messages, conversation, ticketId);
        debugLog("conversation_missing_tracking_token", {
          conversation_id: conversationId,
          ticket_id: ticketId,
          kind: normalizeText(conversation && conversation.kind),
          source: Number(conversation && conversation.source) || 0,
          tracking_source_chars: buildConversationTrackingSource(conversation).length,
          finalized_pending_message_id: pending && pending.id ? pending.id : "",
        });
        if (pending) {
          await writeTrackedMessages(messages);
          debugLog("conversation_finalized_pending_record_without_token", {
            conversation_id: conversationId,
            ticket_id: ticketId,
            message_id: pending.id,
            token_ref: tokenLogRef(pending.token),
            total_records: messages.length,
          });
        }
        return;
      }

      const messages = await readTrackedMessages();
      const existing = messages.find((item) => normalizeText(item.token) === token);
      if (existing) {
        if (!Number(existing.send_response_id) && conversationId) {
          existing.send_response_id = conversationId;
        }
        existing.native_pending = false;
        existing.message_source = existing.message_source || "tracked_send_api";
        existing.conversation_kind = normalizeText(conversation && conversation.kind);
        existing.conversation_source = Number(conversation && conversation.source) || 0;
        existing.sender_email = existing.sender_email || normalizeText(
          conversation && (conversation.from_email || conversation.support_email)
        );
        existing.body_preview = getMessagePreview(buildTrackedMessageFromConversation(conversation, { id: ticketId }, token)) ||
          existing.body_preview;
        await writeTrackedMessages(messages);
        debugLog("conversation_finalized_existing_tracking_record", {
          conversation_id: conversationId,
          ticket_id: ticketId || Number(existing.ticket_id) || 0,
          token_ref: tokenLogRef(token),
          message_id: existing.id,
          total_records: messages.length,
        });
        return;
      }

      if (!ticketId) {
        debugLog("conversation_token_found_without_ticket_id", {
          conversation_id: conversationId,
          token_ref: tokenLogRef(token),
        });
        return;
      }

      const ticket = await fetchTicket(ticketId);
      messages.unshift(buildTrackedMessageFromConversation(conversation, ticket, token));
      await writeTrackedMessages(messages);
      debugLog("conversation_created_tracking_record", {
        conversation_id: conversationId,
        ticket_id: ticketId,
        token_ref: tokenLogRef(token),
        total_records_after: messages.length,
      });
    } catch (error) {
      console.error(
        "Unable to finalize conversation tracking record:",
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

      const relaySignature =
        normalizeText(getHeaderCaseInsensitive(headers, "x-email-tracker-bridge-signature")) ||
        normalizeText(payload.relay_signature);
      if (!verifyRelaySignature(payload, relaySignature)) {
        return buildResponse({
          success: false,
          processed: false,
          message: "Bridge signature verification failed.",
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

      debugLog("external_tracking_event_received", {
        ticket_id: Number(message.ticket_id) || 0,
        token_ref: tokenLogRef(token),
        event_type: eventRecord.event_type,
        native_pending: Boolean(message.native_pending),
        blacklisted: Boolean(eventRecord.blacklisted),
        source_ip: eventRecord.source_ip,
        browser: eventRecord.browser,
        device: eventRecord.device,
      });

      message.opens = [eventRecord, ...(Array.isArray(message.opens) ? message.opens : [])].slice(0, MAX_EVENTS_PER_MESSAGE);
      message.last_event_at = eventRecord.occurred_at;

      let firstHumanOpen = false;
      let ignoredNativeSelfOpen = false;

      if (eventRecord.event_type === "open") {
        if (isLikelyNativeEditorSelfOpen(message, eventRecord)) {
          ignoredNativeSelfOpen = true;
          eventRecord.ignored = true;
          eventRecord.ignore_reason = "native_editor_self_open";
          message.ignored_open_count = (Number(message.ignored_open_count) || 0) + 1;
          message.last_ignored_open_at = eventRecord.occurred_at;
          debugLog("external_tracking_event_ignored_native_editor_self_open", {
            ticket_id: Number(message.ticket_id) || 0,
            token_ref: tokenLogRef(token),
            ignored_open_count: Number(message.ignored_open_count) || 0,
            source_ip: eventRecord.source_ip,
            browser: eventRecord.browser,
            device: eventRecord.device,
          });
        } else if (eventRecord.blacklisted) {
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

      if (eventRecord.event_type === "open" && !eventRecord.blacklisted && !ignoredNativeSelfOpen) {
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
        ignored: Boolean(ignoredNativeSelfOpen),
        open_count: Number(message.open_count) || 0,
        blacklisted_open_count: Number(message.blacklisted_open_count) || 0,
        event_type: eventRecord.event_type,
      });
    } catch (error) {
      return buildErrorResponse("Unable to process the external tracking event.", error);
    }
  },
};
