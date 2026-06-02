import {
  getGoogleAuthUrl,
  exchangeGoogleCodeForTokens,
  createAuthorizedGoogleClient
} from "./google-auth.js";
import { getSearchConsoleMonthlyData } from "./google-search-console.js";
import { getClientsFromSheet } from "./google-sheets-clients.js";
import { listAvailableAssets, resolveClientAssets } from "./google-assets.js";
import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.PUBLIC_BASE_URL || "https://reportes.cleanify.agency";
const APP_VERSION = "1.10.1-locked-cleanify-v7-routes";

app.use(express.json({ limit: "4mb" }));

const REPORTS_DIR = process.env.REPORTS_DIR || "/tmp/cleanify-reports";
const CLEANIFY_LOGO_URL = process.env.CLEANIFY_LOGO_URL || "";


function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeDomain(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^sc-domain:/, "")
    .replace(/\/$/, "")
    .trim();
}

const MONTHS_ES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11
};

const MONTH_LABELS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre"
];

const CLIENT_DIRECTORY = [
  {
    aliases: ["island servi", "islandservi", "island service", "islandservi.com"],
    name: "Island Servi",
    domain: "islandservi.com",
    ga4PropertyId: "527890206",
    searchConsoleSiteUrl: "https://islandservi.com/",
    sector: "Empresa de limpieza y servicios auxiliares",
    location: "Canarias",
    priorityServices: [
      "limpieza",
      "limpieza de obras",
      "servicios auxiliares",
      "eventos",
      "productoras y rodajes"
    ]
  },
  {
    aliases: ["econeta", "econeta.es"],
    name: "Econeta",
    domain: "econeta.es",
    ga4PropertyId: "526346028",
    searchConsoleSiteUrl: "https://econeta.es/",
    sector: "Empresa de limpieza",
    location: "Tarragona"
  },
  {
    aliases: ["bioneteja", "bioneteja.es"],
    name: "Bioneteja",
    domain: "bioneteja.es",
    ga4PropertyId: "514390669",
    searchConsoleSiteUrl: "https://bioneteja.es/",
    sector: "Empresa de limpieza"
  },
  {
    aliases: ["chococlean", "choco clean", "chococlean.net"],
    name: "ChocoClean",
    domain: "chococlean.net",
    ga4PropertyId: "526871968",
    searchConsoleSiteUrl: "https://chococlean.net/",
    sector: "Empresa de limpieza"
  },
  {
    aliases: ["limpio y clic", "limpio&clic", "limpio clic", "limpioyclic", "limpioyclic.es"],
    name: "Limpio&Clic",
    domain: "limpioyclic.es",
    ga4PropertyId: "529777178",
    searchConsoleSiteUrl: "sc-domain:limpioyclic.es",
    sector: "Empresa de limpieza"
  },
  {
    aliases: ["tintorerias charo", "tintorerías charo", "tintoreriascharo", "tintoreriascharo.es"],
    name: "Tintorerías Charo",
    domain: "tintoreriascharo.es",
    ga4PropertyId: "471906677",
    searchConsoleSiteUrl: "https://tintoreriascharo.es/",
    sector: "Tintorería"
  },
  {
    aliases: ["perez sierra", "pérez sierra", "limpiezas perez sierra", "limpiezasperezsierra.com"],
    name: "Limpiezas Pérez Sierra",
    domain: "limpiezasperezsierra.com",
    ga4PropertyId: "522886852",
    searchConsoleSiteUrl: "http://limpiezasperezsierra.com/",
    sector: "Empresa de limpieza"
  }
];

function sheetClientToKnownClient(client = {}) {
  return {
    aliases: [
      ...(Array.isArray(client.aliases) ? client.aliases : []),
      client.name,
      client.domain,
      client.client_id
    ].filter(Boolean),
    name: client.name,
    domain: client.domain,
    ga4PropertyId: client.ga4PropertyId || undefined,
    searchConsoleSiteUrl: client.searchConsoleSiteUrl || undefined,
    sector: client.sector || null,
    location: client.location || null,
    priorityServices: client.priorityServices || []
  };
}

async function getKnownClientDirectory() {
  try {
    const sheetResult = await getClientsFromSheet();
    const sheetClients = Array.isArray(sheetResult?.clients) ? sheetResult.clients : [];

    if (sheetClients.length > 0) {
      return {
        source: "google_sheet",
        clients: sheetClients.map(sheetClientToKnownClient)
      };
    }

    return {
      source: "fallback_server_empty_sheet",
      clients: CLIENT_DIRECTORY
    };
  } catch (error) {
    console.warn("No se pudo cargar el directorio desde Google Sheets. Se usa fallback local:", error.message);

    return {
      source: "fallback_server",
      error: error.message,
      clients: CLIENT_DIRECTORY
    };
  }
}

function findKnownClientInDirectory(input = {}, directory = CLIENT_DIRECTORY) {
  const client = input.client || {};

  const candidates = [
    input.clientName,
    input.name,
    input.client_name,
    input.projectName,
    input.project_name,
    input.domain,
    input.clientDomain,
    input.client_domain,
    client.name,
    client.domain,
    input.search_console?.siteUrl,
    input.searchConsoleSiteUrl,
    input.siteUrl
  ].filter(Boolean);

  const normalizedCandidates = candidates.map((candidate) => ({
    text: normalizeText(candidate),
    domain: normalizeDomain(candidate)
  }));

  return directory.find((known) => {
    const knownAliases = (known.aliases || []).map(normalizeText);
    const knownDomains = [
      known.domain,
      known.searchConsoleSiteUrl,
      ...(known.aliases || [])
    ].map(normalizeDomain);

    return normalizedCandidates.some((candidate) => {
      return (
        knownAliases.some((alias) =>
          alias &&
          (
            candidate.text === alias ||
            candidate.text.includes(alias) ||
            alias.includes(candidate.text)
          )
        ) ||
        knownDomains.some((domain) =>
          domain &&
          (
            candidate.domain === domain ||
            candidate.domain.includes(domain) ||
            domain.includes(candidate.domain)
          )
        )
      );
    });
  }) || null;
}

function findKnownClient(input = {}) {
  return findKnownClientInDirectory(input, CLIENT_DIRECTORY);
}

async function findKnownClientAsync(input = {}) {
  const directory = await getKnownClientDirectory();
  return findKnownClientInDirectory(input, directory.clients);
}


function formatDateYYYYMMDD(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMonthDateRange(year, monthIndex) {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    startDate: formatDateYYYYMMDD(start),
    endDate: formatDateYYYYMMDD(end)
  };
}

function monthLabel(year, monthIndex) {
  return `${MONTH_LABELS_ES[monthIndex]} ${year}`;
}

function parseMonthAndYear(input = {}) {
  const period = input.period || {};
  const rawMonth =
    input.month ||
    input.reportMonth ||
    input.report_month ||
    period.month ||
    "";

  const rawYear =
    input.year ||
    input.reportYear ||
    input.report_year ||
    "";

  if (Number.isInteger(Number(rawMonth)) && Number(rawMonth) >= 1 && Number(rawMonth) <= 12) {
    const year = Number(rawYear) || new Date().getUTCFullYear();
    return {
      year,
      monthIndex: Number(rawMonth) - 1
    };
  }

  const normalized = normalizeText(rawMonth);
  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const parsedYear = Number(rawYear) || (yearMatch ? Number(yearMatch[1]) : null);

  const monthEntry = Object.entries(MONTHS_ES).find(([name]) =>
    normalized.includes(name)
  );

  if (!monthEntry || !parsedYear) {
    return null;
  }

  return {
    year: parsedYear,
    monthIndex: monthEntry[1]
  };
}

function deriveMonthlyDatesFromInput(input = {}) {
  const parsed = parseMonthAndYear(input);
  if (!parsed) return null;

  const current = getMonthDateRange(parsed.year, parsed.monthIndex);
  const previousDate = new Date(Date.UTC(parsed.year, parsed.monthIndex - 1, 1));
  const previousYear = previousDate.getUTCFullYear();
  const previousMonthIndex = previousDate.getUTCMonth();
  const previous = getMonthDateRange(previousYear, previousMonthIndex);

  return {
    month: monthLabel(parsed.year, parsed.monthIndex),
    previous_month: monthLabel(previousYear, previousMonthIndex),
    startDate: current.startDate,
    endDate: current.endDate,
    previousStartDate: previous.startDate,
    previousEndDate: previous.endDate
  };
}

function prepareReportInputWithKnownClient(input = {}, knownClient = null) {
  const derivedDates = deriveMonthlyDatesFromInput(input);

  const client = input.client || {};
  const ga4Input = input.ga4 || {};
  const searchConsoleInput = input.search_console || {};

  const domain =
    client.domain ||
    input.domain ||
    input.clientDomain ||
    input.client_domain ||
    knownClient?.domain ||
    null;

  const clientName =
    client.name ||
    input.clientName ||
    input.client_name ||
    input.name ||
    knownClient?.name ||
    null;

  const finalClient = {
    ...client,
    name: clientName || "Cliente sin nombre",
    sector: client.sector || input.sector || knownClient?.sector || null,
    location: client.location || input.location || knownClient?.location || null,
    domain,
    priority_services:
      client.priority_services ||
      input.priority_services ||
      input.priorityServices ||
      knownClient?.priorityServices ||
      []
  };

  const startDate =
    ga4Input.startDate ||
    searchConsoleInput.startDate ||
    input.startDate ||
    derivedDates?.startDate;

  const endDate =
    ga4Input.endDate ||
    searchConsoleInput.endDate ||
    input.endDate ||
    derivedDates?.endDate;

  const previousStartDate =
    ga4Input.previousStartDate ||
    searchConsoleInput.previousStartDate ||
    input.previousStartDate ||
    derivedDates?.previousStartDate;

  const previousEndDate =
    ga4Input.previousEndDate ||
    searchConsoleInput.previousEndDate ||
    input.previousEndDate ||
    derivedDates?.previousEndDate;

  const period = {
    ...(input.period || {}),
    month: input.period?.month || derivedDates?.month || input.month || null,
    previous_month:
      input.period?.previous_month ||
      derivedDates?.previous_month ||
      input.previous_month ||
      input.previousMonth ||
      null
  };

  const finalGa4 = {
    ...ga4Input,
    propertyId:
      ga4Input.propertyId ||
      input.ga4PropertyId ||
      input.propertyId ||
      knownClient?.ga4PropertyId ||
      undefined,
    startDate: ga4Input.startDate || startDate,
    endDate: ga4Input.endDate || endDate,
    previousStartDate: ga4Input.previousStartDate || previousStartDate,
    previousEndDate: ga4Input.previousEndDate || previousEndDate
  };

  const finalSearchConsole = {
    ...searchConsoleInput,
    siteUrl:
      searchConsoleInput.siteUrl ||
      input.searchConsoleSiteUrl ||
      input.siteUrl ||
      knownClient?.searchConsoleSiteUrl ||
      undefined,
    startDate: searchConsoleInput.startDate || startDate,
    endDate: searchConsoleInput.endDate || endDate,
    previousStartDate: searchConsoleInput.previousStartDate || previousStartDate,
    previousEndDate: searchConsoleInput.previousEndDate || previousEndDate
  };

  return {
    ...input,
    client: finalClient,
    period,
    ga4: finalGa4,
    search_console: finalSearchConsole,
    tasks_done: input.tasks_done || input.tasksDone || [],
    next_month_actions: input.next_month_actions || input.nextMonthActions || [],
    client_needs: input.client_needs || input.clientNeeds || []
  };
}

function prepareReportInput(input = {}) {
  const knownClient = findKnownClient(input);
  return prepareReportInputWithKnownClient(input, knownClient);
}

async function prepareReportInputAsync(input = {}) {
  const knownClient = await findKnownClientAsync(input);
  return prepareReportInputWithKnownClient(input, knownClient);
}


function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function cleanPropertyId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.replace(/^properties\//, "");
}

function compare(current, previous) {
  const currentNumber = safeNumber(current);
  const previousNumber = safeNumber(previous);

  if (currentNumber === null || previousNumber === null) {
    return {
      current: current ?? null,
      previous: previous ?? null,
      difference: null,
      percent_change: null,
      trend: "sin_comparativa"
    };
  }

  const difference = currentNumber - previousNumber;
  const percentChange = previousNumber === 0
    ? null
    : Number(((difference / previousNumber) * 100).toFixed(2));

  let trend = "estable";
  if (difference > 0) trend = "sube";
  if (difference < 0) trend = "baja";

  return {
    current: currentNumber,
    previous: previousNumber,
    difference,
    percent_change: percentChange,
    trend
  };
}

function findMetric(row, metricHeaders, metricName) {
  const index = metricHeaders.findIndex((header) => header.name === metricName);
  if (index === -1) return null;
  return safeNumber(row?.metricValues?.[index]?.value);
}

function findDimension(row, dimensionHeaders, dimensionName) {
  const index = dimensionHeaders.findIndex((header) => header.name === dimensionName);
  if (index === -1) return null;
  return row?.dimensionValues?.[index]?.value ?? null;
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

  throw new Error("No se pudo obtener access token de Google.");
}

async function runGa4Report({ propertyId, dateRanges, metrics, dimensions = [], limit = 10, orderBys = [] }) {
  const cleanId = cleanPropertyId(propertyId);

  if (!cleanId) {
    throw new Error("Falta propertyId de GA4.");
  }

  const accessToken = await getGoogleAccessToken();

  const body = {
    dateRanges,
    metrics: metrics.map((name) => ({ name })),
    dimensions: dimensions.map((name) => ({ name })),
    limit: String(limit),
    returnPropertyQuota: true
  };

  if (orderBys.length > 0) {
    body.orderBys = orderBys;
  }

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${cleanId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const responseText = await response.text();

  let json;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(`GA4 devolvió una respuesta no JSON: ${responseText}`);
  }

  if (!response.ok) {
    const message =
      json?.error?.message ||
      json?.message ||
      responseText ||
      `HTTP ${response.status}`;

    throw new Error(message);
  }

  return json;
}

function parseGa4Summary(report) {
  const metricHeaders = report.metricHeaders || [];
  const rows = report.rows || [];
  const row = rows[0] || {};

  return {
    activeUsers: findMetric(row, metricHeaders, "activeUsers") ?? 0,
    totalUsers: findMetric(row, metricHeaders, "totalUsers") ?? 0,
    sessions: findMetric(row, metricHeaders, "sessions") ?? 0,
    engagedSessions: findMetric(row, metricHeaders, "engagedSessions") ?? 0,
    eventCount: findMetric(row, metricHeaders, "eventCount") ?? 0,
    engagementRate: findMetric(row, metricHeaders, "engagementRate") ?? null,
    screenPageViews: findMetric(row, metricHeaders, "screenPageViews") ?? 0
  };
}

function parseGa4DimensionRows(report, dimensionName, metricNames) {
  const dimensionHeaders = report.dimensionHeaders || [];
  const metricHeaders = report.metricHeaders || [];
  const rows = report.rows || [];

  return rows.map((row) => {
    const item = {
      [dimensionName]: findDimension(row, dimensionHeaders, dimensionName)
    };

    for (const metricName of metricNames) {
      item[metricName] = findMetric(row, metricHeaders, metricName) ?? 0;
    }

    return item;
  });
}

function classifyLeadEvents(events) {
  const leadPatterns = [
    "lead",
    "form",
    "submit",
    "enviar",
    "contact",
    "contacto",
    "whatsapp",
    "phone",
    "telefono",
    "teléfono",
    "call",
    "click_tel",
    "click_phone",
    "generate_lead"
  ];

  const normalizedPatterns = leadPatterns.map(normalizeText);

  return events
    .filter((event) => {
      const eventName = normalizeText(event.eventName);
      return normalizedPatterns.some((pattern) => eventName.includes(pattern));
    })
    .map((event) => ({
      eventName: event.eventName,
      eventCount: event.eventCount || 0
    }));
}

function buildGa4Signals(ga4) {
  const signals = [];

  const users = compare(ga4.users, ga4.previous_users);
  const sessions = compare(ga4.sessions, ga4.previous_sessions);
  const events = compare(ga4.event_count, ga4.previous_event_count);
  const conversions = compare(ga4.conversions, ga4.previous_conversions);

  if (ga4.real_data_loaded) {
    signals.push("Se han cargado datos reales de GA4 para este informe.");
  }

  if (users.trend === "sube") {
    signals.push("Aumentan los usuarios activos en la web según GA4.");
  }

  if (sessions.trend === "sube") {
    signals.push("Aumentan las sesiones registradas en la web.");
  }

  if (events.trend === "sube") {
    signals.push("Aumenta la actividad registrada en eventos de GA4.");
  }

  if (conversions.trend === "sube") {
    signals.push("Aumentan los eventos de contacto o conversión detectados en GA4.");
  }

  if (ga4.real_data_loaded && users.trend !== "sube" && sessions.trend !== "sube") {
    signals.push(
      "El tráfico web todavía no muestra un crecimiento claro en GA4; conviene interpretar este dato junto con Search Console, llamadas, formularios y tareas realizadas."
    );
  }

  return signals;
}

