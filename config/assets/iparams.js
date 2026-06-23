let client;
let domainInput;
let apiKeyInput;
let bridgeSecretInput;
let seenFieldSelect;
let countFieldSelect;
let ipBlacklistInput;
let noteOnFirstOpenInput;
let btnVerify;
let validationMessageDiv;
let fieldStatusBadge;

let verified = false;
let savedConfigs = {};
let fieldOptions = [];

document.onreadystatechange = function () {
  if (document.readyState === "interactive") {
    renderApp();
  }
};

async function renderApp() {
  try {
    client = await app.initialized();
    window.client = client;

    domainInput = document.getElementById("domain");
    apiKeyInput = document.getElementById("apiKey");
    bridgeSecretInput = document.getElementById("bridgeSecret");
    seenFieldSelect = document.getElementById("seenField");
    countFieldSelect = document.getElementById("countField");
    ipBlacklistInput = document.getElementById("ipBlacklist");
    noteOnFirstOpenInput = document.getElementById("noteOnFirstOpen");
    btnVerify = document.getElementById("btnVerify");
    validationMessageDiv = document.getElementById("validationMessage");
    fieldStatusBadge = document.getElementById("fieldStatusBadge");

    btnVerify.addEventListener("click", verifyAndLoadFields);

    [domainInput, apiKeyInput, bridgeSecretInput].forEach((input) => {
      input.addEventListener("input", () => {
        verified = false;
      });
    });
  } catch (error) {
    console.error("Error initializing app:", error);
  }
}

function getBasicAuth(apiKey) {
  return btoa(`${apiKey}:X`);
}

function normalizeDomain(value) {
  let domain = String(value || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain && !domain.includes(".freshdesk.com")) {
    domain = `${domain}.freshdesk.com`;
  }
  return domain;
}

function getEncodedAuthForSavedOrNewKey() {
  const newKeyInput = apiKeyInput.value.trim();
  if (!newKeyInput) {
    return "";
  }

  if (savedConfigs.api_key && newKeyInput === savedConfigs.api_key) {
    return savedConfigs.api_key;
  }

  return getBasicAuth(newKeyInput);
}

async function verifyAndLoadFields() {
  try {
    showValidationMessage("Verifying credentials and loading ticket fields...", "info");

    const domain = normalizeDomain(domainInput.value);
    const apiKey = apiKeyInput.value.trim();
    const savedApiKey = savedConfigs.api_key || "";
    const usingSavedEncodedKey = Boolean(savedApiKey && apiKey === savedApiKey);

    if (!domain) {
      showValidationMessage("Please enter the Freshdesk domain.", "error");
      return;
    }

    if (!apiKey) {
      showValidationMessage("Please enter the API key.", "error");
      return;
    }

    if (!usingSavedEncodedKey) {
      const response = await client.request.invokeTemplate("verify_freshdesk_credentials", {
        context: {
          domain,
          encoded_auth: getBasicAuth(apiKey),
        },
      });

      if (response.status !== 200) {
        throw new Error("Credential verification failed.");
      }
    }

    verified = true;
    await loadFieldOptions(domain, usingSavedEncodedKey ? savedApiKey : getBasicAuth(apiKey));
    showValidationMessage("Verified successfully. Field mapping options are ready.", "success");
  } catch (error) {
    verified = false;
    console.error("Verification error:", error);
    showValidationMessage(resolveVerificationError(error), "error");
  }
}

function resolveVerificationError(error) {
  if (error && Number(error.status) === 401) {
    return "Authentication failed. Please check the API key.";
  }

  if (error && Number(error.status) === 404) {
    return "Domain not found. Please check the Freshdesk domain.";
  }

  if (error && Number(error.status) === 403) {
    return "Access denied. Please check API key permissions.";
  }

  return "Could not verify credentials or load ticket fields. Please check the domain and API key.";
}

