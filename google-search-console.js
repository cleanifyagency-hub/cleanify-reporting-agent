import { google } from "googleapis";
import { createAuthorizedGoogleClient } from "./google-auth.js";

function sumRows(rows = []) {
  return rows.reduce(
    (acc, row) => {
      acc.clicks += row.clicks || 0;
      acc.impressions += row.impressions || 0;
      acc.positionWeighted += (row.position || 0) * (row.impressions || 0);
      return acc;
    },
    {
      clicks: 0,
      impressions: 0,
      positionWeighted: 0
    }
  );
}

function summarizeSearchConsoleRows(rows = []) {
  const totals = sumRows(rows);
  const ctr = totals.impressions > 0
    ? Number((totals.clicks / totals.impressions).toFixed(4))
    : null;

  const averagePosition = totals.impressions > 0
    ? Number((totals.positionWeighted / totals.impressions).toFixed(2))
    : null;

  return {
    clicks: Number(totals.clicks.toFixed(0)),
    impressions: Number(totals.impressions.toFixed(0)),
    ctr,
    average_position: averagePosition
  };
}

export async function getSearchConsoleMonthlyData({
  siteUrl,
  startDate,
  endDate,
  previousStartDate,
  previousEndDate,
  rowLimit = 10
}) {
  if (!siteUrl || !startDate || !endDate) {
    throw new Error("Faltan parámetros obligatorios: siteUrl, startDate o endDate.");
  }

  const auth = createAuthorizedGoogleClient();

  const searchConsole = google.webmasters({
    version: "v3",
    auth
  });

  const currentResponse = await searchConsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ["query"],
      rowLimit
    }
  });

  const currentRows = currentResponse.data.rows || [];
  const currentSummary = summarizeSearchConsoleRows(currentRows);

  let previousSummary = null;
  let previousRows = [];

  if (previousStartDate && previousEndDate) {
    const previousResponse = await searchConsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: previousStartDate,
        endDate: previousEndDate,
        dimensions: ["query"],
        rowLimit
      }
    });

    previousRows = previousResponse.data.rows || [];
    previousSummary = summarizeSearchConsoleRows(previousRows);
  }

  return {
    siteUrl,
    period: {
      startDate,
      endDate,
      previousStartDate: previousStartDate || null,
      previousEndDate: previousEndDate || null
    },
    summary: {
      clicks: currentSummary.clicks,
      previous_clicks: previousSummary?.clicks ?? null,
      impressions: currentSummary.impressions,
      previous_impressions: previousSummary?.impressions ?? null,
      ctr: currentSummary.ctr,
      previous_ctr: previousSummary?.ctr ?? null,
      average_position: currentSummary.average_position,
      previous_average_position: previousSummary?.average_position ?? null
    },
    top_queries: currentRows.map((row) => ({
      query: row.keys?.[0] || null,
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || null,
      position: row.position || null
    })),
    previous_top_queries: previousRows.map((row) => ({
      query: row.keys?.[0] || null,
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || null,
      position: row.position || null
    }))
  };
}