function buildSearchConsoleSignals(searchConsole) {
  const signals = [];

  const clicks = compare(searchConsole.clicks, searchConsole.previous_clicks);
  const impressions = compare(searchConsole.impressions, searchConsole.previous_impressions);
  const ctr = compare(searchConsole.ctr, searchConsole.previous_ctr);
  const averagePosition = compare(
    searchConsole.average_position,
    searchConsole.previous_average_position
  );

  if (searchConsole.real_data_loaded) {
    signals.push("Se han cargado datos reales de Google Search Console para este informe.");
  }

  if (clicks.trend === "sube") {
    signals.push("Aumentan los clics orgánicos desde Google Search Console.");
  }

  if (impressions.trend === "sube") {
    signals.push("Aumentan las impresiones, señal de mayor visibilidad en búsquedas.");
  }

  if (ctr.trend === "baja" && impressions.trend === "sube") {
    signals.push(
      "El CTR baja mientras suben las impresiones. Esto puede indicar que la web empieza a aparecer en más búsquedas, pero conviene optimizar titles, metadescriptions y páginas con muchas impresiones."
    );
  }

  if (
    averagePosition.current !== null &&
    averagePosition.previous !== null &&
    averagePosition.current > averagePosition.previous
  ) {
    signals.push(
      "La posición media empeora. En Search Console, un número menor es mejor, así que conviene revisar consultas con visibilidad pero posiciones todavía mejorables."
    );
  }

  if (
    averagePosition.current !== null &&
    averagePosition.previous !== null &&
    averagePosition.current < averagePosition.previous
  ) {
    signals.push(
      "La posición media mejora. En Search Console, un número menor es mejor."
    );
  }

  const topQueries = Array.isArray(searchConsole.top_queries)
    ? searchConsole.top_queries
    : [];

  if (topQueries.length > 0) {
    const relevantQueries = topQueries
      .slice(0, 5)
      .map((query) => query.query)
      .filter(Boolean);

    if (relevantQueries.length > 0) {
      signals.push(
        `Las principales consultas detectadas son: ${relevantQueries.join(", ")}.`
      );
    }
  }

  return signals;
}

function findBestGa4Asset(assets, input = {}) {
  const ga4Assets = Array.isArray(assets?.ga4) ? assets.ga4 : [];

  const wantedPropertyId = cleanPropertyId(input.propertyId || input.propertyResourceName);
  const wantedDomain = normalizeDomain(input.domain || input.clientDomain);
  const wantedClientName = normalizeText(input.clientName || input.client?.name || input.name);

  if (wantedPropertyId) {
    const byId = ga4Assets.find((asset) => cleanPropertyId(asset.propertyId) === wantedPropertyId);
    if (byId) return byId;
  }

  if (wantedDomain) {
    const byDomain = ga4Assets.find((asset) => {
      const propertyName = normalizeDomain(asset.propertyName);
      const normalizedPropertyName = normalizeDomain(asset.normalizedPropertyName);
      const accountName = normalizeDomain(asset.accountName);
      return (
        propertyName.includes(wantedDomain) ||
        normalizedPropertyName.includes(wantedDomain) ||
        accountName.includes(wantedDomain) ||
        wantedDomain.includes(propertyName)
      );
    });

    if (byDomain) return byDomain;
  }

  if (wantedClientName) {
    const byName = ga4Assets.find((asset) => {
      const propertyName = normalizeText(asset.propertyName);
      const normalizedPropertyName = normalizeText(asset.normalizedPropertyName);
      const accountName = normalizeText(asset.accountName);
      return (
        propertyName.includes(wantedClientName) ||
        normalizedPropertyName.includes(wantedClientName) ||
        accountName.includes(wantedClientName) ||
        wantedClientName.includes(propertyName) ||
        wantedClientName.includes(accountName)
      );
    });

    if (byName) return byName;
  }

  return null;
}

function findBestSearchConsoleAsset(assets, input = {}) {
  const scAssets = Array.isArray(assets?.search_console) ? assets.search_console : [];

  const wantedSiteUrl = String(input.siteUrl || "").trim();
  const wantedDomain = normalizeDomain(input.domain || input.clientDomain || wantedSiteUrl);
  const wantedClientName = normalizeText(input.clientName || input.client?.name || input.name);

  if (wantedSiteUrl) {
    const bySiteUrl = scAssets.find((asset) => asset.siteUrl === wantedSiteUrl);
    if (bySiteUrl) return bySiteUrl;
  }

  if (wantedDomain) {
    const byDomain = scAssets.find((asset) => {
      const assetDomain = normalizeDomain(asset.domain || asset.siteUrl);
      return assetDomain === wantedDomain || assetDomain.includes(wantedDomain) || wantedDomain.includes(assetDomain);
    });

    if (byDomain) return byDomain;
  }

  if (wantedClientName) {
    const byName = scAssets.find((asset) => {
      const assetDomain = normalizeText(asset.domain || asset.siteUrl);
      return assetDomain.includes(wantedClientName) || wantedClientName.includes(assetDomain);
    });

    if (byName) return byName;
  }

  return null;
}

async function resolveGoogleAssetsForClient(input = {}) {
  const assets = await listAvailableAssets();

  let resolverOutput = null;
  try {
    resolverOutput = await resolveClientAssets({
      clientName: input.clientName || input.client?.name || input.name,
      domain: input.domain || input.client?.domain || input.clientDomain,
      location: input.location || input.client?.location
    });
  } catch (error) {
    resolverOutput = {
      ok: false,
      error: error.message
    };
  }

  const ga4 = findBestGa4Asset(assets, {
    propertyId: input.propertyId,
    propertyResourceName: input.propertyResourceName,
    domain: input.domain || input.client?.domain || input.clientDomain,
    clientName: input.clientName || input.client?.name || input.name
  });

  const searchConsole = findBestSearchConsoleAsset(assets, {
    siteUrl: input.siteUrl,
    domain: input.domain || input.client?.domain || input.clientDomain,
    clientName: input.clientName || input.client?.name || input.name
  });

  return {
    ok: true,
    version: APP_VERSION,
    assets_count: {
      search_console: Array.isArray(assets.search_console) ? assets.search_console.length : 0,
      ga4: Array.isArray(assets.ga4) ? assets.ga4.length : 0
    },
    matched: {
      ga4,
      search_console: searchConsole
    },
    resolver_output: resolverOutput,
    all_assets: assets
  };
}

async function getGa4MonthlyData({
  propertyId,
  propertyResourceName,
  clientName,
  domain,
  location,
  startDate,
  endDate,
  previousStartDate,
  previousEndDate,
  rowLimit = 10
}) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    throw new Error("GA4 necesita startDate y endDate en formato YYYY-MM-DD.");
  }

  let resolvedAssets = null;
  let resolvedProperty = null;
  let finalPropertyId = cleanPropertyId(propertyId || propertyResourceName);

  if (!finalPropertyId) {
    resolvedAssets = await resolveGoogleAssetsForClient({
      propertyId,
      propertyResourceName,
      clientName,
      domain,
      location
    });

    resolvedProperty = resolvedAssets.matched.ga4;

    if (!resolvedProperty?.propertyId) {
      throw new Error(
        "No se pudo resolver automáticamente la propiedad GA4. Pasa propertyId o un domain/clientName que coincida con /google/assets."
      );
    }

    finalPropertyId = cleanPropertyId(resolvedProperty.propertyId);
  } else {
    const assets = await listAvailableAssets();
    resolvedProperty = findBestGa4Asset(assets, { propertyId: finalPropertyId }) || {
      propertyId: finalPropertyId,
      propertyResourceName: `properties/${finalPropertyId}`,
      propertyName: null,
      accountName: null
    };
  }

  const currentSummaryReport = await runGa4Report({
    propertyId: finalPropertyId,
    dateRanges: [{ startDate, endDate }],
    metrics: [
      "activeUsers",
      "totalUsers",
      "sessions",
      "engagedSessions",
      "eventCount",
      "engagementRate",
      "screenPageViews"
    ],
    limit: 1
  });

  const currentSummary = parseGa4Summary(currentSummaryReport);

  let previousSummary = null;
  if (isValidDate(previousStartDate) && isValidDate(previousEndDate)) {
    const previousSummaryReport = await runGa4Report({
      propertyId: finalPropertyId,
      dateRanges: [{ startDate: previousStartDate, endDate: previousEndDate }],
      metrics: [
        "activeUsers",
        "totalUsers",
        "sessions",
        "engagedSessions",
        "eventCount",
        "engagementRate",
        "screenPageViews"
      ],
      limit: 1
    });

    previousSummary = parseGa4Summary(previousSummaryReport);
  }

  const eventsReport = await runGa4Report({
    propertyId: finalPropertyId,
    dateRanges: [{ startDate, endDate }],
    dimensions: ["eventName"],
    metrics: ["eventCount"],
    limit: rowLimit,
    orderBys: [
      {
        metric: {
          metricName: "eventCount"
        },
        desc: true
      }
    ]
  });

  const topEvents = parseGa4DimensionRows(eventsReport, "eventName", ["eventCount"]);
  const leadEvents = classifyLeadEvents(topEvents);
  const conversionEventsCount = leadEvents.reduce(
    (sum, event) => sum + (safeNumber(event.eventCount) || 0),
    0
  );

  let previousLeadEvents = [];
  let previousConversionEventsCount = null;

  if (isValidDate(previousStartDate) && isValidDate(previousEndDate)) {
    const previousEventsReport = await runGa4Report({
      propertyId: finalPropertyId,
      dateRanges: [{ startDate: previousStartDate, endDate: previousEndDate }],
      dimensions: ["eventName"],
      metrics: ["eventCount"],
      limit: rowLimit,
      orderBys: [
        {
          metric: {
            metricName: "eventCount"
          },
          desc: true
        }
      ]
    });

    previousLeadEvents = classifyLeadEvents(
      parseGa4DimensionRows(previousEventsReport, "eventName", ["eventCount"])
    );

    previousConversionEventsCount = previousLeadEvents.reduce(
      (sum, event) => sum + (safeNumber(event.eventCount) || 0),
      0
    );
  }

  const channelsReport = await runGa4Report({
    propertyId: finalPropertyId,
    dateRanges: [{ startDate, endDate }],
    dimensions: ["sessionDefaultChannelGroup"],
    metrics: ["sessions", "activeUsers", "eventCount"],
    limit: rowLimit,
    orderBys: [
      {
        metric: {
          metricName: "sessions"
        },
        desc: true
      }
    ]
  });

  const topChannels = parseGa4DimensionRows(
    channelsReport,
    "sessionDefaultChannelGroup",
    ["sessions", "activeUsers", "eventCount"]
  );

  const pagesReport = await runGa4Report({
    propertyId: finalPropertyId,
    dateRanges: [{ startDate, endDate }],
    dimensions: ["pagePathPlusQueryString"],
    metrics: ["screenPageViews", "activeUsers", "eventCount"],
    limit: rowLimit,
    orderBys: [
      {
        metric: {
          metricName: "screenPageViews"
        },
        desc: true
      }
    ]
  });

  const topPages = parseGa4DimensionRows(
    pagesReport,
    "pagePathPlusQueryString",
    ["screenPageViews", "activeUsers", "eventCount"]
  );

  return {
    ok: true,
    version: APP_VERSION,
    source: "ga4",
    property: {
      propertyId: finalPropertyId,
      propertyResourceName: `properties/${finalPropertyId}`,
      propertyName: resolvedProperty?.propertyName || null,
      accountName: resolvedProperty?.accountName || null,
      matched_by: propertyId || propertyResourceName ? "propertyId" : "client_or_domain"
    },
    period: {
      startDate,
      endDate,
      previousStartDate: previousStartDate || null,
      previousEndDate: previousEndDate || null
    },
    summary: {
      users: currentSummary.activeUsers,
      total_users: currentSummary.totalUsers,
      sessions: currentSummary.sessions,
      engaged_sessions: currentSummary.engagedSessions,
      event_count: currentSummary.eventCount,
      engagement_rate: currentSummary.engagementRate,
      page_views: currentSummary.screenPageViews,
      conversions: conversionEventsCount,
      previous_users: previousSummary?.activeUsers ?? null,
      previous_total_users: previousSummary?.totalUsers ?? null,
      previous_sessions: previousSummary?.sessions ?? null,
      previous_engaged_sessions: previousSummary?.engagedSessions ?? null,
      previous_event_count: previousSummary?.eventCount ?? null,
      previous_engagement_rate: previousSummary?.engagementRate ?? null,
      previous_page_views: previousSummary?.screenPageViews ?? null,
      previous_conversions: previousConversionEventsCount
    },
    top_events: topEvents,
    lead_events: leadEvents,
    previous_lead_events: previousLeadEvents,
    top_channels: topChannels,
    top_pages: topPages,
    resolved_assets: resolvedAssets
      ? {
          assets_count: resolvedAssets.assets_count,
          matched: resolvedAssets.matched
        }
      : null
  };
}

async function enrichInputWithSearchConsole(input) {
  let enrichedInput = { ...input };

  const client = input.client || {};
  const searchConsoleInput = input.search_console || {};

  const hasSearchConsoleDates =
    searchConsoleInput.startDate &&
    searchConsoleInput.endDate;

  let siteUrl = searchConsoleInput.siteUrl;

  if (!siteUrl && hasSearchConsoleDates && (client.domain || client.name)) {
    try {
      const resolvedAssets = await resolveGoogleAssetsForClient({
        clientName: client.name,
        domain: client.domain,
        location: client.location
      });

      siteUrl = resolvedAssets.matched.search_console?.siteUrl;
    } catch (error) {
      siteUrl = null;
    }
  }

  const hasSearchConsoleRequest =
    siteUrl &&
    searchConsoleInput.startDate &&
    searchConsoleInput.endDate;

  if (!hasSearchConsoleRequest) {
    return enrichedInput;
  }

  try {
    const realSearchConsoleData = await getSearchConsoleMonthlyData({
      siteUrl,
      startDate: searchConsoleInput.startDate,
      endDate: searchConsoleInput.endDate,
      previousStartDate: searchConsoleInput.previousStartDate,
      previousEndDate: searchConsoleInput.previousEndDate,
      rowLimit: searchConsoleInput.rowLimit || 10
    });

    const summary = realSearchConsoleData.summary || {};

    enrichedInput = {
      ...input,
      search_console: {
        ...searchConsoleInput,
        real_data_loaded: true,
        source: "google_search_console",
        siteUrl: realSearchConsoleData.siteUrl,
        period: realSearchConsoleData.period,
        clicks: summary.clicks,
        previous_clicks: summary.previous_clicks,
        impressions: summary.impressions,
        previous_impressions: summary.previous_impressions,
        ctr: summary.ctr,
        previous_ctr: summary.previous_ctr,
        average_position: summary.average_position,
        previous_average_position: summary.previous_average_position,
        top_queries: realSearchConsoleData.top_queries || [],
        previous_top_queries: realSearchConsoleData.previous_top_queries || [],
        raw_data: realSearchConsoleData
      }
    };

    return enrichedInput;
  } catch (error) {
    return {
      ...input,
      search_console: {
        ...searchConsoleInput,
        siteUrl,
        real_data_loaded: false,
        source: "google_search_console",
        error: error.message
      }
    };
  }
}

async function enrichInputWithGa4(input) {
  const client = input.client || {};
  const ga4Input = input.ga4 || {};
  const searchConsoleInput = input.search_console || {};

  const startDate = ga4Input.startDate || searchConsoleInput.startDate;
  const endDate = ga4Input.endDate || searchConsoleInput.endDate;
  const previousStartDate = ga4Input.previousStartDate || searchConsoleInput.previousStartDate;
  const previousEndDate = ga4Input.previousEndDate || searchConsoleInput.previousEndDate;

  const hasDates = startDate && endDate;
  const hasClientContext =
    ga4Input.propertyId ||
    ga4Input.propertyResourceName ||
    client.domain ||
    client.name ||
    ga4Input.domain ||
    ga4Input.clientName;

  if (!hasDates || !hasClientContext) {
    return input;
  }

  try {
    const realGa4Data = await getGa4MonthlyData({
      propertyId: ga4Input.propertyId,
      propertyResourceName: ga4Input.propertyResourceName,
      clientName: ga4Input.clientName || client.name,
      domain: ga4Input.domain || client.domain,
      location: ga4Input.location || client.location,
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      rowLimit: ga4Input.rowLimit || 10
    });

    const summary = realGa4Data.summary || {};

    return {
      ...input,
      ga4: {
        ...ga4Input,
        real_data_loaded: true,
        source: "ga4",
        propertyId: realGa4Data.property.propertyId,
        propertyName: realGa4Data.property.propertyName,
        accountName: realGa4Data.property.accountName,
        period: realGa4Data.period,
        users: summary.users,
        previous_users: summary.previous_users,
        total_users: summary.total_users,
        previous_total_users: summary.previous_total_users,
        sessions: summary.sessions,
        previous_sessions: summary.previous_sessions,
        engaged_sessions: summary.engaged_sessions,
        previous_engaged_sessions: summary.previous_engaged_sessions,
        event_count: summary.event_count,
        previous_event_count: summary.previous_event_count,
        engagement_rate: summary.engagement_rate,
        previous_engagement_rate: summary.previous_engagement_rate,
        page_views: summary.page_views,
        previous_page_views: summary.previous_page_views,
        conversions: summary.conversions,
        previous_conversions: summary.previous_conversions,
        top_events: realGa4Data.top_events || [],
        lead_events: realGa4Data.lead_events || [],
        previous_lead_events: realGa4Data.previous_lead_events || [],
        top_channels: realGa4Data.top_channels || [],
        top_pages: realGa4Data.top_pages || [],
        raw_data: realGa4Data
      }
    };
  } catch (error) {
    return {
      ...input,
      ga4: {
        ...ga4Input,
        real_data_loaded: false,
        source: "ga4",
        startDate,
        endDate,
        previousStartDate,
        previousEndDate,
        error: error.message
      }
    };
  }
}


