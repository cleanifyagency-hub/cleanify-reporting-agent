import { createAuthorizedGoogleClient } from "./google-auth.js";

const DEFAULT_SHEET_ID =
  process.env.CLIENTS_SHEET_ID || "1ZYuXnPDtdWdNctGzh1TmTryB4M3zpUI35V26kbj1amw";

const DEFAULT_SHEET_TAB =
  process.env.CLIENTS_SHEET_TAB || "clientes";

function normalizeHeader(value) {
  return String(value || "").trim();
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function mapRowToClient(headers, row) {
  const data = {};

  headers.forEach((header, index) => {
    data[header] = row[index] ?? "";
  });

  return {
    client_id: cleanString(data.client_id),
    estado: cleanString(data.estado),
    name: cleanString(data.cliente),
    aliases: splitList(data.alias),
    domain: cleanString(data.dominio),
    sector: cleanString(data.sector),
    location: cleanString(data.ubicacion),
    ga4PropertyId: cleanString(data.ga4_property_id),
    searchConsoleSiteUrl: cleanString(data.search_console_site_url),
    gbpAccountId: cleanString(data.gbp_account_id),
    gbpLocationId: cleanString(data.gbp_location_id),
    googleMapsUrl: cleanString(data.google_maps_url),
    priorityServices: splitList(data.servicios_prioritarios),
    keyUrls: splitList(data.urls_clave),
    driveFolderUrl: cleanString(data.carpeta_drive),
    dinorankProject: cleanString(data.proyecto_dinorank),
    responsable: cleanString(data.responsable),
    notes: cleanString(data.notas_reporting),
    raw: data
  };
}

async function getGoogleAccessToken() {
  const auth = createAuthorizedGoogleClient();
  const tokenResponse = await auth.getAccessToken();

  if (typeof tokenResponse === "string") {
    return tokenResponse;
  }

  if (tokenResponse?.token) {
    return tokenResponse.token;
  }

  throw new Error("No se pudo obtener access token de Google para leer Sheets.");
}

export async function getClientsFromSheet({
  sheetId = DEFAULT_SHEET_ID,
  sheetTab = DEFAULT_SHEET_TAB
} = {}) {
  if (!sheetId) {
    throw new Error("Falta CLIENTS_SHEET_ID en variables de entorno.");
  }

  const accessToken = await getGoogleAccessToken();
  const range = encodeURIComponent(`${sheetTab}!A1:R500`);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const responseText = await response.text();

  let json;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(`Google Sheets devolvió una respuesta no JSON: ${responseText}`);
  }

  if (!response.ok) {
    const message =
      json?.error?.message ||
      json?.message ||
      responseText ||
      `HTTP ${response.status}`;

    throw new Error(message);
  }

  const values = Array.isArray(json.values) ? json.values : [];

  if (values.length < 2) {
    return {
      ok: true,
      source: "google_sheet",
      sheetId,
      sheetTab,
      clients: []
    };
  }

  const headers = values[0].map(normalizeHeader);
  const rows = values.slice(1);

  const clients = rows
    .map((row) => mapRowToClient(headers, row))
    .filter((client) => client.client_id && client.name);

  return {
    ok: true,
    source: "google_sheet",
    sheetId,
    sheetTab,
    clients
  };
}
