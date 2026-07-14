import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthlyReport,
  buildFinalReportOutputs,
  buildClientPdfBuffer,
  buildInternalPdfBuffer
} from "../report-v2.js";

function sampleData() {
  return {
    client: { name: "Cliente Demo", domain: "clientedemo.es" },
    period: { month: "junio 2026", previous_month: "mayo 2026" },
    ga4: {
      real_data_loaded: true,
      propertyId: "123",
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
      siteUrl: "sc-domain:clientedemo.es",
      clicks: 40,
      previous_clicks: 45,
      impressions: 2000,
      previous_impressions: 1000,
      ctr: 0.02,
      previous_ctr: 0.045,
      average_position: 9,
      previous_average_position: 8,
      top_queries: [
        { query: "cliente demo", clicks: 35, impressions: 500, ctr: 0.07, position: 2 },
        { query: "limpieza profesional", clicks: 2, impressions: 600, ctr: 0.0033, position: 9 }
      ]
    }
  };
}

test("el informe cliente omite por completo las secciones ausentes", () => {
  const report = buildMonthlyReport(sampleData());
  const outputs = buildFinalReportOutputs(report);
  assert.equal(Object.hasOwn(report.client_report_sections, "que_se_ha_hecho"), false);
  assert.equal(Object.hasOwn(report.client_report_sections, "necesitamos_del_cliente"), false);
  assert.doesNotMatch(outputs.client_report_markdown, /Trabajo realizado/i);
  assert.doesNotMatch(outputs.client_report_html, /Trabajo realizado/i);
  assert.doesNotMatch(outputs.client_report_markdown, /datos no disponibles|no se han cargado|falta[n]? datos/i);
});

test("el informe interno prioriza y detalla los problemas detectados", () => {
  const report = buildMonthlyReport(sampleData());
  const issues = report.internal_summary_for_cleanify.issues;
  assert.ok(issues.length >= 5);
  assert.match(issues.map((item) => item.title).join(" | "), /Direct/);
  assert.match(issues.map((item) => item.title).join(" | "), /interacción/);
  assert.match(issues.map((item) => item.title).join(" | "), /contacto/);
  assert.match(issues.map((item) => item.title).join(" | "), /visibilidad/);
  assert.deepEqual([...issues].sort((a, b) => a.priority_order - b.priority_order), issues);
  assert.ok(issues.every((item) => item.evidence.length && item.impact && item.diagnosis && item.recommended_actions.length && item.validation));
});

test("cero se conserva como dato real y no como ausencia", () => {
  const data = sampleData();
  data.ga4.users = 0;
  const report = buildMonthlyReport(data);
  assert.equal(report.metrics_summary.ga4.users.current, 0);
  assert.match(report.client_report_sections.lectura_ga4.join(" "), /Usuarios activos: 0/);
});

test("los dos PDF se generan con la estructura nueva", async () => {
  const report = buildMonthlyReport(sampleData());
  const outputs = buildFinalReportOutputs(report);
  const clientPdf = await buildClientPdfBuffer(report, outputs);
  const internalPdf = await buildInternalPdfBuffer(report, outputs);
  assert.equal(clientPdf.subarray(0, 4).toString(), "%PDF");
  assert.equal(internalPdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(clientPdf.length > 10000);
  assert.ok(internalPdf.length > clientPdf.length);
});