function classifyIntegrationStatus({ configured = false, loaded = false, error = null, permissionLevel = null } = {}) {
  const normalizedError = normalizeText(error || "");

  if (loaded) {
    return {
      status: "ok",
      severity: "success",
      label: "Datos cargados correctamente",
      detail: null
    };
  }

  if (permissionLevel === "siteUnverifiedUser" || normalizedError.includes("permission") || normalizedError.includes("insufficient") || normalizedError.includes("not verified") || normalizedError.includes("forbidden")) {
    return {
      status: "permission_required",
      severity: "warning",
      label: "Detectado, pero sin permisos suficientes",
      detail: error || "La propiedad existe, pero la cuenta autorizada no tiene permisos suficientes."
    };
  }

  if (!configured || normalizedError.includes("no se pudo resolver") || normalizedError.includes("falta") || normalizedError.includes("missing")) {
    return {
      status: "not_configured",
      severity: "info",
      label: "No configurado o no resuelto",
      detail: error || "No hay una propiedad configurada para este cliente."
    };
  }

  return {
    status: "error",
    severity: "error",
    label: "Error al consultar datos",
    detail: error || "Error no especificado."
  };
}

function buildDataStatus({ client = {}, enrichedInput = {}, assetsResolution = null, report = null } = {}) {
  const ga4 = enrichedInput.ga4 || {};
  const searchConsole = enrichedInput.search_console || {};
  const matchedSearchConsole = assetsResolution?.matched?.search_console || null;
  const matchedGa4 = assetsResolution?.matched?.ga4 || null;

  const ga4Configured = Boolean(ga4.propertyId || ga4.propertyResourceName || matchedGa4?.propertyId);
  const searchConsoleConfigured = Boolean(searchConsole.siteUrl || matchedSearchConsole?.siteUrl);

  const ga4Status = classifyIntegrationStatus({
    configured: ga4Configured,
    loaded: ga4.real_data_loaded === true,
    error: ga4.error || null
  });

  const searchConsoleStatus = classifyIntegrationStatus({
    configured: searchConsoleConfigured,
    loaded: searchConsole.real_data_loaded === true,
    error: searchConsole.error || null,
    permissionLevel: matchedSearchConsole?.permissionLevel || null
  });

  return {
    client: {
      name: client.name || null,
      domain: client.domain || null
    },
    overall_status:
      ga4Status.status === "ok" && searchConsoleStatus.status === "ok"
        ? "complete"
        : ga4Status.status === "ok" || searchConsoleStatus.status === "ok"
          ? "partial"
          : "blocked_or_empty",
    ga4: {
      ...ga4Status,
      propertyId: ga4.propertyId || matchedGa4?.propertyId || null,
      propertyName: ga4.propertyName || matchedGa4?.propertyName || null
    },
    search_console: {
      ...searchConsoleStatus,
      siteUrl: searchConsole.siteUrl || matchedSearchConsole?.siteUrl || null,
      permissionLevel: matchedSearchConsole?.permissionLevel || null
    },
    google_business_profile: {
      status: "deferred",
      severity: "info",
      label: "Pendiente para fase posterior",
      detail: "GBP no bloquea el reporting actual. Se retomará cuando haya cuota/API disponible."
    },
    dinorank: {
      status: "deferred",
      severity: "info",
      label: "Pendiente para fase posterior",
      detail: "DinoRank se integrará por API o exportaciones cuando se confirme la vía disponible."
    },
    missing_data_blocks: report?.data_enrichment?.missing_data_blocks || []
  };
}


function buildDiagnosticDataStatus({ client = {}, preparedInput = {}, assetsResolution = null } = {}) {
  const preparedGa4 = preparedInput.ga4 || {};
  const preparedSearchConsole = preparedInput.search_console || {};
  const matchedSearchConsole = assetsResolution?.matched?.search_console || null;
  const matchedGa4 = assetsResolution?.matched?.ga4 || null;

  const ga4Configured = Boolean(preparedGa4.propertyId || preparedGa4.propertyResourceName || matchedGa4?.propertyId);
  const searchConsoleConfigured = Boolean(preparedSearchConsole.siteUrl || matchedSearchConsole?.siteUrl);
  const searchConsolePermission = matchedSearchConsole?.permissionLevel || null;

  const ga4Status = ga4Configured
    ? {
        status: "resolved",
        severity: "success",
        label: "Propiedad resuelta",
        detail: "La propiedad GA4 está configurada o se ha resuelto para este cliente."
      }
    : {
        status: "not_configured",
        severity: "info",
        label: "No configurado o no resuelto",
        detail: "No hay una propiedad GA4 configurada o resuelta para este cliente."
      };

  let searchConsoleStatus;
  if (searchConsolePermission === "siteUnverifiedUser") {
    searchConsoleStatus = {
      status: "permission_required",
      severity: "warning",
      label: "Detectado, pero sin permisos suficientes",
      detail: "La propiedad existe, pero la cuenta autorizada no tiene permisos suficientes."
    };
  } else if (searchConsoleConfigured) {
    searchConsoleStatus = {
      status: "resolved",
      severity: "success",
      label: "Propiedad resuelta",
      detail: "La propiedad de Search Console está configurada o se ha resuelto para este cliente."
    };
  } else {
    searchConsoleStatus = {
      status: "not_configured",
      severity: "info",
      label: "No configurado o no resuelto",
      detail: "No hay una propiedad de Search Console configurada o resuelta para este cliente."
    };
  }

  const ga4Good = ga4Status.status === "resolved" || ga4Status.status === "ok";
  const searchConsoleGood = searchConsoleStatus.status === "resolved" || searchConsoleStatus.status === "ok";
  const hasBlockingPermissionIssue = searchConsoleStatus.status === "permission_required";

  return {
    client: {
      name: client.name || null,
      domain: client.domain || null
    },
    overall_status:
      ga4Good && searchConsoleGood
        ? "complete"
        : hasBlockingPermissionIssue && !ga4Good
          ? "blocked_or_empty"
          : ga4Good || searchConsoleGood
            ? "partial"
            : "blocked_or_empty",
    ga4: {
      ...ga4Status,
      propertyId: preparedGa4.propertyId || matchedGa4?.propertyId || null,
      propertyName: preparedGa4.propertyName || matchedGa4?.propertyName || null
    },
    search_console: {
      ...searchConsoleStatus,
      siteUrl: preparedSearchConsole.siteUrl || matchedSearchConsole?.siteUrl || null,
      permissionLevel: searchConsolePermission
    },
    google_business_profile: {
      status: "deferred",
      severity: "info",
      label: "Pendiente para fase posterior",
      detail: "GBP no bloquea el reporting actual. Se retomará cuando haya cuota/API disponible."
    },
    dinorank: {
      status: "deferred",
      severity: "info",
      label: "Pendiente para fase posterior",
      detail: "DinoRank se integrará por API o exportaciones cuando se confirme la vía disponible."
    },
    missing_data_blocks: []
  };
}

function buildMissingDataMessage(source, integration = {}) {
  const sourceLabel = source === "ga4" ? "GA4" : "Search Console";
  const configured = source === "ga4"
    ? Boolean(integration.propertyId || integration.propertyResourceName || integration.propertyName)
    : Boolean(integration.siteUrl);
  const error = String(integration.error || "").trim();
  const normalizedError = normalizeText(error);

  if (!configured) {
    return `${sourceLabel} no está configurado para este cliente. El informe se genera con los bloques de datos disponibles.`;
  }

  if (source === "search_console" && (normalizedError.includes("permission") || normalizedError.includes("insufficient") || normalizedError.includes("not verified") || normalizedError.includes("forbidden"))) {
    return "Search Console está detectado, pero la cuenta autorizada no tiene permisos suficientes para consultar datos.";
  }

  return `No se han podido cargar los datos reales de ${sourceLabel}: ${error || "error no especificado"}.`;
}

function getRequestAuthToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return String(req.headers["x-reporting-token"] || req.query.token || req.body?.token || "").trim();
}

function requireReportingToken(req, res, next) {
  const expectedToken = process.env.REPORTING_API_TOKEN;
  if (!expectedToken) return next();

  const receivedToken = getRequestAuthToken(req);
  const expectedBuffer = Buffer.from(expectedToken);
  const receivedBuffer = Buffer.from(receivedToken || "");

  if (receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    version: APP_VERSION,
    error: "Token de reporting inválido o ausente."
  });
}

function inputFromQueryOrBody(req) {
  return {
    ...(req.method === "GET" ? req.query : req.body || {})
  };
}

async function buildClientDiagnostics(input = {}) {
  const directoryResult = await getClientsFromSheet().catch((error) => ({
    ok: false,
    source: "google_sheet",
    error: error.message,
    clients: []
  }));

  const preparedInput = await prepareReportInputAsync(input);
  const client = preparedInput.client || {};

  let assetsResolution = null;
  try {
    assetsResolution = await resolveGoogleAssetsForClient({
      clientName: input.clientName || input.name || client.name,
      domain: input.domain || client.domain,
      location: input.location || client.location,
      propertyId: preparedInput.ga4?.propertyId,
      siteUrl: preparedInput.search_console?.siteUrl
    });
  } catch (error) {
    assetsResolution = {
      ok: false,
      error: error.message
    };
  }

  const directoryClients = Array.isArray(directoryResult.clients) ? directoryResult.clients : [];
  const matchedSheetClient = findKnownClientInDirectory(input, directoryClients.map(sheetClientToKnownClient));
  const fullSheetClient = matchedSheetClient
    ? directoryClients.find((clientItem) => normalizeDomain(clientItem.domain) === normalizeDomain(matchedSheetClient.domain) || normalizeText(clientItem.name) === normalizeText(matchedSheetClient.name)) || null
    : null;

  const dataStatus = buildDiagnosticDataStatus({
    client,
    preparedInput,
    assetsResolution
  });

  return {
    ok: true,
    version: APP_VERSION,
    source: "client_diagnostics",
    input_received: input,
    directory: {
      source: directoryResult.source || "unknown",
      ok: directoryResult.ok !== false,
      count: directoryClients.length,
      error: directoryResult.error || null
    },
    resolved_client: client,
    sheet_client: fullSheetClient,
    prepared_input: {
      client: preparedInput.client,
      period: preparedInput.period,
      ga4: {
        propertyId: preparedInput.ga4?.propertyId || null,
        startDate: preparedInput.ga4?.startDate || null,
        endDate: preparedInput.ga4?.endDate || null,
        previousStartDate: preparedInput.ga4?.previousStartDate || null,
        previousEndDate: preparedInput.ga4?.previousEndDate || null
      },
      search_console: {
        siteUrl: preparedInput.search_console?.siteUrl || null,
        startDate: preparedInput.search_console?.startDate || null,
        endDate: preparedInput.search_console?.endDate || null,
        previousStartDate: preparedInput.search_console?.previousStartDate || null,
        previousEndDate: preparedInput.search_console?.previousEndDate || null
      }
    },
    assets_resolution: assetsResolution,
    data_status: dataStatus,
    next_actions: [
      dataStatus.ga4.status === "ok" ? null : "Revisar GA4 si el informe necesita datos de tráfico web.",
      dataStatus.search_console.status === "permission_required" ? "Añadir la cuenta autorizada como usuario completo o propietario en Search Console." : null,
      dataStatus.search_console.status === "not_configured" ? "Completar search_console_site_url en la Sheet si falta o no coincide." : null
    ].filter(Boolean)
  };
}

async function buildClientReportDataPayload(input = {}) {
  const normalizedInput = await prepareReportInputAsync(input);
  const enrichedInput = await enrichInputWithGoogleData(normalizedInput);
  const report = buildMonthlyReport(enrichedInput);
  const final_outputs = buildFinalReportOutputs(report);

  let assetsResolution = null;
  try {
    assetsResolution = await resolveGoogleAssetsForClient({
      clientName: normalizedInput.client?.name,
      domain: normalizedInput.client?.domain,
      location: normalizedInput.client?.location,
      propertyId: normalizedInput.ga4?.propertyId,
      siteUrl: normalizedInput.search_console?.siteUrl
    });
  } catch (error) {
    assetsResolution = {
      ok: false,
      error: error.message
    };
  }

  const dataStatus = buildDataStatus({
    client: normalizedInput.client,
    enrichedInput,
    assetsResolution,
    report
  });

  return {
    ok: true,
    version: APP_VERSION,
    source: "client_report_data",
    data_status: dataStatus,
    request: {
      clientName: input.clientName || input.name || input.client?.name || null,
      domain: input.domain || input.client?.domain || null,
      month: input.month || input.period?.month || null,
      startDate: normalizedInput.ga4?.startDate || normalizedInput.search_console?.startDate || null,
      endDate: normalizedInput.ga4?.endDate || normalizedInput.search_console?.endDate || null,
      previousStartDate: normalizedInput.ga4?.previousStartDate || normalizedInput.search_console?.previousStartDate || null,
      previousEndDate: normalizedInput.ga4?.previousEndDate || normalizedInput.search_console?.previousEndDate || null
    },
    resolved: {
      client: normalizedInput.client,
      period: normalizedInput.period,
      ga4: {
        propertyId: enrichedInput.ga4?.propertyId || null,
        propertyName: enrichedInput.ga4?.propertyName || null,
        real_data_loaded: enrichedInput.ga4?.real_data_loaded ?? false,
        error: enrichedInput.ga4?.error || null
      },
      search_console: {
        siteUrl: enrichedInput.search_console?.siteUrl || null,
        real_data_loaded: enrichedInput.search_console?.real_data_loaded ?? false,
        error: enrichedInput.search_console?.error || null
      }
    },
    metrics_summary: report.metrics_summary,
    client_report_sections: report.client_report_sections,
    internal_summary_for_cleanify: report.internal_summary_for_cleanify,
    final_outputs,
    report
  };
}

async function enrichInputWithGoogleData(input) {
  const preparedInput = await prepareReportInputAsync(input);
  const withGa4 = await enrichInputWithGa4(preparedInput);
  const withSearchConsole = await enrichInputWithSearchConsole(withGa4);
  return withSearchConsole;
}

