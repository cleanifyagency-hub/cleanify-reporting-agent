import { listAvailableAssets } from "./google-assets.js";
import { getClientsFromSheet } from "./google-sheets-clients.js";

const BUILTIN_STATUS_OVERRIDES = {
  "econeta.es": "inactive"
};

const ACTIVE_STATUSES = new Set(["active", "activo", "activa", "alta", "auto_discovered"]);
const INACTIVE_STATUSES = new Set(["inactive", "inactivo", "inactiva", "baja", "cancelled", "cancelado"]);
const PAUSED_STATUSES = new Set(["paused", "pausado", "pausada", "en pausa"]);

export function normalizeCatalogText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCatalogDomain(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\.$/, "");
}

function compact(value = "") {
  return normalizeCatalogText(value).replace(/[^a-z0-9]/g, "");
}

function domainStem(domain = "") {
  return normalizeCatalogDomain(domain).split(".")[0] || "";
}

function titleFromDomain(domain = "") {
  const stem = domainStem(domain).replace(/[-_]+/g, " ");
  return stem
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || domain || "Cliente de Google";
}

function normalizeStatus(value, fallback = "active") {
  const status = normalizeCatalogText(value);
  if (INACTIVE_STATUSES.has(status)) return "inactive";
  if (PAUSED_STATUSES.has(status)) return "paused";
  if (ACTIVE_STATUSES.has(status)) return "active";
  return fallback;
}

function parseEnvOverrides(env = process.env) {
  const result = { ...BUILTIN_STATUS_OVERRIDES };

  for (const domain of String(env.INACTIVE_CLIENT_DOMAINS || "").split(",")) {
    const normalized = normalizeCatalogDomain(domain);
    if (normalized) result[normalized] = "inactive";
  }

  if (env.CLIENT_STATUS_OVERRIDES) {
    try {
      const parsed = JSON.parse(env.CLIENT_STATUS_OVERRIDES);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          const normalizedKey = normalizeCatalogDomain(key) || normalizeCatalogText(key);
          if (normalizedKey) result[normalizedKey] = normalizeStatus(value);
        }
      }
    } catch {
      // An invalid optional override must never prevent discovery from Google.
    }
  }

  return result;
}

function permissionRank(value = "") {
  const permission = normalizeCatalogText(value);
  if (permission.includes("owner")) return 5;
  if (permission.includes("full")) return 4;
  if (permission.includes("restricted")) return 2;
  if (permission.includes("unverified")) return 0;
  return 1;
}

function isUsableSearchConsoleAsset(asset = {}) {
  return permissionRank(asset.permissionLevel) > 0;
}

function bestSearchConsoleByDomain(searchConsole = []) {
  const grouped = new Map();
  for (const asset of searchConsole) {
    const domain = normalizeCatalogDomain(asset.domain || asset.siteUrl);
    if (!domain) continue;
    const current = grouped.get(domain);
    if (!current || permissionRank(asset.permissionLevel) > permissionRank(current.permissionLevel)) {
      grouped.set(domain, { ...asset, domain });
    }
  }
  return [...grouped.values()];
}

function scoreGa4ForClient(property = {}, client = {}) {
  const propertyText = normalizeCatalogText(`${property.propertyName || ""} ${property.accountName || ""}`);
  const propertyCompact = compact(propertyText);
  const domain = normalizeCatalogDomain(client.domain);
  const stem = compact(domainStem(domain));
  const name = normalizeCatalogText(client.name);
  const nameCompact = compact(name);
  let score = 0;

  if (client.ga4PropertyId && String(client.ga4PropertyId) === String(property.propertyId)) score += 300;
  if (domain && propertyText.includes(domain)) score += 180;
  if (stem && stem.length >= 4 && propertyCompact.includes(stem)) score += 110;
  if (nameCompact && nameCompact.length >= 4 && propertyCompact.includes(nameCompact)) score += 100;

  const meaningfulTokens = name.split(" ").filter((token) => token.length >= 4);
  score += meaningfulTokens.filter((token) => propertyText.includes(token)).length * 18;
  return score;
}

