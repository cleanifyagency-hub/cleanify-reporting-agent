import {
  getGoogleAuthUrl,
  exchangeGoogleCodeForTokens,
  createAuthorizedGoogleClient
} from "./google-auth.js";
import { getSearchConsoleMonthlyData } from "./google-search-console.js";
import { listAvailableAssets, resolveClientAssets } from "./google-assets.js";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://reportes.cleanify.agency";
const APP_VERSION = "1.5.0-final-report";

app.use(express.json({ limit: "4mb" }));

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

async function enrichInputWithGoogleData(input) {
  const withGa4 = await enrichInputWithGa4(input);
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
    missingDataBlocks.push(
      `No se han podido cargar los datos reales de GA4: ${data.ga4.error || "error no especificado"}.`
    );
  }

  if (!data.google_business_profile) {
    missingDataBlocks.push("No se han aportado datos de Google Business Profile.");
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

  if (searchConsole.siteUrl && searchConsole.real_data_loaded === false) {
    missingDataBlocks.push(
      `No se han podido cargar los datos reales de Search Console: ${searchConsole.error || "error no especificado"}.`
    );
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
          ? "Se han cargado datos reales desde Google. Revisar si la visibilidad y el tráfico se están convirtiendo en oportunidades comerciales."
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
        "Canales de GA4 con tráfico pero baja conversión.",
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

  const clientReportMarkdown = `# Informe mensual · ${clientName}

Periodo: ${month}

## 1. Resumen del mes

${sections.resumen_del_mes || `Durante ${month}, el proyecto ha seguido avanzando con foco en visibilidad, medición y captación.`}

Este mes ya contamos con lectura real de GA4 y Search Console, lo que nos permite revisar tanto el comportamiento de la web como la visibilidad orgánica en Google. La lectura debe hacerse con prudencia: hay señales útiles, pero todavía faltan algunos bloques importantes como llamadas, formularios, CRM o Google Business Profile para conectar toda la foto de marketing con oportunidades comerciales reales.

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

En Search Console vemos que todavía hay margen de mejora en visibilidad y posiciones. Esto no debe interpretarse como un problema aislado, sino como una señal de que debemos seguir reforzando páginas, contenidos, intención de búsqueda y optimización de snippets para convertir más apariciones en clics.

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

Este mes ya contamos con datos reales de GA4 y Search Console, lo que nos ayuda a interpretar mejor la evolución de la web y la visibilidad orgánica. Como verás, el objetivo no es solo revisar métricas, sino entender qué se está construyendo, qué empieza a moverse y qué acciones pueden ayudarnos a seguir mejorando la captación.

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
      <p>Este mes ya contamos con lectura real de GA4 y Search Console, lo que nos permite revisar tanto el comportamiento de la web como la visibilidad orgánica en Google. La lectura debe hacerse con prudencia: hay señales útiles, pero todavía faltan algunos bloques importantes como llamadas, formularios, CRM o Google Business Profile para conectar toda la foto de marketing con oportunidades comerciales reales.</p>
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
    <p>La web ya está generando datos suficientes para revisar usuarios, sesiones, páginas principales y eventos. Aunque este mes no se observa un crecimiento fuerte frente al periodo anterior, sí tenemos una base de medición útil para detectar qué páginas reciben visitas y qué acciones conviene reforzar.</p>

    <h3>Visibilidad orgánica en Google</h3>
    <div class="metrics-grid">
      <div class="metric-card"><strong>Clics orgánicos</strong>${scClicks}</div>
      <div class="metric-card"><strong>Impresiones</strong>${scImpressions}</div>
      <div class="metric-card"><strong>CTR</strong>${scCtr}</div>
      <div class="metric-card"><strong>Posición media</strong>${scPosition}</div>
    </div>
    <p>En Search Console vemos que todavía hay margen de mejora en visibilidad y posiciones. Esto no debe interpretarse como un problema aislado, sino como una señal de que debemos seguir reforzando páginas, contenidos, intención de búsqueda y optimización de snippets para convertir más apariciones en clics.</p>

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
        "Genera un informe mensual para clientes o proyectos de Cleanify. Si el input incluye fechas y cliente/dominio, intenta resolver y cargar datos reales de GA4 y Search Console antes de generar el informe.",
      inputSchema: {
        client: z.object({
          name: z.string().describe("Nombre del cliente o proyecto"),
          sector: z.string().optional().describe("Sector del cliente o proyecto"),
          location: z.string().optional().describe("Ciudad, provincia o zona principal"),
          domain: z.string().optional().describe("Dominio del cliente o proyecto, por ejemplo econeta.es"),
          priority_services: z.array(z.string()).optional().describe("Servicios prioritarios")
        }),
        period: z.object({
          month: z.string().optional(),
          previous_month: z.string().optional()
        }).optional(),
        ga4: z.record(z.any()).optional().describe(
          "Puede incluir propertyId, startDate, endDate, previousStartDate y previousEndDate. Si no incluye propertyId, el agente intenta resolverlo por client.domain o client.name."
        ),
        search_console: z.record(z.any()).optional().describe(
          "Puede incluir datos manuales o una petición de datos reales con siteUrl, startDate, endDate, previousStartDate y previousEndDate. Si falta siteUrl, intenta resolverlo por client.domain."
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2)
          }
        ],
        structuredContent: report
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
      ga4_monthly: `${BASE_URL}/ga4/monthly`,
      search_console_monthly: `${BASE_URL}/search-console/monthly`,
      monthly_report: `${BASE_URL}/api/report/monthly`,
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
      "GET /oauth/google/start",
      "GET /oauth/google/callback",
      "GET /google/test",
      "GET /google/assets",
      "GET /google/resolve-assets",
      "GET /ga4/monthly",
      "GET /search-console/monthly",
      "POST /api/report/monthly",
      "POST /mcp",
      "GET /openapi.json"
    ]
  });
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

app.post("/api/report/monthly", async (req, res) => {
  try {
    const data = req.body || {};

    if (!data.client || !data.client.name) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "Falta client.name en el JSON enviado."
      });
    }

    const enrichedInput = await enrichInputWithGoogleData(data);
    const report = buildMonthlyReport(enrichedInput);
const final_outputs = buildFinalReportOutputs(report);

return res.json({
      route_version: "api-report-monthly-ga4-search-console-2026-05-22",
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
      route_version: "api-report-monthly-ga4-search-console-2026-05-22",
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