function buildMonthlyReport(data) {
  const client = data.client || {};
  const period = data.period || {};
  const ga4 = data.ga4 || {};
  const searchConsole = data.search_console || {};
  const gbp = data.google_business_profile || {};
  const calls = data.calls || {};
  const forms = data.forms || {};
  const crm = data.crm || {};
  const tasks = Array.isArray(data.tasks_done) ? data.tasks_done : [];
  const nextActions = Array.isArray(data.next_month_actions) ? data.next_month_actions : [];
  const clientNeeds = Array.isArray(data.client_needs) ? data.client_needs : [];

  const signals = [];

  const ga4Users = compare(ga4.users, ga4.previous_users);
  const ga4Sessions = compare(ga4.sessions, ga4.previous_sessions);
  const ga4Conversions = compare(ga4.conversions, ga4.previous_conversions);
  const scClicks = compare(searchConsole.clicks, searchConsole.previous_clicks);
  const scImpressions = compare(searchConsole.impressions, searchConsole.previous_impressions);
  const scCtr = compare(searchConsole.ctr, searchConsole.previous_ctr);
  const scAveragePosition = compare(
    searchConsole.average_position,
    searchConsole.previous_average_position
  );
  const gbpCalls = compare(gbp.calls, gbp.previous_calls);
  const totalLeads = compare(crm.total_leads, crm.previous_total_leads);

  signals.push(...buildGa4Signals(ga4));
  signals.push(...buildSearchConsoleSignals(searchConsole));

  if (gbpCalls.trend === "sube") {
    signals.push("Aumentan las llamadas desde Google Business Profile.");
  }

  if (totalLeads.trend === "sube") {
    signals.push("Aumentan los leads totales registrados en CRM.");
  }

  if (signals.length === 0) {
    signals.push(
      "Todavía no hay señales cuantitativas fuertes; el foco está en consolidar base técnica, medición y próximas acciones."
    );
  }

  const missingDataBlocks = [];

  if (!data.ga4) {
    missingDataBlocks.push("No se han aportado datos de GA4.");
  }

  if (data.ga4?.real_data_loaded === false) {
    missingDataBlocks.push(buildMissingDataMessage("ga4", data.ga4));
  }

  if (!data.search_console) {
    missingDataBlocks.push("No se han aportado datos de Search Console.");
  }

  if (data.search_console?.real_data_loaded === false) {
    missingDataBlocks.push(buildMissingDataMessage("search_console", data.search_console));
  }

  if (!data.google_business_profile) {
    missingDataBlocks.push(
      "Google Business Profile / Google Maps está pendiente de conexión API. Este bloque no bloquea el informe actual; la lectura se apoya únicamente en las fuentes que estén disponibles para este cliente."
    );
  }

  if (!data.calls) {
    missingDataBlocks.push("No se han aportado datos de llamadas.");
  }

  if (!data.forms) {
    missingDataBlocks.push("No se han aportado datos de formularios.");
  }

  if (!data.crm) {
    missingDataBlocks.push("No se han aportado datos de CRM.");
  }

  const topQueries = Array.isArray(searchConsole.top_queries)
    ? searchConsole.top_queries
    : [];

  const searchConsoleOpportunities = topQueries
    .filter((query) => {
      const impressions = safeNumber(query.impressions) || 0;
      const ctr = safeNumber(query.ctr);
      const position = safeNumber(query.position);

      return (
        impressions >= 20 &&
        (
          ctr === null ||
          ctr < 0.03 ||
          (position !== null && position >= 5 && position <= 15)
        )
      );
    })
    .slice(0, 6)
    .map((query) => ({
      query: query.query,
      clicks: query.clicks || 0,
      impressions: query.impressions || 0,
      ctr: query.ctr ?? null,
      position: query.position ?? null,
      suggested_action:
        "Revisar title, metadescription, intención de búsqueda, contenido de la página asociada y enlazado interno."
    }));

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    data_enrichment: {
      ga4_real_data_loaded: ga4.real_data_loaded ?? false,
      ga4_propertyId: ga4.propertyId || null,
      ga4_propertyName: ga4.propertyName || null,
      search_console_real_data_loaded: searchConsole.real_data_loaded ?? false,
      search_console_siteUrl: searchConsole.siteUrl || null,
      missing_data_blocks: missingDataBlocks
    },
    client: {
      name: client.name || "Cliente sin nombre",
      sector: client.sector || null,
      location: client.location || null,
      domain: client.domain || null,
      priority_services: client.priority_services || []
    },
    period: {
      month: period.month || null,
      previous_month: period.previous_month || null
    },
    metrics_summary: {
      ga4: {
        real_data_loaded: ga4.real_data_loaded ?? false,
        propertyId: ga4.propertyId || null,
        propertyName: ga4.propertyName || null,
        users: ga4Users,
        sessions: ga4Sessions,
        engaged_sessions: compare(ga4.engaged_sessions, ga4.previous_engaged_sessions),
        page_views: compare(ga4.page_views, ga4.previous_page_views),
        event_count: compare(ga4.event_count, ga4.previous_event_count),
        conversions: ga4Conversions,
        engagement_rate: compare(ga4.engagement_rate, ga4.previous_engagement_rate),
        top_channels: Array.isArray(ga4.top_channels) ? ga4.top_channels : [],
        top_pages: Array.isArray(ga4.top_pages) ? ga4.top_pages : [],
        top_events: Array.isArray(ga4.top_events) ? ga4.top_events : [],
        lead_events: Array.isArray(ga4.lead_events) ? ga4.lead_events : []
      },
      search_console: {
        real_data_loaded: searchConsole.real_data_loaded ?? false,
        siteUrl: searchConsole.siteUrl || null,
        clicks: scClicks,
        impressions: scImpressions,
        ctr: scCtr,
        average_position: {
          ...scAveragePosition,
          note: "En posición media, un número menor es mejor."
        },
        top_queries: topQueries,
        previous_top_queries: Array.isArray(searchConsole.previous_top_queries)
          ? searchConsole.previous_top_queries
          : [],
        opportunities: searchConsoleOpportunities
      },
      google_business_profile: {
        calls: gbpCalls,
        website_clicks: compare(gbp.website_clicks, gbp.previous_website_clicks),
        reviews: compare(gbp.reviews, gbp.previous_reviews)
      },
      commercial: {
        calls_total: compare(calls.total, calls.previous_total),
        calls_qualified: compare(calls.qualified, calls.previous_qualified),
        forms_total: compare(forms.total, forms.previous_total),
        forms_qualified: compare(forms.qualified, forms.previous_qualified),
        leads_total: totalLeads,
        quotes_sent: compare(crm.quotes_sent, crm.previous_quotes_sent),
        sales_closed: compare(crm.sales_closed, crm.previous_sales_closed)
      }
    },
    client_report_sections: {
      resumen_del_mes: `Durante ${period.month || "este mes"}, el proyecto de ${client.name || "este cliente"} ha seguido avanzando con foco en visibilidad, medición y generación de oportunidades comerciales.`,
      que_se_ha_hecho: tasks.length
        ? tasks
        : ["No se han indicado tareas realizadas este mes."],
      por_que_importa: [
        "El trabajo realizado ayuda a mejorar la base del proyecto: visibilidad, medición, contenidos, confianza y conversión.",
        "En SEO local, los resultados suelen consolidarse de forma progresiva, especialmente cuando se crean nuevas páginas, se optimizan activos y se mejora la captación."
      ],
      senales_positivas: signals,
      lectura_ga4: ga4.real_data_loaded
        ? [
            `Usuarios activos: ${ga4Users.current ?? "sin dato"} frente a ${ga4Users.previous ?? "sin dato"} del periodo anterior.`,
            `Sesiones: ${ga4Sessions.current ?? "sin dato"} frente a ${ga4Sessions.previous ?? "sin dato"} del periodo anterior.`,
            `Eventos de contacto/conversión detectados: ${ga4Conversions.current ?? "sin dato"} frente a ${ga4Conversions.previous ?? "sin dato"} del periodo anterior.`,
            `Propiedad GA4 utilizada: ${ga4.propertyName || ga4.propertyId || "sin identificar"}.`
          ]
        : [
            "No se han cargado datos reales de GA4 para este informe."
          ],
      lectura_search_console: searchConsole.real_data_loaded
        ? [
            `Clics orgánicos: ${scClicks.current ?? "sin dato"} frente a ${scClicks.previous ?? "sin dato"} del periodo anterior.`,
            `Impresiones: ${scImpressions.current ?? "sin dato"} frente a ${scImpressions.previous ?? "sin dato"} del periodo anterior.`,
            `CTR: ${scCtr.current ?? "sin dato"} frente a ${scCtr.previous ?? "sin dato"} del periodo anterior.`,
            `Posición media: ${scAveragePosition.current ?? "sin dato"} frente a ${scAveragePosition.previous ?? "sin dato"} del periodo anterior. En esta métrica, un número menor es mejor.`
          ]
        : [
            "No se han cargado datos reales de Search Console para este informe."
          ],
      canales_principales_ga4: Array.isArray(ga4.top_channels) && ga4.top_channels.length
        ? ga4.top_channels
        : ["No se han detectado canales principales de GA4."],
      paginas_principales_ga4: Array.isArray(ga4.top_pages) && ga4.top_pages.length
        ? ga4.top_pages
        : ["No se han detectado páginas principales de GA4."],
      eventos_principales_ga4: Array.isArray(ga4.top_events) && ga4.top_events.length
        ? ga4.top_events
        : ["No se han detectado eventos principales de GA4."],
      consultas_principales: topQueries.length
        ? topQueries.slice(0, 10)
        : ["No se han detectado consultas principales de Search Console."],
      oportunidades_search_console: searchConsoleOpportunities.length
        ? searchConsoleOpportunities
        : ["No se han detectado oportunidades claras con los datos disponibles."],
      que_necesita_tiempo: [
        "La consolidación de rankings locales y la conversión estable de leads necesitan más histórico.",
        "Algunas mejoras pueden verse primero en impresiones, visibilidad o interacción antes de convertirse en llamadas o presupuestos.",
        "Conviene evitar conclusiones fuertes si el volumen de datos todavía es bajo."
      ],
      datos_no_disponibles: missingDataBlocks.length
        ? missingDataBlocks
        : ["No se han detectado bloques de datos faltantes relevantes."],
      proximo_mes: nextActions.length
        ? nextActions
        : ["Revisar datos del mes, priorizar oportunidades y continuar optimizando las páginas y canales con mayor potencial."],
      necesitamos_del_cliente: clientNeeds.length
        ? clientNeeds
        : ["Feedback sobre la calidad de los leads recibidos.", "Confirmación de servicios y zonas prioritarias."]
    },
    internal_summary_for_cleanify: {
      lectura_real_del_mes:
        ga4.real_data_loaded || searchConsole.real_data_loaded
          ? "Se han cargado datos reales desde las fuentes disponibles de Google. Revisar si la visibilidad y los datos disponibles se están convirtiendo en oportunidades comerciales."
          : "No se han podido cargar datos reales suficientes. Revisar permisos, activos resueltos, fechas y propiedad del cliente.",
      riesgos_o_bloqueos: [
        ...missingDataBlocks,
        "Datos incompletos o sin comparativa pueden limitar la lectura.",
        "Si hay llamadas perdidas o formularios poco cualificados, conviene revisarlo antes de prometer crecimiento."
      ],
      que_vigilar: [
        "Calidad de leads.",
        "Llamadas perdidas.",
        "Páginas con muchas impresiones y pocos clics.",
        "Consultas con posición media entre 5 y 15.",
        "Canales o fuentes disponibles con actividad pero baja conversión.",
        "Servicios o zonas con mejor conversión."
      ],
      que_debe_decir_account_manager: "Explicar el avance con calma: qué se ha construido, qué señales empiezan a verse y qué se priorizará el próximo mes.",
      que_no_conviene_prometer: "No prometer posiciones, leads garantizados ni resultados inmediatos si el proyecto aún está construyendo base.",
      proxima_accion_prioritaria: nextActions[0] || "Definir la acción de mayor impacto para el próximo mes."
    }
  };
}

function formatPercent(value) {
  const number = safeNumber(value);
  if (number === null) return "sin dato";
  return `${(number * 100).toFixed(1).replace(".", ",")}%`;
}

function formatMetricCompare(metric, label, suffix = "") {
  if (!metric || metric.current === null || metric.current === undefined) {
    return `${label}: sin dato disponible.`;
  }

  const current = `${metric.current}${suffix}`;
  const previous = metric.previous === null || metric.previous === undefined
    ? "sin comparativa"
    : `${metric.previous}${suffix}`;

  if (metric.percent_change === null || metric.percent_change === undefined) {
    return `${label}: ${current} frente a ${previous}.`;
  }

  const sign = metric.percent_change > 0 ? "+" : "";
  return `${label}: ${current} frente a ${previous} (${sign}${metric.percent_change}%).`;
}

function listToMarkdown(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- Sin datos disponibles.";
  }

  return items.map((item) => {
    if (typeof item === "string") return `- ${item}`;
    return `- ${JSON.stringify(item)}`;
  }).join("\n");
}

