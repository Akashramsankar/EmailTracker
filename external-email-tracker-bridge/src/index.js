const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="),
  (char) => char.charCodeAt(0)
);

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
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

function getSourceIp(request) {
  const forwarded = normalizeText(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for"));
  if (forwarded) {
    return normalizeText(forwarded.split(",")[0]);
  }

  return "";
}

function isValidUrl(value, { allowHttp = false } = {}) {
  try {
    const parsed = new URL(normalizeText(value));
    return parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
  } catch {
    return false;
  }
}

function isValidFreshdeskDomain(value) {
  const domain = normalizeFreshdeskDomain(value);
  return /^[a-z0-9.-]+\.freshdesk\.com$/.test(domain);
}

function bytesFromBase64(value) {
  const binary = atob(normalizeText(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

    const blob = new Blob([bytesFromBase64(dataBase64)], { type: contentType });
    formData.append("attachments[]", blob, filename);
  });

  return formData;
}

async function sendFreshdeskReplyWithAttachments(payload) {
  const domain = normalizeFreshdeskDomain(payload.domain);
  const apiKey = normalizeText(payload.api_key);
  const ticketId = Number(payload.ticket_id) || 0;

  if (!isValidFreshdeskDomain(domain)) {
    return json({ success: false, message: "Invalid Freshdesk domain." }, { status: 400 });
  }

  if (!apiKey || !ticketId || !normalizeText(payload.body)) {
    return json({ success: false, message: "domain, api_key, ticket_id, and body are required." }, { status: 400 });
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
    return json(
      {
        success: false,
        message: "Freshdesk reply API failed.",
        status: response.status,
        detail: responseBody,
      },
      { status: response.status >= 500 ? 502 : response.status }
    );
  }

  return json(responseBody || { success: true });
}

function buildEventPayload(request, requestUrl, eventType) {
  const token = normalizeText(requestUrl.searchParams.get("token"));
  const userAgent = normalizeText(request.headers.get("user-agent"));
  const sourceIp = getSourceIp(request);
  const parsedAgent = parseUserAgent(userAgent);

  return {
    event_type: eventType,
    token,
    occurred_at: new Date().toISOString(),
    source_ip: sourceIp,
    user_agent: userAgent,
    browser: parsedAgent.browser,
    device: parsedAgent.device,
    colo: normalizeText(request.cf && request.cf.colo),
    country: normalizeText(request.cf && request.cf.country),
    city: normalizeText(request.cf && request.cf.city),
  };
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

function pemToArrayBuffer(pem) {
  const base64 = normalizeText(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function importPrivateKey(privateKeyPem) {
  return await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

async function signRelayPayload(payload, privateKeyPem) {
  const signingKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(buildRelaySigningPayload(payload))
  );
  const signatureBytes = new Uint8Array(signature);
  let binary = "";
  signatureBytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function validatePixelRequest(requestUrl) {
  const token = normalizeText(requestUrl.searchParams.get("token"));
  const hook = normalizeText(requestUrl.searchParams.get("hook"));
  return Boolean(token && hook && isValidUrl(hook, { allowHttp: true }));
}

async function relayEvent(payload, hookUrl, secret) {
  const relaySignature = await signRelayPayload(payload, secret);
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

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function pixelResponse() {
  return new Response(PIXEL_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const privateKeyPem = normalizeText(env.BRIDGE_SIGNING_PRIVATE_KEY || "");

    if (!privateKeyPem) {
      return json(
        {
          success: false,
          message: "Bridge signing key is not configured.",
        },
        { status: 500 }
      );
    }

    if (requestUrl.pathname === "/health") {
      return json({
        ok: true,
        service: "external-email-tracker-bridge-worker",
      });
    }

    if (requestUrl.pathname === "/freshdesk/reply") {
      if (request.method !== "POST") {
        return json({ success: false, message: "Method not allowed." }, { status: 405 });
      }

      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return json({ success: false, message: "Invalid JSON payload." }, { status: 400 });
      }

      return await sendFreshdeskReplyWithAttachments(payload);
    }

    if (requestUrl.pathname === "/pixel") {
      const isValid = validatePixelRequest(requestUrl);
      if (isValid) {
        const hook = normalizeText(requestUrl.searchParams.get("hook"));
        const payload = buildEventPayload(request, requestUrl, "open");
        ctx.waitUntil(
          relayEvent(payload, hook, privateKeyPem).catch((error) => {
            console.error("Pixel relay failed:", error.message);
          })
        );
      } else {
        console.warn("Rejected invalid pixel request", {
          token: normalizeText(requestUrl.searchParams.get("token")),
          hook: normalizeText(requestUrl.searchParams.get("hook")),
        });
      }

      return pixelResponse();
    }

    if (requestUrl.pathname === "/click") {
      const isValid = validatePixelRequest(requestUrl);
      const redirectUrl = normalizeText(requestUrl.searchParams.get("target"));

      if (!isValid || !isValidUrl(redirectUrl, { allowHttp: true })) {
        return json(
          {
            success: false,
            message: "Invalid click tracking request.",
          },
          { status: 400 }
        );
      }

      const hook = normalizeText(requestUrl.searchParams.get("hook"));
      const payload = {
        ...buildEventPayload(request, requestUrl, "click"),
        target: redirectUrl,
      };

      ctx.waitUntil(
        relayEvent(payload, hook, privateKeyPem).catch((error) => {
          console.error("Click relay failed:", error.message);
        })
      );

      return Response.redirect(redirectUrl, 302);
    }

    return json(
      {
        success: false,
        message: "Not found.",
      },
      { status: 404 }
    );
  },
};
