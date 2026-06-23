import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_SECRET = String(process.env.BRIDGE_SECRET || "dev-email-tracker-bridge-secret").trim();
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function buildRelaySignature(token, hookUrl, secret) {
  return crypto
    .createHash("sha256")
    .update([normalizeText(token), normalizeUrl(hookUrl), normalizeText(secret)].join("|"))
    .digest("hex");
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

async function relayEvent(payload, hookUrl) {
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-email-tracker-bridge-secret": BRIDGE_SECRET,
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
  const hook = normalizeText(url.searchParams.get("hook"));
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

function validateSignedRequest(url) {
  const token = normalizeText(url.searchParams.get("token"));
  const hook = normalizeText(url.searchParams.get("hook"));
  const signature = normalizeText(url.searchParams.get("sig"));

  if (!token || !hook || !signature || !isValidHookUrl(hook)) {
    return false;
  }

  return buildRelaySignature(token, hook, BRIDGE_SECRET) === signature;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "external-email-tracker-bridge",
      });
    }

    if (requestUrl.pathname === "/pixel") {
      const isValid = validateSignedRequest(requestUrl);
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
      const isValid = validateSignedRequest(requestUrl);
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
