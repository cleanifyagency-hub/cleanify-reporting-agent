import { google } from "googleapis";
import { createAuthorizedGoogleClient } from "./google-auth.js";

function numberValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readMetric(row, metricHeaders, metricName) {
  const index = metricHeaders.findIndex((header) => header.name === metricName);
  if (index === -1) return 0;
  return numberValue(row.metricValues?.[index]?.value);
}

function readDimension(row, dimensionHeaders, dimensionName) {
  const index = dimensionHeaders.findIndex((header) => header.name === dimensionName);
  if (index === -1) return null;
  return row.dimensionValues?.[index]?.value || null;
}

function extractTotals(response, metricNames = []) {
  const metricHeaders = response.data.metricHeaders || [];
  const rows = response.data.rows || [];

  const totals = Object.fromEntries(metricNames.map((metricName) => [metricName, 0]));

  for (const row of rows) {
    for (const metricName of metricNames) {
      totals[metricName] += readMetric(row, metricHeaders, metricName);
    }
  }

  return totals;
}

async function runGa4Report({
  analyticsData,
  propertyId,
  startDate,
  endDate,
  metrics,
  dimensions = [],
  limit = 10,
  orderMetric
}) {
  const requestBody = {
    dateRanges: [
      {
        startDate,
        endDate
      }
    ],
    metrics: metrics.map((name) => ({ name })),
    limit
  };

  if (dimensions.length > 0) {
    requestBody.dimensions = dimensions.map((name) => ({ name }));
  }

  if (orderMetric) {
    requestBody.orderBys = [
      {
        metric: {
          metricName: orderMetric
        },
        desc: true
      }
    ];
  }

  return analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody
  });
}

async function getGa4Totals({
  analyticsData,
  propertyId,
  startDate,
  endDate
}) {
  const metrics = [
    "activeUsers",
    "sessions",
    "eventCount",
    "screenPageViews"
  ];

  const response = await runGa4Report({
    analyticsData,
    propertyId,
    startDate,
    endDate,
    metrics,
    dimensions: [],
    limit: 1
  });

  const totals = response.data.totals?.[0]?.metricValues;

  if (totals && totals.length > 0) {
    return {
      activeUsers: numberValue(totals[0]?.value),
      sessions: numberValue(totals[1]?.value),
      eventCount: numberValue(totals[2]?.value),
      screenPageViews: numberValue(totals[3]?.value)
    };
  }

  return extractTotals(response, metrics);
}

async function getGa4TopPages({
  analyticsData,
  propertyId,
  startDate,
  endDate,
  limit = 10
}) {
  const response = await runGa4Report({
    analyticsData,
    propertyId,
    startDate,
    endDate,
    dimensions: ["pagePath"],
    metrics: ["screenPageViews", "activeUsers", "sessions"],
    orderMetric: "screenPageViews",
    limit
  });

  const dimensionHeaders = response.data.dimensionHeaders || [];
  const metricHeaders = response.data.metricHeaders || [];

  return (response.data.rows || []).map((row) => ({
    pagePath: readDimension(row, dimensionHeaders, "pagePath"),
    screenPageViews: readMetric(row, metricHeaders, "screenPageViews"),
    activeUsers: readMetric(row, metricHeaders, "activeUsers"),
    sessions: readMetric(row, metricHeaders, "sessions")
  }));
}

async function getGa4TopChannels({
  analyticsData,
  propertyId,
  startDate,
  endDate,
  limit = 10
}) {
  const response = await runGa4Report({
    analyticsData,
    propertyId,
    startDate,
    endDate,
    dimensions: ["sessionDefaultChannelGroup"],
    metrics: ["sessions", "activeUsers", "eventCount"],
    orderMetric: "sessions",
    limit
  });

  const dimensionHeaders = response.data.dimensionHeaders || [];
  const metricHeaders = response.data.metricHeaders || [];

  return (response.data.rows || []).map((row) => ({
    channel: readDimension(row, dimensionHeaders, "sessionDefaultChannelGroup"),
    sessions: readMetric(row, metricHeaders, "sessions"),
    activeUsers: readMetric(row, metricHeaders, "activeUsers"),
    eventCount: readMetric(row, metricHeaders, "eventCount")
  }));
}

async function getGa4TopEvents({
  analyticsData,
  propertyId,
  startDate,
  endDate,
  limit = 10
}) {
  const response = await runGa4Report({
    analyticsData,
    propertyId,
    startDate,
    endDate,
    dimensions: ["eventName"],
    metrics: ["eventCount"],
    orderMetric: "eventCount",
    limit
  });

  const dimensionHeaders = response.data.dimensionHeaders || [];
  const metricHeaders = response.data.metricHeaders || [];

  return (response.data.rows || []).map((row) => ({
    eventName: readDimension(row, dimensionHeaders, "eventName"),
    eventCount: readMetric(row, metricHeaders, "eventCount")
  }));
}

export async function getGa4MonthlyData({
  propertyId,
  startDate,
  endDate,
  previousStartDate,
  previousEndDate,
  rowLimit = 10
}) {
  if (!propertyId || !startDate || !endDate) {
    throw new Error("Faltan parámetros obligatorios: propertyId, startDate o endDate.");
  }

  const auth = createAuthorizedGoogleClient();

  const analyticsData = google.analyticsdata({
    version: "v1beta",
    auth
  });

  const currentTotals = await getGa4Totals({
    analyticsData,
    propertyId,
    startDate,
    endDate
  });

  let previousTotals = null;

  if (previousStartDate && previousEndDate) {
    previousTotals = await getGa4Totals({
      analyticsData,
      propertyId,
      startDate: previousStartDate,
      endDate: previousEndDate
    });
  }

  const [topPages, topChannels, topEvents] = await Promise.all([
    getGa4TopPages({
      analyticsData,
      propertyId,
      startDate,
      endDate,
      limit: rowLimit
    }),
    getGa4TopChannels({
      analyticsData,
      propertyId,
      startDate,
      endDate,
      limit: rowLimit
    }),
    getGa4TopEvents({
      analyticsData,
      propertyId,
      startDate,
      endDate,
      limit: rowLimit
    })
  ]);

  return {
    propertyId,
    period: {
      startDate,
      endDate,
      previousStartDate: previousStartDate || null,
      previousEndDate: previousEndDate || null
    },
    summary: {
      activeUsers: currentTotals.activeUsers || 0,
      previous_activeUsers: previousTotals?.activeUsers ?? null,
      sessions: currentTotals.sessions || 0,
      previous_sessions: previousTotals?.sessions ?? null,
      eventCount: currentTotals.eventCount || 0,
      previous_eventCount: previousTotals?.eventCount ?? null,
      screenPageViews: currentTotals.screenPageViews || 0,
      previous_screenPageViews: previousTotals?.screenPageViews ?? null
    },
    top_pages: topPages,
    top_channels: topChannels,
    top_events: topEvents
  };
}