function buildFinalReportOutputs(report) {
  const client = report.client || {};
  const period = report.period || {};
  const sections = report.client_report_sections || {};
  const metrics = report.metrics_summary || {};
  const ga4 = metrics.ga4 || {};
  const searchConsole = metrics.search_console || {};
  const internal = report.internal_summary_for_cleanify || {};

  const clientName = client.name || "Cliente";
  const month = period.month || "este mes";
  const ga4Loaded = ga4.real_data_loaded === true;
  const searchConsoleLoaded = searchConsole.real_data_loaded === true;
  const dataAvailabilityIntro = ga4Loaded && searchConsoleLoaded
    ? "Este mes contamos con lectura real de GA4 y Search Console, lo que permite revisar tanto el comportamiento de la web como la visibilidad orgánica en Google."
    : ga4Loaded
      ? "Este mes contamos con lectura real de GA4. Search Console no está disponible o no se ha podido consultar, por lo que la lectura orgánica queda limitada."
      : searchConsoleLoaded
        ? "Este mes contamos con lectura real de Search Console. GA4 no está disponible o no está configurado para este cliente, por lo que el informe se centra en visibilidad orgánica, consultas y páginas detectadas por Google."
        : "Este mes no se han podido cargar datos reales suficientes desde GA4 o Search Console. El informe debe leerse como revisión operativa y de estado de medición, no como análisis completo de rendimiento.";

  const ga4Users = formatMetricCompare(ga4.users, "Usuarios activos");
  const ga4Sessions = formatMetricCompare(ga4.sessions, "Sesiones");
  const ga4Conversions = formatMetricCompare(ga4.conversions, "Eventos de contacto detectados");
  const ga4EngagementRate = ga4.engagement_rate
    ? `Engagement rate: ${formatPercent(ga4.engagement_rate.current)} frente a ${formatPercent(ga4.engagement_rate.previous)}.`
    : "Engagement rate: sin dato disponible.";

  const scClicks = formatMetricCompare(searchConsole.clicks, "Clics orgánicos");
  const scImpressions = formatMetricCompare(searchConsole.impressions, "Impresiones");
  const scCtr = searchConsole.ctr
    ? `CTR: ${formatPercent(searchConsole.ctr.current)} frente a ${formatPercent(searchConsole.ctr.previous)}.`
    : "CTR: sin dato disponible.";
  const scPosition = searchConsole.average_position
    ? formatMetricCompare(searchConsole.average_position, "Posición media")
    : "Posición media: sin dato disponible.";

  const ga4Narrative = ga4Loaded
    ? "La web ya está generando datos suficientes para revisar usuarios, sesiones, páginas principales y eventos. Aunque este mes no se observa un crecimiento fuerte frente al periodo anterior, sí tenemos una base de medición útil para detectar qué páginas reciben visitas y qué acciones conviene reforzar."
    : "Al no estar GA4 disponible o configurado para este cliente, este bloque queda pendiente de medición. La lectura del mes se apoya en los datos disponibles, especialmente Search Console cuando existe acceso.";

  const searchConsoleNarrative = searchConsoleLoaded
    ? "En Search Console vemos señales útiles sobre visibilidad, consultas, clics e impresiones. La prioridad es reforzar páginas, contenidos, intención de búsqueda y snippets para convertir más apariciones en clics cualificados."
    : "Al no poder consultar Search Console para este cliente, este bloque queda pendiente de permisos o configuración. Conviene resolver el acceso antes de hacer una lectura completa de visibilidad orgánica.";

  const emailDataSentence = ga4Loaded && searchConsoleLoaded
    ? "Este mes contamos con datos reales de GA4 y Search Console, lo que nos ayuda a interpretar mejor la evolución de la web y la visibilidad orgánica."
    : ga4Loaded
      ? "Este mes contamos con datos reales de GA4. Search Console queda pendiente de configuración o permisos, así que la lectura orgánica es limitada."
      : searchConsoleLoaded
        ? "Este mes contamos con datos reales de Search Console. GA4 no está disponible o no está configurado, por lo que la lectura se centra en visibilidad orgánica, consultas e impresiones."
        : "Este mes el informe se centra en el estado del proyecto y la medición, ya que todavía falta completar el acceso o la configuración de GA4 y Search Console.";

  const clientReportMarkdown = `# Informe mensual · ${clientName}

Periodo: ${month}

## 1. Resumen del mes

${sections.resumen_del_mes || `Durante ${month}, el proyecto ha seguido avanzando con foco en visibilidad, medición y captación.`}

${dataAvailabilityIntro} La lectura debe hacerse con prudencia: hay señales útiles, pero todavía faltan algunos bloques importantes como llamadas, formularios, CRM o Google Business Profile para conectar toda la foto de marketing con oportunidades comerciales reales.

## 2. Qué se ha hecho este mes

${listToMarkdown(sections.que_se_ha_hecho)}

Estas acciones son importantes porque ayudan a ordenar la medición, entender mejor qué canales están generando actividad y preparar una lectura más clara del avance del proyecto.

## 3. Resultados y señales positivas

### GA4 · Tráfico y comportamiento web

- ${ga4Users}
- ${ga4Sessions}
- ${ga4Conversions}
- ${ga4EngagementRate}

La web ya está generando datos suficientes para revisar usuarios, sesiones, páginas principales y eventos. Aunque este mes no se observa un crecimiento fuerte frente al periodo anterior, sí tenemos una base de medición útil para detectar qué páginas reciben visitas y qué acciones conviene reforzar.

### Search Console · Visibilidad orgánica

- ${scClicks}
- ${scImpressions}
- ${scCtr}
- ${scPosition}

${searchConsoleNarrative}

### Señales destacadas

${listToMarkdown(sections.senales_positivas)}

## 4. Qué todavía necesita tiempo

${listToMarkdown(sections.que_necesita_tiempo)}

En SEO local, las mejoras no siempre se traducen de forma inmediata en llamadas o formularios. Primero suelen aparecer señales de rastreo, indexación, impresiones, pequeñas entradas de tráfico y consultas nuevas. El objetivo es convertir esas señales iniciales en oportunidades más constantes.

## 5. Qué haremos el próximo mes

${listToMarkdown(sections.proximo_mes)}

## 6. Qué necesitamos de vosotros

${listToMarkdown(sections.necesitamos_del_cliente)}

## 7. Cierre

El proyecto sigue avanzando con una base de medición más clara. El siguiente paso será utilizar estos datos para priorizar mejor las acciones: revisar páginas con potencial, reforzar servicios importantes, corregir posibles fricciones y conectar cada vez mejor la visibilidad con contactos reales.`;

  const internalSummaryMarkdown = `# Resumen interno Cleanify · ${clientName}

## Lectura real del mes

${internal.lectura_real_del_mes || "Se han cargado datos reales y conviene revisar la relación entre visibilidad, tráfico y oportunidades comerciales."}

## Riesgos o bloqueos

${listToMarkdown(internal.riesgos_o_bloqueos)}

## Qué conviene vigilar

${listToMarkdown(internal.que_vigilar)}

## Qué debería decir el account manager

${internal.que_debe_decir_account_manager || "Explicar el avance con calma, reforzando qué se ha trabajado, qué señales existen y cuál será el foco del próximo mes."}

## Qué no conviene prometer

${internal.que_no_conviene_prometer || "No prometer posiciones, leads garantizados ni resultados inmediatos."}

## Próxima acción prioritaria

${internal.proxima_accion_prioritaria || "Definir la acción de mayor impacto para el próximo mes."}`;

  const emailSubjects = [
    `Informe mensual de ${clientName} · Avances y próximos pasos`,
    `Resumen de trabajo y evolución del mes · ${clientName}`,
    `Avances SEO local y captación · ${clientName}`
  ];

  const emailBody = `Hola,

Te compartimos el informe mensual de ${clientName}, con el resumen de trabajo realizado, las principales señales que estamos viendo y el foco previsto para el próximo mes.

${emailDataSentence} Como verás, el objetivo no es solo revisar métricas, sino entender qué se está construyendo, qué empieza a moverse y qué acciones pueden ayudarnos a seguir mejorando la captación.

También hemos incluido algunos puntos en los que vuestra ayuda puede acelerar el avance, especialmente en prioridades comerciales, feedback de contactos y materiales reales de trabajos.

Cualquier duda, lo revisamos juntos.

Un saludo,
El equipo de Cleanify`;

   const clientReportHtml = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Informe mensual · ${clientName}</title>
  <style>
    body {
      margin: 0;
      background: #f3f4f6;
      color: #111827;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.55;
    }

    .page {
      max-width: 860px;
      margin: 32px auto;
      background: #ffffff;
      padding: 48px 56px;
      border-radius: 18px;
      box-shadow: 0 12px 36px rgba(15, 23, 42, 0.08);
    }

    .eyebrow {
      color: #64748b;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
    }

    h1 {
      font-size: 30px;
      line-height: 1.15;
      margin: 0 0 8px;
      color: #0f172a;
    }

    .period {
      color: #475569;
      font-size: 16px;
      margin-bottom: 32px;
    }

    h2 {
      font-size: 20px;
      margin: 34px 0 12px;
      color: #0f172a;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 8px;
    }

    h3 {
      font-size: 16px;
      margin: 22px 0 10px;
      color: #1f2937;
    }

    p {
      margin: 0 0 14px;
    }

    ul {
      margin: 10px 0 18px 22px;
      padding: 0;
    }

    li {
      margin-bottom: 7px;
    }

    .summary-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 18px 20px;
      margin: 20px 0;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 14px 0 20px;
    }

    .metric-card {
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 14px 16px;
      background: #ffffff;
    }

    .metric-card strong {
      display: block;
      margin-bottom: 4px;
      color: #0f172a;
    }

    .note {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      color: #7c2d12;
      border-radius: 14px;
      padding: 16px 18px;
      margin: 18px 0;
    }

    .footer {
      margin-top: 38px;
      padding-top: 18px;
      border-top: 1px solid #e5e7eb;
      color: #64748b;
      font-size: 14px;
    }

    @media print {
      body {
        background: #ffffff;
      }

      .page {
        margin: 0;
        max-width: none;
        box-shadow: none;
        border-radius: 0;
        padding: 28px 34px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="eyebrow">Informe mensual</div>
    <h1>${clientName}</h1>
    <div class="period">Periodo: ${month}</div>

    <section class="summary-box">
      <p>${sections.resumen_del_mes || `Durante ${month}, el proyecto ha seguido avanzando con foco en visibilidad, medición y captación.`}</p>
      <p>${dataAvailabilityIntro} La lectura debe hacerse con prudencia: hay señales útiles, pero todavía faltan algunos bloques importantes como llamadas, formularios, CRM o Google Business Profile para conectar toda la foto de marketing con oportunidades comerciales reales.</p>
    </section>

    <h2>1. Qué se ha hecho este mes</h2>
    <ul>
      ${(Array.isArray(sections.que_se_ha_hecho) ? sections.que_se_ha_hecho : []).map((item) => `<li>${item}</li>`).join("") || "<li>No se han indicado tareas realizadas este mes.</li>"}
    </ul>
    <p>Estas acciones son importantes porque ayudan a ordenar la medición, entender mejor qué canales están generando actividad y preparar una lectura más clara del avance del proyecto.</p>

    <h2>2. Resultados y señales principales</h2>

    <h3>Tráfico y comportamiento web</h3>
    <div class="metrics-grid">
      <div class="metric-card"><strong>Usuarios activos</strong>${ga4Users}</div>
      <div class="metric-card"><strong>Sesiones</strong>${ga4Sessions}</div>
      <div class="metric-card"><strong>Eventos de contacto detectados</strong>${ga4Conversions}</div>
      <div class="metric-card"><strong>Engagement rate</strong>${ga4EngagementRate}</div>
    </div>
    <p>${ga4Narrative}</p>

    <h3>Visibilidad orgánica en Google</h3>
    <div class="metrics-grid">
      <div class="metric-card"><strong>Clics orgánicos</strong>${scClicks}</div>
      <div class="metric-card"><strong>Impresiones</strong>${scImpressions}</div>
      <div class="metric-card"><strong>CTR</strong>${scCtr}</div>
      <div class="metric-card"><strong>Posición media</strong>${scPosition}</div>
    </div>
    <p>${searchConsoleNarrative}</p>

    <h3>Señales destacadas</h3>
    <ul>
      ${(Array.isArray(sections.senales_positivas) ? sections.senales_positivas : []).map((item) => `<li>${item}</li>`).join("") || "<li>Todavía no hay señales destacadas suficientes.</li>"}
    </ul>

    <h2>3. Qué todavía necesita tiempo</h2>
    <ul>
      ${(Array.isArray(sections.que_necesita_tiempo) ? sections.que_necesita_tiempo : []).map((item) => `<li>${item}</li>`).join("") || "<li>La consolidación de resultados necesita más histórico.</li>"}
    </ul>
    <div class="note">En SEO local, las mejoras no siempre se traducen de forma inmediata en llamadas o formularios. Primero suelen aparecer señales de rastreo, indexación, impresiones, pequeñas entradas de tráfico y consultas nuevas.</div>

    <h2>4. Qué haremos el próximo mes</h2>
    <ul>
      ${(Array.isArray(sections.proximo_mes) ? sections.proximo_mes : []).map((item) => `<li>${item}</li>`).join("") || "<li>Revisar datos del mes y priorizar las acciones con mayor impacto.</li>"}
    </ul>

    <h2>5. Qué necesitamos de vosotros</h2>
    <ul>
      ${(Array.isArray(sections.necesitamos_del_cliente) ? sections.necesitamos_del_cliente : []).map((item) => `<li>${item}</li>`).join("") || "<li>Feedback sobre la calidad de los contactos recibidos.</li>"}
    </ul>

    <h2>6. Cierre</h2>
    <p>El proyecto sigue avanzando con una base de medición más clara. El siguiente paso será utilizar estos datos para priorizar mejor las acciones: revisar páginas con potencial, reforzar servicios importantes, corregir posibles fricciones y conectar cada vez mejor la visibilidad con contactos reales.</p>

    <div class="footer">Cleanify · Informe mensual de evolución</div>
  </main>
</body>
</html>`;

  return {
    client_report_markdown: clientReportMarkdown,
    client_report_html: clientReportHtml,
    internal_summary_markdown: internalSummaryMarkdown,
    email_subjects: emailSubjects,
    email_body: emailBody
  };
}

function escapeFilePart(value) {
  return String(value || "report")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "report";
}

async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.warn("No se pudo cargar recurso remoto:", url, error.message);
    return null;
  }
}

const CLEANIFY_BRAND = {
  primary: "#000026",
  accent: "#5271ff",
  white: "#ffffff",
  text: "#000026",
  muted: "#596174",
  line: "#d9ddec",
  success: "#0f8f55",
  warning: "#9a6b00",
  danger: "#b91c1c",
  lightBg: "#ffffff"
};

const CLEANIFY_ASSET_DIR = path.join(process.cwd(), "assets");
const CLEANIFY_LOGO_PATH = process.env.CLEANIFY_LOGO_PATH || path.join(CLEANIFY_ASSET_DIR, "cleanify-logo.png");
const CLEANIFY_LOGO_WHITE_PATH = process.env.CLEANIFY_LOGO_WHITE_PATH || path.join(CLEANIFY_ASSET_DIR, "cleanify-logo-white.png");
const CLEANIFY_TITLE_FONT_PATH = process.env.CLEANIFY_TITLE_FONT_PATH || process.env.CLEANIFY_FONT_PATH || "";
const CLEANIFY_BODY_FONT_PATH = process.env.CLEANIFY_BODY_FONT_PATH || "";
const CLEANIFY_BODY_BOLD_FONT_PATH = process.env.CLEANIFY_BODY_BOLD_FONT_PATH || "";

let cachedLogoBuffer = null;
let cachedWhiteLogoBuffer = null;

async function loadLocalOrRemoteBuffer({ localPath, remoteUrl }) {
  if (remoteUrl) {
    const remoteBuffer = await fetchBuffer(remoteUrl);
    if (remoteBuffer) return remoteBuffer;
  }

  if (localPath && fs.existsSync(localPath)) {
    return fs.readFileSync(localPath);
  }

  return null;
}

async function getCleanifyLogoBuffer({ white = false } = {}) {
  if (white && cachedWhiteLogoBuffer) return cachedWhiteLogoBuffer;
  if (!white && cachedLogoBuffer) return cachedLogoBuffer;

  const buffer = await loadLocalOrRemoteBuffer({
    localPath: white ? CLEANIFY_LOGO_WHITE_PATH : CLEANIFY_LOGO_PATH,
    remoteUrl: white ? (process.env.CLEANIFY_LOGO_WHITE_URL || "") : CLEANIFY_LOGO_URL
  });

  if (white) cachedWhiteLogoBuffer = buffer;
  else cachedLogoBuffer = buffer;

  return buffer;
}

function setupCleanifyPdfFonts(doc) {
  const fonts = {
    title: "Helvetica-Bold",
    body: "Helvetica",
    bodyBold: "Helvetica-Bold"
  };

  try {
    if (CLEANIFY_TITLE_FONT_PATH && fs.existsSync(CLEANIFY_TITLE_FONT_PATH)) {
      doc.registerFont("CleanifyTitle", CLEANIFY_TITLE_FONT_PATH);
      fonts.title = "CleanifyTitle";
    }
  } catch (error) {
    console.warn("No se pudo registrar la fuente Cleanify para títulos:", error.message);
  }

  try {
    if (CLEANIFY_BODY_FONT_PATH && fs.existsSync(CLEANIFY_BODY_FONT_PATH)) {
      doc.registerFont("CleanifyBody", CLEANIFY_BODY_FONT_PATH);
      fonts.body = "CleanifyBody";
    }
  } catch (error) {
    console.warn("No se pudo registrar la fuente de cuerpo:", error.message);
  }

  try {
    if (CLEANIFY_BODY_BOLD_FONT_PATH && fs.existsSync(CLEANIFY_BODY_BOLD_FONT_PATH)) {
      doc.registerFont("CleanifyBodyBold", CLEANIFY_BODY_BOLD_FONT_PATH);
      fonts.bodyBold = "CleanifyBodyBold";
    }
  } catch (error) {
    console.warn("No se pudo registrar la fuente de cuerpo bold:", error.message);
  }

  doc.cleanifyFonts = fonts;
  return fonts;
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function formatPdfNumber(value) {
  const number = safeNumber(value);
  if (number === null) return "-";
  if (Math.abs(number) >= 1000) return new Intl.NumberFormat("es-ES").format(number);
  return String(Number(number.toFixed ? number.toFixed(2) : number)).replace(".", ",");
}

function formatPdfPercent(value) {
  const number = safeNumber(value);
  if (number === null) return "-";
  return `${(number * 100).toFixed(1).replace(".", ",")}%`;
}

function titleDisplayText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function sanitizePdfText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringifyPdfItem(item) {
  if (typeof item === "string") return sanitizePdfText(item);
  if (!item || typeof item !== "object") return sanitizePdfText(item);
  if (item.query) {
    const details = [];
    if (item.clicks !== undefined) details.push(`${item.clicks} clics`);
    if (item.impressions !== undefined) details.push(`${item.impressions} impresiones`);
    if (item.position !== undefined && item.position !== null) details.push(`posición ${formatPdfNumber(item.position)}`);
    return `${item.query}${details.length ? ` (${details.join(", ")})` : ""}`;
  }
  if (item.eventName) return `${item.eventName}: ${formatPdfNumber(item.eventCount)}`;
  if (item.pagePathPlusQueryString) return `${item.pagePathPlusQueryString}: ${formatPdfNumber(item.screenPageViews)} vistas`;
  if (item.sessionDefaultChannelGroup) return `${item.sessionDefaultChannelGroup}: ${formatPdfNumber(item.sessions)} sesiones`;
  if (item.suggested_action) return `${item.query || "Oportunidad"}: ${item.suggested_action}`;
  return sanitizePdfText(JSON.stringify(item));
}

function metricLine(metric, label = "", suffix = "") {
  if (!metric || metric.current === null || metric.current === undefined) {
    return `${label ? label + ": " : ""}sin dato disponible`;
  }
  const current = `${formatPdfNumber(metric.current)}${suffix}`;
  const previous = metric.previous === null || metric.previous === undefined
    ? "sin comparativa"
    : `${formatPdfNumber(metric.previous)}${suffix}`;
  if (metric.percent_change === null || metric.percent_change === undefined) {
    return `${label ? label + ": " : ""}${current} frente a ${previous}`;
  }
  const sign = metric.percent_change > 0 ? "+" : "";
  return `${label ? label + ": " : ""}${current} frente a ${previous} (${sign}${String(metric.percent_change).replace(".", ",")}%)`;
}

function metricValue(metric, empty = "-") {
  if (!metric || metric.current === null || metric.current === undefined) return empty;
  return formatPdfNumber(metric.current);
}

function metricPreviousText(metric, prefix = "Mes anterior") {
  if (!metric || metric.previous === null || metric.previous === undefined) return "Sin comparativa";
  return `${prefix}: ${formatPdfNumber(metric.previous)}`;
}

function metricVariationText(metric) {
  if (!metric || metric.percent_change === null || metric.percent_change === undefined) return "";
  const sign = metric.percent_change > 0 ? "+" : "";
  return `${sign}${String(metric.percent_change).replace(".", ",")}%`;
}

function createPdfKitDocument({ title = "Informe Cleanify" } = {}) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: title,
      Author: "Cleanify",
      Subject: "Informe mensual Cleanify",
      Creator: "Cleanify Reporting Agent - locked Cleanify v7 renderer"
    }
  });
  setupCleanifyPdfFonts(doc);
  return doc;
}

function pdfFonts(doc) {
  return doc.cleanifyFonts || { title: "Helvetica-Bold", body: "Helvetica", bodyBold: "Helvetica-Bold" };
}

function drawLogoBuffer(doc, buffer, x, y, options = {}) {
  if (!buffer) return false;
  try {
    doc.image(buffer, x, y, options);
    return true;
  } catch (error) {
    console.warn("No se pudo dibujar el logo:", error.message);
    return false;
  }
}

function drawFallbackLogo(doc, x, y, color = CLEANIFY_BRAND.white, size = 20) {
  doc.fillColor(color).font(pdfFonts(doc).bodyBold).fontSize(size).text("CLEANIFY", x, y, { lineBreak: false });
}

function fillPage(doc, color = CLEANIFY_BRAND.white) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(color);
}

function drawV7Title(doc, text, x, y, size = 32, color = CLEANIFY_BRAND.text, width = 470) {
  doc.fillColor(color).font(pdfFonts(doc).title).fontSize(size)
    .text(titleDisplayText(text), x, y, { width, lineGap: 1 });
  return doc.y;
}

function drawV7Paragraph(doc, text, x, y, width, options = {}) {
  const clean = sanitizePdfText(text);
  if (!clean) return y;
  const font = options.bold ? pdfFonts(doc).bodyBold : pdfFonts(doc).body;
  doc.fillColor(options.color || CLEANIFY_BRAND.text).font(font).fontSize(options.size || 10.5)
    .text(clean, x, y, { width, lineGap: options.lineGap ?? 4, align: options.align || "left" });
  return doc.y;
}

function drawLabel(doc, text, x, y, options = {}) {
  doc.fillColor(options.color || CLEANIFY_BRAND.muted).font(pdfFonts(doc).bodyBold).fontSize(options.size || 8)
    .text(String(text || "").toUpperCase(), x, y, { width: options.width || 240, characterSpacing: 0.2 });
}

function drawLine(doc, x1, y1, x2, y2, color = CLEANIFY_BRAND.line, width = 0.8) {
  doc.save().strokeColor(color).lineWidth(width).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

function drawV7BulletList(doc, items, x, y, width, options = {}) {
  const list = Array.isArray(items) && items.length ? items : ["Sin datos disponibles."];
  let cy = y;
  const limit = options.limit || 8;
  const size = options.size || 10.2;
  const bulletColor = options.bulletColor || CLEANIFY_BRAND.accent;
  const color = options.color || CLEANIFY_BRAND.text;
  list.slice(0, limit).forEach((item) => {
    const text = stringifyPdfItem(item);
    doc.fillColor(bulletColor).circle(x + 3, cy + 6, 2.2).fill();
    doc.fillColor(color).font(pdfFonts(doc).body).fontSize(size)
      .text(text, x + 18, cy, { width: width - 18, lineGap: options.lineGap ?? 4 });
    cy = doc.y + (options.gap ?? 10);
  });
  return cy;
}

function splitIntoShortItems(text, fallback = []) {
  const clean = sanitizePdfText(text);
  if (!clean) return fallback;
  const pieces = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length >= 2) return pieces;
  return [clean];
}

function shortenText(text, max = 280) {
  const clean = sanitizePdfText(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trim().replace(/[,.!?:;]+$/, "") + "…";
}

async function drawClientHeader(doc) {
  const logo = await getCleanifyLogoBuffer({ white: false });
  if (!drawLogoBuffer(doc, logo, 56, 48, { fit: [98, 24] })) {
    drawFallbackLogo(doc, 56, 49, CLEANIFY_BRAND.primary, 16);
  }
  doc.font(pdfFonts(doc).body).fontSize(8.8).fillColor(CLEANIFY_BRAND.muted)
    .text("Informe mensual SEO local", 348, 52, { width: 190, align: "right" });
}

function drawClientFooter(doc, pageNumber, label = "Cleanify - propuesta visual de informe mensual") {
  const y = doc.page.height - 50;
  doc.fillColor(CLEANIFY_BRAND.muted).font(pdfFonts(doc).body).fontSize(7.8)
    .text(label, 56, y, { width: 310, lineBreak: false });
  doc.text(String(pageNumber), doc.page.width - 82, y, { width: 26, align: "right", lineBreak: false });
}

function drawInternalFooter(doc) {
  doc.fillColor("#d8ddff").font(pdfFonts(doc).body).fontSize(8.5)
    .text("Cleanify · informe interno", 56, doc.page.height - 62, { width: 240, lineBreak: false });
}

function drawClientMetricRows(doc, metrics, x, y, width) {
  const colW = width / Math.max(metrics.length, 1);
  const topY = y;
  const bottomY = y + 102;
  drawLine(doc, x, topY, x + width, topY, CLEANIFY_BRAND.line, 0.8);
  drawLine(doc, x, bottomY, x + width, bottomY, CLEANIFY_BRAND.line, 0.8);
  metrics.forEach((metric, index) => {
    const xx = x + index * colW;
    if (index > 0) drawLine(doc, xx, topY, xx, bottomY, CLEANIFY_BRAND.line, 0.75);
    drawLabel(doc, metric.label, xx + (index ? 14 : 0), topY + 17, { size: 7.5, width: colW - 18 });
    doc.fillColor(CLEANIFY_BRAND.primary).font(pdfFonts(doc).title).fontSize(31)
      .text(titleDisplayText(metric.value), xx + (index ? 14 : 0), topY + 43, { width: colW - 18, height: 38 });
    doc.fillColor(CLEANIFY_BRAND.muted).font(pdfFonts(doc).body).fontSize(8.2)
      .text(metric.previous || "Sin comparativa", xx + (index ? 14 : 0), topY + 84, { width: Math.min(88, colW - 24), lineBreak: false });
    if (metric.variation) {
      doc.fillColor(metric.isPositive === false ? CLEANIFY_BRAND.muted : CLEANIFY_BRAND.success)
        .font(pdfFonts(doc).bodyBold).fontSize(8.2)
        .text(metric.variation, xx + (index ? 98 : 84), topY + 84, { width: colW - 95, lineBreak: false });
    }
  });
  return bottomY + 38;
}

function resolveClientMetrics(report) {
  const metrics = report.metrics_summary || {};
  const ga4 = metrics.ga4 || {};
  const sc = metrics.search_console || {};
  return [
    { label: "Sesiones", value: metricValue(ga4.sessions), previous: metricPreviousText(ga4.sessions), variation: metricVariationText(ga4.sessions), isPositive: (ga4.sessions?.percent_change ?? 0) >= 0 },
    { label: "Usuarios", value: metricValue(ga4.users), previous: metricPreviousText(ga4.users), variation: metricVariationText(ga4.users), isPositive: (ga4.users?.percent_change ?? 0) >= 0 },
    { label: "Clics orgánicos", value: metricValue(sc.clicks), previous: metricPreviousText(sc.clicks), variation: metricVariationText(sc.clicks), isPositive: (sc.clicks?.percent_change ?? 0) >= 0 },
    { label: "Posición media", value: metricValue(sc.average_position), previous: metricPreviousText(sc.average_position, "Antes"), variation: sc.average_position?.current != null ? "mejora" : "", isPositive: true }
  ];
}

async function drawClientCover(doc, report) {
  const client = report.client || {};
  const period = report.period || {};
  const logo = await getCleanifyLogoBuffer({ white: true });
  fillPage(doc, CLEANIFY_BRAND.primary);
  doc.rect(0, 0, 12, doc.page.height).fill(CLEANIFY_BRAND.accent);
  doc.rect(doc.page.width - 12, 0, 12, doc.page.height).fill(CLEANIFY_BRAND.accent);
  if (!drawLogoBuffer(doc, logo, 70, 78, { fit: [240, 52] })) drawFallbackLogo(doc, 70, 82, CLEANIFY_BRAND.white, 28);
  drawV7Title(doc, "Informe mensual", 70, 225, 39, CLEANIFY_BRAND.white, 460);
  doc.fillColor("#ffffff").font(pdfFonts(doc).body).fontSize(14.5)
    .text("Evolución SEO local y captación", 72, 268, { width: 430 });
  const baseY = doc.page.height - 150;
  drawLabel(doc, "Cliente", 72, baseY, { color: "#c8d0ff", size: 8.6 });
  doc.fillColor(CLEANIFY_BRAND.white).font(pdfFonts(doc).bodyBold).fontSize(20)
    .text(client.name || "Cliente", 72, baseY + 23, { width: 365 });
  doc.fillColor("#d8ddff").font(pdfFonts(doc).body).fontSize(11)
    .text(`Periodo analizado: ${period.month || "mes analizado"}${period.previous_month ? ` frente a ${period.previous_month}` : ""}`, 72, baseY + 51, { width: 390 });
  doc.fillColor("#c8d0ff").font(pdfFonts(doc).body).fontSize(9)
    .text("Cleanify Reporting", doc.page.width - 230, baseY + 51, { width: 160, align: "right" });
}

async function drawClientExecutiveSummary(doc, report) {
  const client = report.client || {};
  const sections = report.client_report_sections || {};
  const metrics = report.metrics_summary || {};
  const ga4Loaded = metrics.ga4?.real_data_loaded === true;
  const scLoaded = metrics.search_console?.real_data_loaded === true;
  const dataStatus = report.data_status || {};
  fillPage(doc, CLEANIFY_BRAND.white);
  await drawClientHeader(doc);
  drawV7Title(doc, "Resumen ejecutivo", 56, 118, 32, CLEANIFY_BRAND.text, 500);
  drawV7Paragraph(doc, "Una lectura breve para entender qué ha pasado este mes, qué significa para captación y dónde conviene concentrar el esfuerzo.", 56, 172, 500, { size: 10.5, color: CLEANIFY_BRAND.muted });
  const statusText = dataStatus.overall_status === "blocked_or_empty"
    ? "La lectura se centra en ordenar el estado del proyecto y resolver fuentes pendientes antes de valorar rendimiento con seguridad."
    : dataStatus.overall_status === "partial"
      ? "Las fuentes disponibles permiten interpretar avance, bloqueos y oportunidades sin forzar conclusiones."
      : "Las fuentes disponibles permiten interpretar avance, bloqueos y oportunidades sin forzar conclusiones.";
  const blocks = [
    { title: "Qué vemos este mes", text: sections.resumen_del_mes || statusText },
    { title: "Qué significa", text: ga4Loaded && scLoaded ? "El proyecto sigue construyendo base: medición, páginas con potencial, consultas detectadas y mejoras que pueden convertirse en contactos cuando haya más histórico." : statusText },
    { title: "Qué vamos a priorizar", text: (sections.proximo_mes || [])[0] || "Reforzar las páginas con oportunidad, mejorar títulos y snippets, revisar conversión y completar las fuentes de medición que falten." }
  ];
  let y = 236;
  blocks.forEach((block) => {
    doc.rect(56, y + 7, 28, 2.2).fill(CLEANIFY_BRAND.accent);
    doc.fillColor(CLEANIFY_BRAND.text).font(pdfFonts(doc).bodyBold).fontSize(12.5).text(block.title, 96, y, { width: 410 });
    y = drawV7Paragraph(doc, shortenText(block.text, 330), 96, y + 36, 410, { size: 10.2, lineGap: 4 });
    y += 37;
  });
  drawLine(doc, 56, 700, doc.page.width - 56, 700);
  drawV7Paragraph(doc, `El informe se adapta a las fuentes disponibles y los permisos cedidos por ${client.name || "el cliente"}.`, 56, 723, 500, { color: CLEANIFY_BRAND.muted, size: 9.8 });
  drawClientFooter(doc, 2);
}

async function drawClientResults(doc, report) {
  const sections = report.client_report_sections || {};
  fillPage(doc, CLEANIFY_BRAND.white);
  await drawClientHeader(doc);
  drawV7Title(doc, "Resultados del mes", 56, 112, 32, CLEANIFY_BRAND.text, 500);
  drawV7Paragraph(doc, "Métricas principales presentadas con separación limpia y lectura posterior. Sin cajas vacías cuando falta una fuente.", 56, 166, 500, { size: 10.5, color: CLEANIFY_BRAND.muted });
  const afterMetricsY = drawClientMetricRows(doc, resolveClientMetrics(report), 56, 216, doc.page.width - 112);
  drawLine(doc, 56, afterMetricsY + 2, doc.page.width - 56, afterMetricsY + 2);
  drawV7Title(doc, "Que significan estas senales", 56, afterMetricsY + 42, 23.5, CLEANIFY_BRAND.text, 500);
  const signals = Array.isArray(sections.senales_positivas) && sections.senales_positivas.length
    ? sections.senales_positivas
    : [
      "La tendencia muestra actividad, pero todavía necesita continuidad.",
      "Las consultas con posición media entre 5 y 15 son candidatas para optimizar contenido y snippets.",
      "El crecimiento orgánico debe cruzarse con llamadas, formularios y feedback comercial."
    ];
  drawV7BulletList(doc, signals, 74, afterMetricsY + 100, 450, { limit: 3, size: 10.5, gap: 10 });
  drawClientFooter(doc, 3);
}

async function drawClientStrategicPage(doc, report) {
  const sections = report.client_report_sections || {};
  fillPage(doc, CLEANIFY_BRAND.white);
  await drawClientHeader(doc);
  drawV7Title(doc, "Lectura estrategica", 56, 112, 32, CLEANIFY_BRAND.text, 500);
  drawV7Paragraph(doc, "El objetivo de esta página es transformar datos en decisiones: qué reforzar, qué vigilar y qué no conviene interpretar todavía.", 56, 166, 500, { size: 10.5, color: CLEANIFY_BRAND.muted });
  let y = 236;
  const positive = (sections.senales_positivas || []).slice(0, 2);
  const watch = (sections.que_necesita_tiempo || []).slice(0, 2);
  const opportunities = (sections.oportunidades_search_console || []).slice(0, 2);
  const groups = [
    ["Senales positivas", positive.length ? positive : ["La visibilidad orgánica empieza a mostrar patrones útiles.", "Hay consultas de servicio que pueden convertirse en oportunidades si se refuerzan páginas y snippets."]],
    ["Senales a vigilar", watch.length ? watch : ["El volumen mensual aún es bajo, por lo que conviene evitar conclusiones fuertes.", "Faltan datos de llamadas, formularios o CRM para cerrar la foto comercial."]],
    ["Oportunidades detectadas", opportunities.length ? opportunities : ["Optimizar páginas asociadas a consultas con impresiones y posición media entre 5 y 15.", "Reforzar servicios prioritarios con contenido más específico y enlazado interno."]]
  ];
  groups.forEach(([title, items]) => {
    drawV7Title(doc, title, 56, y, 20.5, CLEANIFY_BRAND.text, 500);
    y = drawV7BulletList(doc, items, 74, y + 48, 460, { limit: 3, size: 10.2, gap: 8 });
    y += 24;
  });
  drawClientFooter(doc, 4);
}

async function drawClientWorkAndNextSteps(doc, report) {
  const sections = report.client_report_sections || {};
  fillPage(doc, CLEANIFY_BRAND.white);
  await drawClientHeader(doc);
  drawV7Title(doc, "Trabajo realizado", 56, 112, 32, CLEANIFY_BRAND.text, 500);
  drawV7Paragraph(doc, "Acciones del periodo y enfoque operativo.", 56, 166, 500, { size: 10.5, color: CLEANIFY_BRAND.muted });
  const work = Array.isArray(sections.que_se_ha_hecho) && sections.que_se_ha_hecho.length ? sections.que_se_ha_hecho : [
    "Revisión de visibilidad orgánica y consultas principales.",
    "Análisis de páginas con mayor potencial de captación.",
    "Identificación de bloqueos de medición y datos comerciales pendientes."
  ];
  let y = drawV7BulletList(doc, work, 74, 220, 450, { limit: 4, size: 10.4, gap: 8 });
  y += 28;
  drawV7Title(doc, "Proximos pasos", 56, y, 32, CLEANIFY_BRAND.text, 500);
  y += 64;
  const steps = Array.isArray(sections.proximo_mes) && sections.proximo_mes.length ? sections.proximo_mes : [
    "Reforzar páginas que ya muestran impresiones o posiciones cercanas a primera página.",
    "Revisar eventos, formularios y seguimiento comercial para conectar datos con leads reales.",
    "Crear o mejorar contenidos de servicio/zona según prioridades comerciales."
  ];
  const titles = ["1. Visibilidad orgánica", "2. Conversión y medición", "3. SEO local y contenido"];
  steps.slice(0, 3).forEach((step, index) => {
    doc.fillColor(CLEANIFY_BRAND.accent).font(pdfFonts(doc).bodyBold).fontSize(11).text(titles[index] || `Prioridad ${index + 1}`, 56, y, { width: 420 });
    y = drawV7Paragraph(doc, shortenText(step, 180), 56, y + 28, 470, { size: 10.2 });
    y += 16;
  });
  drawClientFooter(doc, 5);
}

async function drawClientClose(doc, report) {
  const client = report.client || {};
  const logo = await getCleanifyLogoBuffer({ white: true });
  fillPage(doc, CLEANIFY_BRAND.primary);
  if (!drawLogoBuffer(doc, logo, 56, 64, { fit: [140, 34] })) drawFallbackLogo(doc, 56, 66, CLEANIFY_BRAND.white, 18);
  doc.fillColor("#d8ddff").font(pdfFonts(doc).body).fontSize(9)
    .text("Informe mensual SEO local", 350, 67, { width: 190, align: "right" });
  drawV7Title(doc, "Cierre", 56, 120, 38, CLEANIFY_BRAND.white, 470);
  const closeText = "El proyecto sigue avanzando con una base de medición más clara. El siguiente paso será usar estos datos para priorizar mejor las acciones, reforzar las páginas con mayor potencial y conectar cada vez mejor la visibilidad con contactos reales.";
  drawV7Paragraph(doc, closeText, 56, 230, 480, { color: "#ffffff", size: 14, lineGap: 6 });
  drawLine(doc, 56, 356, doc.page.width - 56, 356, CLEANIFY_BRAND.accent, 1.2);
  drawV7Paragraph(doc, "Esta salida mantiene una lectura sobria, adaptable a clientes completos, parciales o con accesos pendientes, sin mostrar bloques vacíos innecesarios.", 56, 396, 500, { color: "#d8ddff", size: 10.5 });
  doc.fillColor("#b9c2ff").font(pdfFonts(doc).body).fontSize(8)
    .text("Cleanify - propuesta visual de informe mensual", 56, doc.page.height - 50, { width: 310, lineBreak: false });
  doc.text("6", doc.page.width - 82, doc.page.height - 50, { width: 26, align: "right", lineBreak: false });
}

async function buildClientPdfBuffer(report, finalOutputs) {
  const client = report.client || {};
  const doc = createPdfKitDocument({ title: `Informe mensual · ${client.name || "Cliente"}` });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  await drawClientCover(doc, report);
  doc.addPage();
  await drawClientExecutiveSummary(doc, report);
  doc.addPage();
  await drawClientResults(doc, report);
  doc.addPage();
  await drawClientStrategicPage(doc, report);
  doc.addPage();
  await drawClientWorkAndNextSteps(doc, report);
  doc.addPage();
  await drawClientClose(doc, report);
  doc.end();
  await new Promise((resolve) => doc.on("end", resolve));
  return Buffer.concat(chunks);
}

function internalSourceRows(report) {
  const data = report.data_enrichment || {};
  return [
    `GA4: ${data.ga4_real_data_loaded ? "cargado" : "no cargado"}`,
    `Search Console: ${data.search_console_real_data_loaded ? "cargado" : "no cargado"}`,
    `Propiedad GA4: ${valueOrDash(data.ga4_propertyId)}`,
    `Search Console: ${valueOrDash(data.search_console_siteUrl)}`
  ];
}

function internalRecommendations(report) {
  const internal = report.internal_summary_for_cleanify || {};
  const metrics = report.metrics_summary || {};
  const sc = metrics.search_console || {};
  const ga4 = metrics.ga4 || {};
  const items = [
    ...((sc.opportunities || []).map((item) => `Oportunidad Search Console: ${stringifyPdfItem(item)}`)),
    ...((internal.que_vigilar || []).slice(0, 5)),
    ...((ga4.lead_events || []).length ? [`Revisar calidad de eventos de contacto: ${(ga4.lead_events || []).map((e) => stringifyPdfItem(e)).join("; ")}`] : [])
  ].filter(Boolean);
  return items.length ? items : ["Calidad de leads.", "Llamadas perdidas.", "Páginas con muchas impresiones y pocos clics.", "Consultas con posición media entre 5 y 15."];
}

async function drawInternalPageOne(doc, report) {
  const client = report.client || {};
  const period = report.period || {};
  const internal = report.internal_summary_for_cleanify || {};
  const logo = await getCleanifyLogoBuffer({ white: true });
  fillPage(doc, CLEANIFY_BRAND.primary);
  if (!drawLogoBuffer(doc, logo, 56, 62, { fit: [142, 34] })) drawFallbackLogo(doc, 56, 66, CLEANIFY_BRAND.white, 18);
  doc.rect(56, 150, 42, 3).fill(CLEANIFY_BRAND.accent);
  drawV7Title(doc, "Informe interno", 56, 176, 31, CLEANIFY_BRAND.white, 470);
  doc.fillColor("#d8ddff").font(pdfFonts(doc).body).fontSize(11)
    .text(`Cliente: ${client.name || "Cliente"}`, 56, 235, { width: 470 })
    .text(`Periodo: ${period.month || "mes analizado"}${period.previous_month ? ` frente a ${period.previous_month}` : ""}`, 56, 255, { width: 470 });
  let y = drawV7BulletList(doc, internalSourceRows(report), 76, 318, 440, { color: "#ffffff", bulletColor: CLEANIFY_BRAND.accent, limit: 4, size: 10, gap: 10 });
  y += 34;
  drawV7Title(doc, "Lectura real del mes", 56, y, 21, CLEANIFY_BRAND.white, 480);
  y = drawV7BulletList(doc, [internal.lectura_real_del_mes || "Revisar evolución del mes con datos reales disponibles y foco comercial."], 76, y + 52, 438, { color: "#ffffff", bulletColor: CLEANIFY_BRAND.accent, limit: 1, size: 9.4, gap: 8 });
  y += 24;
  drawV7Title(doc, "Riesgos o bloqueos", 56, y, 21, CLEANIFY_BRAND.white, 480);
  drawV7BulletList(doc, internal.riesgos_o_bloqueos || [], 76, y + 52, 438, { color: "#ffffff", bulletColor: CLEANIFY_BRAND.accent, limit: 6, size: 9.2, gap: 8, lineGap: 3 });
}

async function drawInternalPageTwo(doc, report) {
  const internal = report.internal_summary_for_cleanify || {};
  fillPage(doc, CLEANIFY_BRAND.primary);
  let y = 72;
  const groups = [
    ["Recomendaciones organicas", internalRecommendations(report), 6],
    ["Que debe decir account manager", [internal.que_debe_decir_account_manager || "Explicar el avance con calma: qué se ha construido, qué señales empiezan a verse y qué se priorizará el próximo mes."], 1],
    ["Que no conviene prometer", [internal.que_no_conviene_prometer || "No prometer posiciones, leads garantizados ni resultados inmediatos si el proyecto aún está construyendo base."], 1],
    ["Accion prioritaria 80/20", [internal.proxima_accion_prioritaria || "Definir la acción de mayor impacto para el próximo mes."], 1]
  ];
  groups.forEach(([title, items, limit]) => {
    drawV7Title(doc, title, 56, y, 20.5, CLEANIFY_BRAND.white, 500);
    y = drawV7BulletList(doc, items, 76, y + 52, 438, { color: "#ffffff", bulletColor: CLEANIFY_BRAND.accent, limit, size: 9.6, gap: 10, lineGap: 3 });
    y += 22;
  });
  drawInternalFooter(doc);
}

async function buildInternalPdfBuffer(report, finalOutputs) {
  const client = report.client || {};
  const doc = createPdfKitDocument({ title: `Informe interno Cleanify · ${client.name || "Cliente"}` });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  await drawInternalPageOne(doc, report);
  doc.addPage();
  await drawInternalPageTwo(doc, report);
  doc.end();
  await new Promise((resolve) => doc.on("end", resolve));
  return Buffer.concat(chunks);
}

function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function writeReportFile(buffer, fileName) {
  ensureReportsDir();
  const fullPath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(fullPath, buffer);
  return fullPath;
}

function normalizeAudience(value) {
  const audience = String(value || "client").toLowerCase().trim();
  if (["internal", "interno"].includes(audience)) return "internal";
  if (["both", "package", "all", "ambos"].includes(audience)) return "both";
  return "client";
}

async function buildReportPackage(input = {}) {
  const enrichedInput = await enrichInputWithGoogleData(input);
  const report = buildMonthlyReport(enrichedInput);
  const final_outputs = buildFinalReportOutputs(report);
  const audience = normalizeAudience(input.audience || input.output || input.reportAudience);

  const client = report.client || {};
  const period = report.period || {};
  const baseSlug = `${escapeFilePart(client.name)}-${escapeFilePart(period.month)}-${crypto.randomBytes(4).toString("hex")}`;

  const files = {};

  if (audience === "client" || audience === "both") {
    const clientPdfBuffer = await buildClientPdfBuffer(report, final_outputs);
    const clientFileName = `${baseSlug}-cliente.pdf`;
    writeReportFile(clientPdfBuffer, clientFileName);
    files.client_pdf = {
      fileName: clientFileName,
      url: `${BASE_URL}/reports/${clientFileName}`
    };
  }

  if (audience === "internal" || audience === "both") {
    const internalPdfBuffer = await buildInternalPdfBuffer(report, final_outputs);
    const internalFileName = `${baseSlug}-interno-cleanify.pdf`;
    writeReportFile(internalPdfBuffer, internalFileName);
    files.internal_pdf = {
      fileName: internalFileName,
      url: `${BASE_URL}/reports/${internalFileName}`
    };
  }

  return {
    ok: true,
    version: APP_VERSION,
    audience,
    ga4_loaded: report.data_enrichment?.ga4_real_data_loaded ?? false,
    search_console_loaded: report.data_enrichment?.search_console_real_data_loaded ?? false,
    gbp_loaded: Boolean(report.metrics_summary?.google_business_profile?.real_data_loaded),
    resolved: {
      client: report.client,
      ga4_propertyId: report.data_enrichment?.ga4_propertyId ?? null,
      ga4_propertyName: report.data_enrichment?.ga4_propertyName ?? null,
      search_console_siteUrl: report.data_enrichment?.search_console_siteUrl ?? null
    },
    files,
    final_outputs,
    report
  };
}


function createMcpServer() {
  const server = new McpServer({
    name: "cleanify-reporting-agent",
    version: APP_VERSION
  });

  server.registerTool(
    "generateMonthlyReport",
    {
      title: "Generar informe mensual de cliente",
      description:
        "Genera un informe mensual para clientes de Cleanify usando una petición humana simple. Puede recibir solo clientName y month, por ejemplo Island Servi y abril 2026. El sistema resuelve dominio, propiedad GA4, siteUrl de Search Console, fechas del mes y comparativa del mes anterior cuando es posible.",
      inputSchema: {
        clientName: z.string().optional().describe("Nombre del cliente, por ejemplo Island Servi"),
        domain: z.string().optional().describe("Dominio del cliente, por ejemplo islandservi.com"),
        month: z.string().optional().describe("Mes del informe, por ejemplo abril 2026"),
        year: z.union([z.string(), z.number()]).optional().describe("Año del informe si month es numérico"),
        startDate: z.string().optional().describe("Fecha inicial del periodo actual en formato YYYY-MM-DD"),
        endDate: z.string().optional().describe("Fecha final del periodo actual en formato YYYY-MM-DD"),
        previousStartDate: z.string().optional().describe("Fecha inicial del periodo anterior en formato YYYY-MM-DD"),
        previousEndDate: z.string().optional().describe("Fecha final del periodo anterior en formato YYYY-MM-DD"),
        client: z.object({
          name: z.string().optional().describe("Nombre del cliente o proyecto"),
          sector: z.string().optional().describe("Sector del cliente o proyecto"),
          location: z.string().optional().describe("Ciudad, provincia o zona principal"),
          domain: z.string().optional().describe("Dominio del cliente o proyecto, por ejemplo econeta.es"),
          priority_services: z.array(z.string()).optional().describe("Servicios prioritarios")
        }).optional(),
        period: z.object({
          month: z.string().optional(),
          previous_month: z.string().optional()
        }).optional(),
        ga4: z.record(z.any()).optional().describe(
          "Puede incluir propertyId, startDate, endDate, previousStartDate y previousEndDate. Si no incluye propertyId, el sistema intenta resolverlo por cliente o dominio."
        ),
        search_console: z.record(z.any()).optional().describe(
          "Puede incluir siteUrl, startDate, endDate, previousStartDate y previousEndDate. Si falta siteUrl, el sistema intenta resolverlo por cliente o dominio."
        ),
        google_business_profile: z.record(z.any()).optional(),
        calls: z.record(z.any()).optional(),
        forms: z.record(z.any()).optional(),
        crm: z.record(z.any()).optional(),
        tasks_done: z.array(z.string()).optional(),
        next_month_actions: z.array(z.string()).optional(),
        client_needs: z.array(z.string()).optional()
      }
    },
    async (input) => {
      const enrichedInput = await enrichInputWithGoogleData(input);
      const report = buildMonthlyReport(enrichedInput);
      const final_outputs = buildFinalReportOutputs(report);

      const response = {
        ok: true,
        version: APP_VERSION,
        ga4_loaded: report.data_enrichment?.ga4_real_data_loaded ?? false,
        search_console_loaded: report.data_enrichment?.search_console_real_data_loaded ?? false,
        resolved: {
          client: report.client,
          ga4_propertyId: report.data_enrichment?.ga4_propertyId ?? null,
          ga4_propertyName: report.data_enrichment?.ga4_propertyName ?? null,
          search_console_siteUrl: report.data_enrichment?.search_console_siteUrl ?? null
        },
        final_outputs,
        report
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2)
          }
        ],
        structuredContent: response
      };
    }
  );

  server.registerTool(
    "getSearchConsoleMonthlyData",
    {
      title: "Obtener datos mensuales de Search Console",
      description:
        "Consulta datos reales de Google Search Console para un sitio y rango de fechas. Devuelve clics, impresiones, CTR, posición media y principales consultas.",
      inputSchema: {
        siteUrl: z.string().describe("URL exacta de la propiedad en Search Console, por ejemplo https://limpiezabnb.com/"),
        startDate: z.string().describe("Fecha inicial del periodo actual en formato YYYY-MM-DD"),
        endDate: z.string().describe("Fecha final del periodo actual en formato YYYY-MM-DD"),
        previousStartDate: z.string().optional().describe("Fecha inicial del periodo anterior en formato YYYY-MM-DD"),
        previousEndDate: z.string().optional().describe("Fecha final del periodo anterior en formato YYYY-MM-DD")
      }
    },
    async (input) => {
      const data = await getSearchConsoleMonthlyData({
        siteUrl: input.siteUrl,
        startDate: input.startDate,
        endDate: input.endDate,
        previousStartDate: input.previousStartDate,
        previousEndDate: input.previousEndDate,
        rowLimit: 10
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "getGa4MonthlyData",
    {
      title: "Obtener datos mensuales de GA4",
      description:
        "Consulta datos reales de GA4 para una propiedad y rango de fechas. Puede resolver la propiedad por propertyId, dominio o nombre de cliente.",
      inputSchema: {
        propertyId: z.string().optional().describe("ID de propiedad GA4, por ejemplo 526346028"),
        clientName: z.string().optional().describe("Nombre del cliente si no se conoce propertyId"),
        domain: z.string().optional().describe("Dominio del cliente si no se conoce propertyId, por ejemplo econeta.es"),
        location: z.string().optional(),
        startDate: z.string().describe("Fecha inicial del periodo actual en formato YYYY-MM-DD"),
        endDate: z.string().describe("Fecha final del periodo actual en formato YYYY-MM-DD"),
        previousStartDate: z.string().optional().describe("Fecha inicial del periodo anterior en formato YYYY-MM-DD"),
        previousEndDate: z.string().optional().describe("Fecha final del periodo anterior en formato YYYY-MM-DD")
      }
    },
    async (input) => {
      const data = await getGa4MonthlyData({
        propertyId: input.propertyId,
        clientName: input.clientName,
        domain: input.domain,
        location: input.location,
        startDate: input.startDate,
        endDate: input.endDate,
        previousStartDate: input.previousStartDate,
        previousEndDate: input.previousEndDate,
        rowLimit: 10
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "resolveGoogleAssetsForClient",
    {
      title: "Resolver activos Google de un cliente",
      description:
        "Busca qué propiedad de Search Console y qué propiedad GA4 corresponden a un cliente según nombre, dominio o ubicación.",
      inputSchema: {
        clientName: z.string().optional(),
        domain: z.string().optional(),
        location: z.string().optional(),
        propertyId: z.string().optional(),
        siteUrl: z.string().optional()
      }
    },
    async (input) => {
      const data = await resolveGoogleAssetsForClient(input);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ],
        structuredContent: data
      };
    }
  );


  server.registerTool(
    "generateMonthlyReportPackage",
    {
      title: "Generar paquete mensual con PDFs Cleanify",
      description:
        "Genera el paquete completo de reporting mensual de Cleanify. Acepta una petición humana simple con clientName y month, resuelve cliente, fechas, GA4 y Search Console, y devuelve URLs a dos PDFs: informe cliente e informe interno Cleanify.",
      inputSchema: {
        clientName: z.string().optional().describe("Nombre del cliente, por ejemplo Island Servi"),
        domain: z.string().optional().describe("Dominio del cliente si se conoce"),
        month: z.string().optional().describe("Mes del informe, por ejemplo abril 2026"),
        year: z.union([z.string(), z.number()]).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        previousStartDate: z.string().optional(),
        previousEndDate: z.string().optional(),
        client: z.object({
          name: z.string().optional(),
          sector: z.string().optional(),
          location: z.string().optional(),
          domain: z.string().optional(),
          priority_services: z.array(z.string()).optional()
        }).optional(),
        period: z.object({
          month: z.string().optional(),
          previous_month: z.string().optional()
        }).optional(),
        ga4: z.record(z.any()).optional(),
        search_console: z.record(z.any()).optional(),
        google_business_profile: z.record(z.any()).optional(),
        calls: z.record(z.any()).optional(),
        forms: z.record(z.any()).optional(),
        crm: z.record(z.any()).optional(),
        tasks_done: z.array(z.string()).optional(),
        next_month_actions: z.array(z.string()).optional(),
        client_needs: z.array(z.string()).optional()
      }
    },
    async (input) => {
      const packageResult = await buildReportPackage(input);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: packageResult.ok,
              version: packageResult.version,
              ga4_loaded: packageResult.ga4_loaded,
              search_console_loaded: packageResult.search_console_loaded,
              gbp_loaded: packageResult.gbp_loaded,
              resolved: packageResult.resolved,
              files: packageResult.files,
              email_subjects: packageResult.final_outputs?.email_subjects || [],
              email_body: packageResult.final_outputs?.email_body || ""
            }, null, 2)
          }
        ],
        structuredContent: packageResult
      };
    }
  );

  server.registerTool(
    "listKnownClients",
    {
      title: "Listar clientes conocidos",
      description:
        "Devuelve el directorio de clientes que el sistema puede resolver automáticamente para informes mensuales.",
      inputSchema: {}
    },
    async () => {
      const directory = await getKnownClientDirectory();

      const data = {
        ok: true,
        version: APP_VERSION,
        source: directory.source,
        count: directory.clients.length,
        clients: directory.clients.map((client) => ({
          name: client.name,
          domain: client.domain,
          ga4PropertyId: client.ga4PropertyId,
          searchConsoleSiteUrl: client.searchConsoleSiteUrl,
          aliases: client.aliases || []
        }))
      };

      if (directory.error) {
        data.warning = directory.error;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ],
        structuredContent: data
      };
    }
  );

  return server;
}

app.get("/", (req, res) => {
  res.send("Cleanify Reporting Agent funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "cleanify-reporting-agent",
    version: APP_VERSION,
    routes: {
      google_assets: `${BASE_URL}/google/assets`,
      google_resolve_assets: `${BASE_URL}/google/resolve-assets`,
      google_test: `${BASE_URL}/google/test`,
      clients: `${BASE_URL}/clients`,
      ga4_monthly: `${BASE_URL}/ga4/monthly`,
      search_console_monthly: `${BASE_URL}/search-console/monthly`,
      debug_resolve_client: `${BASE_URL}/debug/resolve-client`,
      chat_client_report_data: `${BASE_URL}/chat/client-report-data`,
      monthly_report: `${BASE_URL}/api/report/monthly`,
      monthly_report_html: `${BASE_URL}/api/report/monthly/html`,
      official_pdf_renderer: `${BASE_URL}/api/report/render`,
      mcp: `${BASE_URL}/mcp`
    }
  });
});

app.get("/debug/routes", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    routes: [
      "GET /",
      "GET /health",
      "GET /debug/routes",
      "GET /clients",
      "GET /oauth/google/start",
      "GET /oauth/google/callback",
      "GET /google/test",
      "GET /google/assets",
      "GET /google/resolve-assets",
      "GET /debug/resolve-client",
      "GET /chat/client-report-data",
      "POST /chat/client-report-data",
      "GET /ga4/monthly",
      "GET /search-console/monthly",
      "GET /reports/:fileName",
      "POST /api/report/monthly/client-pdf",
      "POST /api/report/monthly/internal-pdf",
      "POST /api/report/render",
      "POST /api/report/monthly/package",
      "POST /api/report/monthly/html",
      "POST /api/report/monthly",
      "POST /mcp",
      "GET /openapi.json"
    ]
  });
});

app.get("/clients", async (req, res) => {
  try {
    const sheetResult = await getClientsFromSheet();

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "google_sheet",
      count: sheetResult.clients.length,
      clients: sheetResult.clients
    });
  } catch (error) {
    console.error("No se pudieron cargar clientes desde Google Sheets:", error);

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "fallback_server",
      warning: "No se pudieron cargar clientes desde Google Sheets. Se usa CLIENT_DIRECTORY como respaldo.",
      details: error.message,
      count: CLIENT_DIRECTORY.length,
      clients: CLIENT_DIRECTORY.map((client) => ({
        name: client.name,
        domain: client.domain,
        ga4PropertyId: client.ga4PropertyId,
        searchConsoleSiteUrl: client.searchConsoleSiteUrl,
        aliases: client.aliases || []
      }))
    });
  }
});

app.get("/oauth/google/start", (req, res) => {
  try {
    const authUrl = getGoogleAuthUrl();
    return res.redirect(authUrl);
  } catch (error) {
    console.error("Error iniciando OAuth Google:", error);
    return res.status(500).json({
      ok: false,
      error: "No se pudo iniciar OAuth con Google.",
      details: error.message
    });
  }
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: "Google no devolvió ningún código OAuth."
      });
    }

    const tokens = await exchangeGoogleCodeForTokens(code);

    return res.type("html").send(`
      <html>
        <head>
          <title>Google conectado</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 760px;
              margin: 48px auto;
              line-height: 1.5;
              color: #111827;
            }
            code, pre {
              background: #f3f4f6;
              padding: 12px;
              border-radius: 8px;
              display: block;
              white-space: pre-wrap;
              word-break: break-all;
            }
            .ok {
              color: #047857;
              font-weight: bold;
            }
            .warn {
              color: #92400e;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <h1 class="ok">Google conectado correctamente ✅</h1>
          <p>La autorización ha funcionado.</p>

          ${
            tokens.refresh_token
              ? `<p class="warn">Copia este refresh token y guárdalo como variable de entorno en Hostinger:</p>
                 <pre>${tokens.refresh_token}</pre>
                 <p>Nombre de la variable:</p>
                 <code>GOOGLE_REFRESH_TOKEN</code>`
              : `<p class="warn">Google no devolvió refresh_token.</p>
                 <p>Esto puede pasar si esta cuenta ya autorizó antes la app. Luego lo solucionamos revocando el acceso y repitiendo la autorización.</p>`
          }

          <p>Después de guardar la variable, puedes cerrar esta pestaña.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error en callback OAuth Google:", error);
    return res.status(500).json({
      ok: false,
      error: "No se pudo completar OAuth con Google.",
      details: error.message
    });
  }
});

