import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildMonthlyReport,
  buildFinalReportOutputs,
  buildClientPdfBuffer,
  buildInternalPdfBuffer
} from "../report-v2.js";

const data = {
  client: { name: "Caso QA Cleanify", domain: "qa-cleanify.example" },
  period: { month: "junio 2026", previous_month: "mayo 2026" },
  ga4: {
    real_data_loaded: true,
    propertyId: "qa-123",
    users: 80,
    previous_users: 100,
    sessions: 100,
    previous_sessions: 120,
    engagement_rate: 0.25,
    previous_engagement_rate: 0.5,
    conversions: 4,
    previous_conversions: 10,
    top_channels: [
      { sessionDefaultChannelGroup: "Direct", sessions: 80 },
      { sessionDefaultChannelGroup: "Organic Search", sessions: 20 }
    ]
  },
  search_console: {
    real_data_loaded: true,
    siteUrl: "sc-domain:qa-cleanify.example",
    clicks: 40,
    previous_clicks: 45,
    impressions: 2000,
    previous_impressions: 1000,
    ctr: 0.02,
    previous_ctr: 0.045,
    average_position: 9,
    previous_average_position: 8,
    top_queries: [
      { query: "caso qa cleanify", clicks: 35, impressions: 500, ctr: 0.07, position: 2 },
      { query: "limpieza profesional", clicks: 2, impressions: 600, ctr: 0.0033, position: 9 }
    ]
  }
};

const outputDir = path.join(process.cwd(), "output", "pdf");
await mkdir(outputDir, { recursive: true });
const report = buildMonthlyReport(data);
const outputs = buildFinalReportOutputs(report);
await writeFile(path.join(outputDir, "qa-cleanify-informe-cliente.pdf"), await buildClientPdfBuffer(report, outputs));
await writeFile(path.join(outputDir, "qa-cleanify-informe-interno.pdf"), await buildInternalPdfBuffer(report, outputs));
await writeFile(path.join(outputDir, "qa-cleanify-report.json"), JSON.stringify({ report, outputs }, null, 2));