function findSheetClient(sheetClients, client) {
  return sheetClients.find((sheet) => {
    const sameDomain = normalizeCatalogDomain(sheet.domain) &&
      normalizeCatalogDomain(sheet.domain) === normalizeCatalogDomain(client.domain);
    const sameSc = sheet.searchConsoleSiteUrl && client.searchConsoleSiteUrl &&
      normalizeCatalogDomain(sheet.searchConsoleSiteUrl) === normalizeCatalogDomain(client.searchConsoleSiteUrl);
    const sameGa4 = sheet.ga4PropertyId && client.ga4PropertyId &&
      String(sheet.ga4PropertyId) === String(client.ga4PropertyId);
    const sameName = normalizeCatalogText(sheet.name) &&
      normalizeCatalogText(sheet.name) === normalizeCatalogText(client.name);
    return sameDomain || sameSc || sameGa4 || sameName;
  }) || null;
}

function applyContext(client, sheetClient) {
  if (!sheetClient) return client;
  return {
    ...client,
    client_id: sheetClient.client_id || client.client_id || null,
    name: sheetClient.name || client.name,
    aliases: [...new Set([...(client.aliases || []), ...(sheetClient.aliases || []), sheetClient.name, sheetClient.domain].filter(Boolean))],
    domain: sheetClient.domain || client.domain,
    sector: sheetClient.sector || client.sector || null,
    location: sheetClient.location || client.location || null,
    ga4PropertyId: sheetClient.ga4PropertyId || client.ga4PropertyId || null,
    searchConsoleSiteUrl: sheetClient.searchConsoleSiteUrl || client.searchConsoleSiteUrl || null,
    priorityServices: sheetClient.priorityServices || client.priorityServices || [],
    context: {
      driveFolderUrl: sheetClient.driveFolderUrl || null,
      dinorankProject: sheetClient.dinorankProject || null,
      responsable: sheetClient.responsable || null,
      notes: sheetClient.notes || null
    },
    sheet_status: sheetClient.estado || null,
    metadata_source: "google_sheet_optional"
  };
}

function finalizeClient(client, { overrides, sheetClient } = {}) {
  const domain = normalizeCatalogDomain(client.domain || client.searchConsoleSiteUrl);
  const override = overrides[domain] || overrides[normalizeCatalogText(client.name)];
  let status = normalizeStatus(override || sheetClient?.estado, "active");
  const scUsable = client.searchConsolePermission
    ? isUsableSearchConsoleAsset({ permissionLevel: client.searchConsolePermission })
    : false;
  const hasAnyUsableAsset = Boolean(client.ga4PropertyId || (client.searchConsoleSiteUrl && scUsable));

  if (!hasAnyUsableAsset && client.searchConsoleSiteUrl && status === "active") {
    status = "permission_required";
  }

  return {
    ...client,
    domain: domain || null,
    estado: status,
    status,
    reportingAllowed: status === "active" && hasAnyUsableAsset,
    reporting_allowed: status === "active" && hasAnyUsableAsset,
    source: "google_auto",
    discovered_from: [
      client.searchConsoleSiteUrl ? "search_console" : null,
      client.ga4PropertyId ? "ga4" : null
    ].filter(Boolean),
    aliases: [...new Set([...(client.aliases || []), client.name, domain].filter(Boolean))]
  };
}