app.get("/google/test", async (req, res) => {
  try {
    const auth = createAuthorizedGoogleClient();
    const { google } = await import("googleapis");

    const searchConsole = google.webmasters({
      version: "v3",
      auth
    });

    const sitesResponse = await searchConsole.sites.list();

    return res.json({
      ok: true,
      version: APP_VERSION,
      google_connected: true,
      search_console_connected: true,
      sites_count: sitesResponse.data.siteEntry?.length || 0,
      sites: (sitesResponse.data.siteEntry || []).map((site) => ({
        siteUrl: site.siteUrl,
        permissionLevel: site.permissionLevel
      }))
    });
  } catch (error) {
    console.error("Error probando conexión Google Search Console:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      google_connected: false,
      search_console_connected: false,
      error: "No se pudo conectar con Search Console usando el refresh token.",
      details: error.message
    });
  }
});

app.get("/gbp/accounts", async (req, res) => {
  try {
    const accessToken = await getGoogleAccessToken();

    const response = await fetch(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const responseText = await response.text();

    let json;
    try {
      json = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      return res.status(500).json({
        ok: false,
        version: APP_VERSION,
        source: "google_business_profile",
        error: "Google Business Profile devolvió una respuesta no JSON.",
        raw_response: responseText
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        version: APP_VERSION,
        source: "google_business_profile",
        error: "No se pudieron listar las cuentas de Google Business Profile.",
        status: response.status,
        details: json
      });
    }

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "google_business_profile",
      accounts_count: Array.isArray(json.accounts) ? json.accounts.length : 0,
      accounts: json.accounts || []
    });
  } catch (error) {
    console.error("Error listando cuentas GBP:", error);

    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "google_business_profile",
      error: "Error interno listando cuentas de Google Business Profile.",
      details: error.message
    });
  }
});

