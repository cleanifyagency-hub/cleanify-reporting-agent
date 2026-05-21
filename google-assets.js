import { google } from "googleapis";
import { createAuthorizedGoogleClient } from "./google-auth.js";

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function extractIdFromResourceName(resourceName = "") {
  const parts = String(resourceName).split("/");
  return parts[parts.length - 1] || resourceName;
}

function domainFromSearchConsoleSite(siteUrl = "") {
  const value = String(siteUrl || "");

  if (value.startsWith("sc-domain:")) {
    return value.replace("sc-domain:", "").replace(/^www\./, "");
  }

  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return value
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }
}

export async function listAvailableAssets() {
  const auth = createAuthorizedGoogleClient();

  const searchConsole = google.webmasters({
    version: "v3",
    auth
  });

  const analyticsAdmin = google.analyticsadmin({
    version: "v1beta",
    auth
  });

  const result = {
    search_console: [],
    ga4: [],
    warnings: []
  };

  try {
    const sitesResponse = await searchConsole.sites.list();

    result.search_console = (sitesResponse.data.siteEntry || []).map((site) => ({
      siteUrl: site.siteUrl,
      domain: domainFromSearchConsoleSite(site.siteUrl),
      permissionLevel: site.permissionLevel
    }));
  } catch (error) {
    result.warnings.push({
      source: "search_console",
      message: "No se pudieron listar propiedades de Search Console.",
      details: error.message
    });
  }

  try {
    const summariesResponse = await analyticsAdmin.accountSummaries.list();

    const accountSummaries = summariesResponse.data.accountSummaries || [];

    result.ga4 = accountSummaries.flatMap((accountSummary) => {
      const accountId = extractIdFromResourceName(accountSummary.account);
      const accountName = accountSummary.displayName || accountId;

      return (accountSummary.propertySummaries || []).map((propertySummary) => {
        const propertyId = extractIdFromResourceName(propertySummary.property);
        const propertyName = propertySummary.displayName || propertyId;

        return {
          accountId,
          accountName,
          propertyId,
          propertyName,
          propertyResourceName: propertySummary.property,
          normalizedPropertyName: normalizeText(propertyName)
        };
      });
    });
  } catch (error) {
    result.warnings.push({
      source: "ga4",
      message: "No se pudieron listar propiedades de GA4.",
      details: error.message
    });
  }

  return result;
}

export async function resolveClientAssets({
  clientName,
  domain,
  location
}) {
  const assets = await listAvailableAssets();

  const normalizedClientName = normalizeText(clientName);
  const normalizedDomain = normalizeText(domain);
  const normalizedLocation = normalizeText(location);

  const searchConsoleMatches = assets.search_console
    .map((site) => {
      let score = 0;
      const normalizedSiteUrl = normalizeText(site.siteUrl);
      const normalizedSiteDomain = normalizeText(site.domain);

      if (normalizedDomain && normalizedSiteDomain.includes(normalizedDomain)) {
        score += 100;
      }

      if (normalizedClientName && normalizedSiteUrl.includes(normalizedClientName)) {
        score += 40;
      }

      if (normalizedClientName && normalizedSiteDomain.includes(normalizedClientName)) {
        score += 40;
      }

      return {
        ...site,
        matchScore: score
      };
    })
    .filter((site) => site.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);

  const ga4Matches = assets.ga4
    .map((property) => {
      let score = 0;
      const normalizedPropertyName = normalizeText(property.propertyName);
      const normalizedAccountName = normalizeText(property.accountName);

      if (normalizedClientName && normalizedPropertyName.includes(normalizedClientName)) {
        score += 80;
      }

      if (normalizedClientName && normalizedAccountName.includes(normalizedClientName)) {
        score += 40;
      }

      if (normalizedDomain && normalizedPropertyName.includes(normalizedDomain)) {
        score += 100;
      }

      if (normalizedLocation && normalizedPropertyName.includes(normalizedLocation)) {
        score += 10;
      }

      return {
        ...property,
        matchScore: score
      };
    })
    .filter((property) => property.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);

  const bestSearchConsole = searchConsoleMatches[0] || null;
  const bestGa4 = ga4Matches[0] || null;

  return {
    query: {
      clientName: clientName || null,
      domain: domain || null,
      location: location || null
    },
    resolved: {
      search_console: bestSearchConsole
        ? {
            siteUrl: bestSearchConsole.siteUrl,
            domain: bestSearchConsole.domain,
            permissionLevel: bestSearchConsole.permissionLevel,
            matchScore: bestSearchConsole.matchScore
          }
        : null,
      ga4: bestGa4
        ? {
            propertyId: bestGa4.propertyId,
            propertyName: bestGa4.propertyName,
            accountId: bestGa4.accountId,
            accountName: bestGa4.accountName,
            matchScore: bestGa4.matchScore
          }
        : null
    },
    candidates: {
      search_console: searchConsoleMatches.slice(0, 5),
      ga4: ga4Matches.slice(0, 5)
    },
    warnings: assets.warnings
  };
}