export function buildCatalogFromSources({ assets = {}, sheetClients = [], env = process.env } = {}) {
  const searchConsole = bestSearchConsoleByDomain(Array.isArray(assets.search_console) ? assets.search_console : []);
  const ga4 = Array.isArray(assets.ga4) ? assets.ga4 : [];
  const overrides = parseEnvOverrides(env);
  const usedGa4Ids = new Set();
  const clients = [];

  for (const site of searchConsole) {
    const domain = normalizeCatalogDomain(site.domain || site.siteUrl);
    const initial = {
      name: titleFromDomain(domain),
      domain,
      searchConsoleSiteUrl: site.siteUrl,
      searchConsolePermission: site.permissionLevel,
      ga4PropertyId: null,
      ga4PropertyName: null,
      aliases: [domain]
    };
    const sheetClient = findSheetClient(sheetClients, initial);
    const contextual = applyContext(initial, sheetClient);
    const bestGa4 = ga4
      .map((property) => ({ property, score: scoreGa4ForClient(property, contextual) }))
      .filter(({ property, score }) => !usedGa4Ids.has(String(property.propertyId)) && score >= 55)
      .sort((a, b) => b.score - a.score)[0];

    if (bestGa4) {
      contextual.ga4PropertyId = bestGa4.property.propertyId;
      contextual.ga4PropertyName = bestGa4.property.propertyName;
      contextual.ga4AccountName = bestGa4.property.accountName;
      contextual.ga4MatchScore = bestGa4.score;
      usedGa4Ids.add(String(bestGa4.property.propertyId));
    }
    clients.push(finalizeClient(contextual, { overrides, sheetClient }));
  }

  for (const property of ga4) {
    if (usedGa4Ids.has(String(property.propertyId))) continue;
    const initial = {
      name: property.propertyName || property.accountName || `GA4 ${property.propertyId}`,
      domain: null,
      searchConsoleSiteUrl: null,
      searchConsolePermission: null,
      ga4PropertyId: property.propertyId,
      ga4PropertyName: property.propertyName,
      ga4AccountName: property.accountName,
      aliases: [property.propertyName, property.accountName].filter(Boolean)
    };
    const sheetClient = findSheetClient(sheetClients, initial);
    const contextual = applyContext(initial, sheetClient);
    clients.push(finalizeClient(contextual, { overrides, sheetClient }));
  }

  return clients.sort((a, b) => {
    if (a.reportingAllowed !== b.reportingAllowed) return a.reportingAllowed ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), "es");
  });
}

export async function getAutomaticClientCatalog({ includeInactive = true } = {}) {
  const [assetsResult, sheetResult] = await Promise.allSettled([
    listAvailableAssets(),
    getClientsFromSheet()
  ]);

  if (assetsResult.status === "rejected") {
    const error = new Error(`No se pudo descubrir el inventario de Google: ${assetsResult.reason?.message || assetsResult.reason}`);
    error.code = "GOOGLE_ASSET_DISCOVERY_FAILED";
    throw error;
  }

  const assets = assetsResult.value || {};
  const sheetClients = sheetResult.status === "fulfilled" && Array.isArray(sheetResult.value?.clients)
    ? sheetResult.value.clients
    : [];
  const clients = buildCatalogFromSources({ assets, sheetClients });
  const visibleClients = includeInactive ? clients : clients.filter((client) => client.reportingAllowed);

  return {
    source: "google_auto",
    clients: visibleClients,
    allClients: clients,
    counts: {
      total: clients.length,
      reportable: clients.filter((client) => client.reportingAllowed).length,
      inactive: clients.filter((client) => client.status === "inactive").length,
      paused: clients.filter((client) => client.status === "paused").length,
      permission_required: clients.filter((client) => client.status === "permission_required").length,
      search_console_assets: Array.isArray(assets.search_console) ? assets.search_console.length : 0,
      ga4_assets: Array.isArray(assets.ga4) ? assets.ga4.length : 0
    },
    warnings: [
      ...(Array.isArray(assets.warnings) ? assets.warnings : []),
      sheetResult.status === "rejected"
        ? { source: "google_sheet_optional", message: sheetResult.reason?.message || String(sheetResult.reason) }
        : null
    ].filter(Boolean)
  };
}

export function assertClientReportable(client, { allowInactiveClient = false } = {}) {
  if (!client) {
    const error = new Error("El cliente no figura entre los activos descubiertos en Search Console o Analytics.");
    error.code = "CLIENT_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  const reportingAllowed = client.reportingAllowed ?? client.reporting_allowed ?? true;
  if (!reportingAllowed && !allowInactiveClient) {
    const error = new Error(`El cliente ${client.name || "solicitado"} está ${client.status || client.estado || "no activo"}. El informe queda bloqueado para evitar entregas accidentales.`);
    error.code = "CLIENT_NOT_ACTIVE";
    error.statusCode = 409;
    throw error;
  }
  return client;
}
