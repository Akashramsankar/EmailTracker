let client;
let state = {
  ticketId: 0,
  lastSignature: "",
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    await syncLiveTicketFieldMetadata(true);

    client.events.on("app.activated", () => {
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
}