app.get("/google/assets", async (req, res) => {
  try {
    const assets = await listAvailableAssets();

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "google_assets",
      counts: {
        search_console: assets.search_console.length,
        ga4: assets.ga4.length
      },
      assets
    });
  } catch (error) {
    console.error("Error listando activos Google:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "google_assets",
      error: "No se pudieron listar los activos de Google.",
      details: error.message
    });
  }
});

app.get("/google/resolve-assets", async (req, res) => {
  try {
    const { clientName, domain, location, propertyId, siteUrl } = req.query;

    const resolution = await resolveGoogleAssetsForClient({
      clientName,
      domain,
      location,
      propertyId,
      siteUrl
    });

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "google_assets_resolver",
      resolution
    });
  } catch (error) {
    console.error("Error resolviendo activos Google:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "google_assets_resolver",
      error: "No se pudieron resolver los activos del cliente/proyecto.",
      details: error.message
    });
  }
});


app.get("/debug/resolve-client", requireReportingToken, async (req, res) => {
  try {
    const diagnostics = await buildClientDiagnostics(inputFromQueryOrBody(req));
    return res.json(diagnostics);
  } catch (error) {
    console.error("Error diagnosticando cliente:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "client_diagnostics",
      error: "No se pudo diagnosticar el cliente.",
      details: error.message
    });
  }
});