async function loadFieldOptions(domain, encodedAuth) {
  const response = await client.request.invokeTemplate("list_install_ticket_fields", {
    context: {
      domain,
      encoded_auth: encodedAuth,
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error("Unable to load ticket fields.");
  }

  let fields = [];
  try {
    fields = JSON.parse(response.response || "[]");
  } catch {
    fields = [];
  }

  fieldOptions = normalizeFields(fields);
  renderFieldSelects();
}

function normalizeFields(fields) {
  const seen = new Set();
  return (Array.isArray(fields) ? fields : [])
    .map((field) => {
      const name = String((field && (field.name || field.id)) || "").trim();
      if (!name) {
        return null;
      }

      return {
        name,
        label: String(
          (field && (field.label_for_agents || field.label || field.title || name)) || name
        ).trim(),
      };
    })
    .filter(Boolean)
    .filter((field) => {
      const key = field.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function renderFieldSelects() {
  const seenFieldValue = seenFieldSelect.value || savedConfigs.seen_field || "";
  const countFieldValue = countFieldSelect.value || savedConfigs.count_field || "";
  const optionsHtml = fieldOptions
    .map((field) => `<option value="${escapeHtml(field.name)}">${escapeHtml(`${field.label} (${field.name})`)}</option>`)
    .join("");

  seenFieldSelect.innerHTML = `<option value="">Do not sync a Seen field</option>${optionsHtml}`;
  countFieldSelect.innerHTML = `<option value="">Do not sync a Count field</option>${optionsHtml}`;
  seenFieldSelect.value = seenFieldValue;
  countFieldSelect.value = countFieldValue;

  fieldStatusBadge.textContent = fieldOptions.length
    ? `${fieldOptions.length} field options loaded`
    : "No field options loaded";
}

function showValidationMessage(message, type) {
  validationMessageDiv.textContent = message;
  validationMessageDiv.className = "status";

  if (type === "success") {
    validationMessageDiv.classList.add("status-success");
  } else if (type === "error") {
    validationMessageDiv.classList.add("status-error");
  } else {
    validationMessageDiv.classList.add("status-info");
  }
}

function postConfigs() {
  const newApiKey = apiKeyInput.value.trim();
  const isKeyUnchanged = savedConfigs.api_key && newApiKey === savedConfigs.api_key;
  const newBridgeSecret = bridgeSecretInput.value.trim();
  const isBridgeSecretUnchanged =
    savedConfigs.bridge_secret && newBridgeSecret === savedConfigs.bridge_secret;

  return {
    __meta: {
      secure: ["api_key", "bridge_secret"],
    },
    domain: normalizeDomain(domainInput.value),
    api_key: isKeyUnchanged ? savedConfigs.api_key : getBasicAuth(newApiKey),
    seen_field: seenFieldSelect.value,
    count_field: countFieldSelect.value,
    bridge_secret: isBridgeSecretUnchanged ? savedConfigs.bridge_secret : newBridgeSecret,
    ip_blacklist: ipBlacklistInput.value,
    note_on_first_open: noteOnFirstOpenInput.checked,
  };
}

function getConfigs(configs) {
  savedConfigs = configs || {};
  domainInput.value = configs.domain || "";
  apiKeyInput.value = configs.api_key || "";
  bridgeSecretInput.value = configs.bridge_secret || "";
  ipBlacklistInput.value = configs.ip_blacklist || "";
  noteOnFirstOpenInput.checked = configs.note_on_first_open !== false;

  if (configs.api_key) {
    verified = true;
  }

  if (configs.domain && configs.api_key) {
    loadFieldOptions(configs.domain, configs.api_key).catch((error) => {
      console.error("Unable to preload field options:", error);
    });
  }
}

async function validate() {
  const domain = normalizeDomain(domainInput.value);
  const apiKey = apiKeyInput.value.trim();

  if (!domain) {
    showValidationMessage("Domain is required.", "error");
    return false;
  }

  if (!apiKey) {
    showValidationMessage("API key is required.", "error");
    return false;
  }

  if (!verified) {
    showValidationMessage("Please verify credentials before saving.", "error");
    return false;
  }

  return true;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value === null || value === undefined ? "" : String(value);
  return div.innerHTML;
}
