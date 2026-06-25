import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_SIGNING_PRIVATE_KEY = String(process.env.BRIDGE_SIGNING_PRIVATE_KEY || "").trim();
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeFreshdeskDomain(value) {
  return normalizeText(value)
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function parseUserAgent(userAgent) {
  const agent = normalizeText(userAgent).toLowerCase();
  if (!agent) {
    return { browser: "Unknown", device: "Unknown" };
  }

  let browser = "Unknown";
  if (agent.includes("edg/")) browser = "Edge";
  else if (agent.includes("chrome/")) browser = "Chrome";
  else if (agent.includes("firefox/")) browser = "Firefox";
  else if (agent.includes("safari/") && !agent.includes("chrome/")) browser = "Safari";
  else if (agent.includes("outlook")) browser = "Outlook";

  let device = "Desktop";
  if (agent.includes("iphone") || agent.includes("android") || agent.includes("mobile")) {
    device = "Mobile";
  } else if (agent.includes("ipad") || agent.includes("tablet")) {
    device = "Tablet";
  }

  return { browser, device };
}

function getSourceIp(req) {
  const forwarded = normalizeText(req.headers["x-forwarded-for"] || "");
  if (forwarded) {
    return normalizeText(forwarded.split(",")[0]);
  }

  return normalizeText(req.socket && req.socket.remoteAddress);
}

function isValidHookUrl(value) {
  try {
    const parsed = new URL(normalizeText(value));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidFreshdeskDomain(value) {
  const domain = normalizeFreshdeskDomain(value);
  return /^[a-z0-9.-]+\.freshdesk\.com$/.test(domain);
}

function appendEmailArray(formData, key, values) {
  (Array.isArray(values) ? values : []).forEach((value) => {
    const email = normalizeText(value);
    if (email) {
      formData.append(`${key}[]`, email);
    }
  });
}

function buildFreshdeskReplyFormData(payload) {
  const formData = new FormData();
  formData.append("body", normalizeText(payload.body));

  const fromEmail = normalizeText(payload.from_email);
  if (fromEmail) {
    formData.append("from_email", fromEmail);
  }

  appendEmailArray(formData, "cc_emails", payload.cc_emails);
  appendEmailArray(formData, "bcc_emails", payload.bcc_emails);

  (Array.isArray(payload.attachments) ? payload.attachments : []).forEach((attachment) => {
    const filename = normalizeText(attachment && attachment.filename);
    const contentType = normalizeText(attachment && attachment.content_type) || "application/octet-stream";
    const dataBase64 = normalizeText(attachment && attachment.data_base64);

    if (!filename || !dataBase64) {
      throw new Error("Attachment filename and data are required.");
    }

    const blob = new Blob([Buffer.from(dataBase64, "base64")], { type: contentType });
    formData.append("attachments[]", blob, filename);
  });

  return formData;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function sendFreshdeskReplyWithAttachments(payload) {
  const domain = normalizeFreshdeskDomain(payload.domain);
  const apiKey = normalizeText(payload.api_key);
  const ticketId = Number(payload.ticket_id) || 0;

  if (!isValidFreshdeskDomain(domain)) {
    return { status: 400, body: { success: false, message: "Invalid Freshdesk domain." } };
  }

  if (!apiKey || !ticketId || !normalizeText(payload.body)) {
    return { status: 400, body: { success: false, message: "domain, api_key, ticket_id, and body are required." } };
  }

  const response = await fetch(`https://${domain}/api/v2/tickets/${ticketId}/reply`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
    },
    body: buildFreshdeskReplyFormData(payload),
  });
  const responseText = await response.text();
  let responseBody = responseText;

  try {
    responseBody = JSON.parse(responseText || "null");
  } catch {
    // Freshdesk can return plain text for some errors.
  }

  if (!response.ok) {
    return {
      status: response.status >= 500 ? 502 : response.status,
      body: {
        success: false,
        message: "Freshdesk reply API failed.",
        status: response.status,
        detail: responseBody,
      },
    };
  }

  return { status: 200, body: responseBody || { success: true } };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendPixel(res) {
  res.writeHead(200, {
    "Content-Type": "image/gif",
    "Content-Length": PIXEL_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(PIXEL_GIF);
}

function buildRelaySigningPayload(payload) {
  return JSON.stringify({
    event_type: normalizeText(payload.event_type).toLowerCase() === "click" ? "click" : "open",
    token: normalizeText(payload.token),
    occurred_at: normalizeText(payload.occurred_at),
    source_ip: normalizeText(payload.source_ip),
    user_agent: normalizeText(payload.user_agent),
    browser: normalizeText(payload.browser),
    device: normalizeText(payload.device),
    country: normalizeText(payload.country),
    city: normalizeText(payload.city),
    target: normalizeText(payload.target),
  });
}

function signRelayPayload(payload) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(buildRelaySigningPayload(payload));
  signer.end();
  return signer.sign(BRIDGE_SIGNING_PRIVATE_KEY).toString("base64");
}

async function relayEvent(payload, hookUrl) {
  const relaySignature = signRelayPayload(payload);
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-email-tracker-bridge-signature": relaySignature,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Relay failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

function buildEventPayload(req, url, eventType) {
  const token = normalizeText(url.searchParams.get("token"));
  const userAgent = normalizeText(req.headers["user-agent"]);
  const sourceIp = getSourceIp(req);
  const parsedAgent = parseUserAgent(userAgent);

  return {
    event_type: eventType,
    token,
    occurred_at: new Date().toISOString(),
    source_ip: sourceIp,
    user_agent: userAgent,
    browser: parsedAgent.browser,
    device: parsedAgent.device,
  };
}

function validatePixelRequest(url) {
  const token = normalizeText(url.searchParams.get("token"));
  const hook = normalizeText(url.searchParams.get("hook"));
  return Boolean(token && hook && isValidHookUrl(hook));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!BRIDGE_SIGNING_PRIVATE_KEY) {
      return sendJson(res, 500, {
        success: false,
        message: "Bridge signing key is not configured.",
      });
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "external-email-tracker-bridge",
      });
    }

    if (requestUrl.pathname === "/freshdesk/reply") {
      if (req.method !== "POST") {
        return sendJson(res, 405, {
          success: false,
          message: "Method not allowed.",
        });
      }

      const payload = await readJsonBody(req).catch(() => null);
      if (!payload || typeof payload !== "object") {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid JSON payload.",
        });
      }

      const result = await sendFreshdeskReplyWithAttachments(payload);
      return sendJson(res, result.status, result.body);
    }

    if (requestUrl.pathname === "/pixel") {
      const isValid = validatePixelRequest(requestUrl);
      if (isValid) {
        const hook = normalizeText(requestUrl.searchParams.get("hook"));
        const payload = buildEventPayload(req, requestUrl, "open");
        relayEvent(payload, hook).catch((error) => {
          console.error("Pixel relay failed:", error.message);
        });
      } else {
        console.warn("Rejected invalid pixel request", {
          token: normalizeText(requestUrl.searchParams.get("token")),
          hook: normalizeText(requestUrl.searchParams.get("hook")),
        });
      }

      return sendPixel(res);
    }

    if (requestUrl.pathname === "/click") {
      const isValid = validatePixelRequest(requestUrl);
      const redirectUrl = normalizeText(requestUrl.searchParams.get("target"));

      if (!isValid || !isValidHookUrl(redirectUrl)) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid click tracking request.",
        });
      }

      const hook = normalizeText(requestUrl.searchParams.get("hook"));
      const payload = {
        ...buildEventPayload(req, requestUrl, "click"),
        target: redirectUrl,
      };

      relayEvent(payload, hook).catch((error) => {
        console.error("Click relay failed:", error.message);
      });

      res.writeHead(302, {
        Location: redirectUrl,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    sendJson(res, 404, {
      success: false,
      message: "Not found.",
    });
  } catch (error) {
    console.error("Bridge request failed:", error);
    sendJson(res, 500, {
      success: false,
      message: "Bridge request failed.",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Email tracker bridge listening on http://localhost:${PORT}`);
});