app.get("/chat/client-report-data", requireReportingToken, async (req, res) => {
  try {
    const payload = await buildClientReportDataPayload(inputFromQueryOrBody(req));
    return res.json(payload);
  } catch (error) {
    console.error("Error preparando datos de informe para chat:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "client_report_data",
      error: "No se pudieron preparar los datos del informe.",
      details: error.message
    });
  }
});

app.post("/chat/client-report-data", requireReportingToken, async (req, res) => {
  try {
    const payload = await buildClientReportDataPayload(inputFromQueryOrBody(req));
    return res.json(payload);
  } catch (error) {
    console.error("Error preparando datos de informe para chat:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "client_report_data",
      error: "No se pudieron preparar los datos del informe.",
      details: error.message
    });
  }
});

app.get("/ga4/monthly", async (req, res) => {
  try {
    const {
      propertyId,
      propertyResourceName,
      clientName,
      domain,
      location,
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      rowLimit
    } = req.query;

    const data = await getGa4MonthlyData({
      propertyId,
      propertyResourceName,
      clientName,
      domain,
      location,
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      rowLimit: safeNumber(rowLimit) || 10
    });

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "ga4",
      data
    });
  } catch (error) {
    console.error("Error consultando GA4 mensual:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "ga4",
      error: "No se pudo consultar GA4.",
      details: error.message
    });
  }
});

app.get("/search-console/monthly", async (req, res) => {
  try {
    const {
      siteUrl,
      startDate,
      endDate,
      previousStartDate,
      previousEndDate
    } = req.query;

    const data = await getSearchConsoleMonthlyData({
      siteUrl,
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      rowLimit: 10
    });

    return res.json({
      ok: true,
      version: APP_VERSION,
      source: "search_console",
      data
    });
  } catch (error) {
    console.error("Error consultando Search Console mensual:", error);
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      source: "search_console",
      error: "No se pudo consultar Search Console.",
      details: error.message
    });
  }
});

app.get("/reports/:fileName", (req, res) => {
  try {
    const fileName = path.basename(req.params.fileName || "");
    if (!fileName.endsWith(".pdf")) {
      return res.status(400).json({ ok: false, error: "Archivo no permitido." });
    }

    const fullPath = path.join(REPORTS_DIR, fileName);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ ok: false, error: "Informe no encontrado o expirado." });
    }

    return res.type("application/pdf").sendFile(fullPath);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "No se pudo servir el PDF.", details: error.message });
  }
});

app.post("/api/report/monthly/client-pdf", async (req, res) => {
  try {
    const enrichedInput = await enrichInputWithGoogleData(req.body || {});
    const report = buildMonthlyReport(enrichedInput);
    const final_outputs = buildFinalReportOutputs(report);
    const buffer = await buildClientPdfBuffer(report, final_outputs);
    const fileName = `${escapeFilePart(report.client?.name)}-${escapeFilePart(report.period?.month)}-cliente.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, version: APP_VERSION, error: "Error generando PDF cliente.", details: error.message });
  }
});

app.post("/api/report/monthly/internal-pdf", async (req, res) => {
  try {
    const enrichedInput = await enrichInputWithGoogleData(req.body || {});
    const report = buildMonthlyReport(enrichedInput);
    const final_outputs = buildFinalReportOutputs(report);
    const buffer = await buildInternalPdfBuffer(report, final_outputs);
    const fileName = `${escapeFilePart(report.client?.name)}-${escapeFilePart(report.period?.month)}-interno-cleanify.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, version: APP_VERSION, error: "Error generando PDF interno.", details: error.message });
  }
});


app.post("/api/report/render", async (req, res) => {
  try {
    const body = req.body || {};
    const templateId = String(body.template_id || body.templateId || body.audience || "client_v7").toLowerCase().trim();
    const input = body.input || body.report_input || body.data || body;
    const normalizedAudience = templateId.includes("internal") || templateId.includes("interno") ? "internal" : "client";

    let report = body.report && typeof body.report === "object" ? body.report : null;
    let final_outputs = body.final_outputs && typeof body.final_outputs === "object" ? body.final_outputs : null;

    if (!report) {
      const enrichedInput = await enrichInputWithGoogleData({ ...input, audience: normalizedAudience });
      report = buildMonthlyReport(enrichedInput);
      final_outputs = buildFinalReportOutputs(report);
    } else if (!final_outputs) {
      final_outputs = buildFinalReportOutputs(report);
    }

    const buffer = normalizedAudience === "internal"
      ? await buildInternalPdfBuffer(report, final_outputs)
      : await buildClientPdfBuffer(report, final_outputs);

    const fileName = `${escapeFilePart(report.client?.name)}-${escapeFilePart(report.period?.month)}-${normalizedAudience === "internal" ? "interno-cleanify" : "cliente"}-v7.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("X-Cleanify-Template-Id", normalizedAudience === "internal" ? "internal_v7" : "client_v7");
    res.setHeader("X-Cleanify-Renderer", "locked-pdfkit-v7");
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, version: APP_VERSION, error: "Error en render oficial Cleanify v7.", details: error.message });
  }
});

app.post("/api/report/monthly/package", async (req, res) => {
  try {
    const packageResult = await buildReportPackage(req.body || {});
    return res.json(packageResult);
  } catch (error) {
    return res.status(500).json({ ok: false, version: APP_VERSION, error: "Error generando paquete de informes.", details: error.message });
  }
});


app.post("/api/report/monthly/html", async (req, res) => {
  try {
    const data = req.body || {};
    const normalizedInput = await prepareReportInputAsync(data);

    if (!normalizedInput.client || !normalizedInput.client.name || normalizedInput.client.name === "Cliente sin nombre") {
      return res.status(400).type("html").send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 32px;">
            <h1>Error</h1>
            <p>Falta el nombre del cliente. Puedes enviarlo como <strong>client.name</strong> o <strong>clientName</strong>.</p>
          </body>
        </html>
      `);
    }

    const enrichedInput = await enrichInputWithGoogleData(normalizedInput);
    const report = buildMonthlyReport(enrichedInput);
    const final_outputs = buildFinalReportOutputs(report);

    return res.type("html").send(final_outputs.client_report_html);
  } catch (error) {
    return res.status(500).type("html").send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 32px;">
          <h1>Error generando el informe mensual</h1>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

app.post("/api/report/monthly", async (req, res) => {
  try {
    const data = req.body || {};
    const normalizedInput = await prepareReportInputAsync(data);

    if (!normalizedInput.client || !normalizedInput.client.name || normalizedInput.client.name === "Cliente sin nombre") {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "Falta el nombre del cliente. Puedes enviarlo como client.name o clientName."
      });
    }

    const enrichedInput = await enrichInputWithGoogleData(normalizedInput);
    const report = buildMonthlyReport(enrichedInput);
    const final_outputs = buildFinalReportOutputs(report);

    return res.json({
      route_version: "api-report-monthly-pdf-package-2026-05-26",
      version: APP_VERSION,
      enrichment_input_received: {
        has_ga4: Boolean(data.ga4),
        has_search_console: Boolean(data.search_console),
        client_name: data.client?.name || null,
        client_domain: data.client?.domain || null,
        ga4_propertyId: enrichedInput.ga4?.propertyId || data.ga4?.propertyId || null,
        ga4_loaded: enrichedInput.ga4?.real_data_loaded ?? false,
        search_console_siteUrl: enrichedInput.search_console?.siteUrl || data.search_console?.siteUrl || null,
        search_console_loaded: enrichedInput.search_console?.real_data_loaded ?? false
      },
           ga4_loaded: report.data_enrichment?.ga4_real_data_loaded ?? false,
      search_console_loaded: report.data_enrichment?.search_console_real_data_loaded ?? false,
      final_outputs,
      report
    });
  } catch (error) {
    return res.status(500).json({
      route_version: "api-report-monthly-pdf-package-2026-05-26",
      version: APP_VERSION,
      ok: false,
      error: "Error generando el informe mensual.",
      details: error.message
    });
  }
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", () => {
    transport.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error MCP:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Cleanify Reporting Agent API",
      version: APP_VERSION,
      description:
        "API para convertir datos mensuales de marketing local en una estructura de informe para clientes y proyectos de Cleanify. Integra resolución de activos Google, Search Console y GA4."
    },
    servers: [
      {
        url: BASE_URL
      }
    ],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Comprobar que la API está funcionando.",
          responses: {
            "200": {
              description: "Estado de la API."
            }
          }
        }
      },
      "/google/assets": {
        get: {
          operationId: "listGoogleAssets",
          summary: "Listar activos disponibles de Search Console y GA4.",
          responses: {
            "200": {
              description: "Listado de activos Google disponibles."
            }
          }
        }
      },
      "/google/resolve-assets": {
        get: {
          operationId: "resolveGoogleAssets",
          summary: "Resolver activos Google por cliente o dominio.",
          parameters: [
            {
              name: "clientName",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "domain",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "location",
              in: "query",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Activos resueltos."
            }
          }
        }
      },
      "/ga4/monthly": {
        get: {
          operationId: "getGa4MonthlyData",
          summary: "Obtener datos mensuales reales de GA4.",
          description:
            "Consulta GA4 por propertyId o intenta resolver la propiedad a partir de clientName/domain. Devuelve usuarios, sesiones, eventos, canales, páginas y eventos de contacto detectados.",
          parameters: [
            {
              name: "propertyId",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "clientName",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "domain",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "startDate",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "endDate",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "previousStartDate",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "previousEndDate",
              in: "query",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Datos mensuales GA4."
            },
            "500": {
              description: "Error consultando GA4."
            }
          }
        }
      },
      "/search-console/monthly": {
        get: {
          operationId: "getSearchConsoleMonthlyData",
          summary: "Obtener datos mensuales reales de Search Console.",
          parameters: [
            {
              name: "siteUrl",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "startDate",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "endDate",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "previousStartDate",
              in: "query",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "previousEndDate",
              in: "query",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Datos mensuales Search Console."
            }
          }
        }
      },
      "/api/report/monthly": {
        post: {
          operationId: "generateMonthlyReport",
          summary: "Generar estructura de informe mensual para un cliente o proyecto.",
          description:
            "Recibe contexto del cliente, fechas, tareas y datos comerciales. Si hay fechas y cliente/dominio, intenta cargar datos reales desde GA4 y Search Console.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    client: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        sector: { type: "string" },
                        location: { type: "string" },
                        domain: { type: "string" },
                        priority_services: {
                          type: "array",
                          items: { type: "string" }
                        }
                      },
                      required: ["name"]
                    },
                    period: {
                      type: "object",
                      properties: {
                        month: { type: "string" },
                        previous_month: { type: "string" }
                      }
                    },
                    ga4: {
                      type: "object",
                      properties: {
                        propertyId: { type: "string" },
                        startDate: { type: "string" },
                        endDate: { type: "string" },
                        previousStartDate: { type: "string" },
                        previousEndDate: { type: "string" }
                      }
                    },
                    search_console: {
                      type: "object",
                      properties: {
                        siteUrl: { type: "string" },
                        startDate: { type: "string" },
                        endDate: { type: "string" },
                        previousStartDate: { type: "string" },
                        previousEndDate: { type: "string" }
                      }
                    },
                    google_business_profile: { type: "object" },
                    calls: { type: "object" },
                    forms: { type: "object" },
                    crm: { type: "object" },
                    tasks_done: {
                      type: "array",
                      items: { type: "string" }
                    },
                    next_month_actions: {
                      type: "array",
                      items: { type: "string" }
                    },
                    client_needs: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["client"]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Informe mensual estructurado."
            },
            "400": {
              description: "Faltan datos obligatorios."
            }
          }
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`Cleanify Reporting Agent escuchando en puerto ${PORT}`);
  console.log(`MCP endpoint disponible en ${BASE_URL}/mcp`);
  console.log(`Versión desplegada: ${APP_VERSION}`);
});
