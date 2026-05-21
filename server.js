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

app.use(express.json({ limit: "2mb" }));

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

async function enrichInputWithSearchConsole(input) {
  let enrichedInput = { ...input };

  const searchConsoleInput = input.search_console || {};

  const hasSearchConsoleRequest =
    searchConsoleInput.siteUrl &&
    searchConsoleInput.startDate &&
    searchConsoleInput.endDate;

  if (!hasSearchConsoleRequest) {
    return enrichedInput;
  }

  try {
    const realSearchConsoleData = await getSearchConsoleMonthlyData({
      siteUrl: searchConsoleInput.siteUrl,
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
        real_data_loaded: false,
        source: "google_search_console",
        error: error.message
      }
    };
  }
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

  const searchConsoleSignals = buildSearchConsoleSignals(searchConsole);
  signals.push(...searchConsoleSignals);

  if (ga4Users.trend === "sube") {
    signals.push("Aumentan los usuarios en la web.");
  }

  if (ga4Conversions.trend === "sube") {
    signals.push("Aumentan las conversiones registradas en GA4.");
  }

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
      search_console_real_data_loaded: searchConsole.real_data_loaded ?? false,
      search_console_siteUrl: searchConsole.siteUrl || null,
      missing_data_blocks: missingDataBlocks
    },
    client: {
      name: client.name || "Cliente sin nombre",
      sector: client.sector || null,
      location: client.location || null,
      priority_services: client.priority_services || []
    },
    period: {
      month: period.month || null,
      previous_month: period.previous_month || null
    },
    metrics_summary: {
      ga4: {
        users: ga4Users,
        sessions: compare(ga4.sessions, ga4.previous_sessions),
        conversions: ga4Conversions
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
      lectura_real_del_mes: searchConsole.real_data_loaded
        ? "Search Console se ha cargado correctamente. Revisar si el aumento de visibilidad se está convirtiendo en tráfico cualificado y oportunidades comerciales."
        : "No se ha podido cargar Search Console dentro del informe. Revisar siteUrl, permisos y fechas.",
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
        "Servicios o zonas con mejor conversión."
      ],
      que_debe_decir_account_manager: "Explicar el avance con calma: qué se ha construido, qué señales empiezan a verse y qué se priorizará el próximo mes.",
      que_no_conviene_prometer: "No prometer posiciones, leads garantizados ni resultados inmediatos si el proyecto aún está construyendo base.",
      proxima_accion_prioritaria: nextActions[0] || "Definir la acción de mayor impacto para el próximo mes."
    }
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "cleanify-reporting-agent",
    version: "1.2.0"
  });

  server.registerTool(
    "generateMonthlyReport",
    {
      title: "Generar informe mensual de cliente",
      description:
        "Genera un informe mensual para clientes de Cleanify. Si search_console incluye siteUrl, startDate y endDate, esta herramienta consulta datos reales de Google Search Console antes de generar el informe.",
      inputSchema: {
        client: z.object({
          name: z.string().describe("Nombre del cliente"),
          sector: z.string().optional().describe("Sector del cliente"),
          location: z.string().optional().describe("Ciudad, provincia o zona principal"),
          priority_services: z.array(z.string()).optional().describe("Servicios prioritarios")
        }),
        period: z.object({
          month: z.string().optional(),
          previous_month: z.string().optional()
        }).optional(),
        ga4: z.record(z.any()).optional(),
        search_console: z.record(z.any()).optional().describe(
          "Puede incluir datos manuales o una petición de datos reales con siteUrl, startDate, endDate, previousStartDate y previousEndDate."
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
      const enrichedInput = await enrichInputWithSearchConsole(input);
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

  return server;
}

app.get("/", (req, res) => {
  res.send("Cleanify Reporting Agent funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "cleanify-reporting-agent",
    version: "1.2.0",
    mcp: {
      enabled: true,
      endpoint: `${BASE_URL}/mcp`
    }
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
      source: "google_assets",
      error: "No se pudieron listar los activos de Google.",
      details: error.message
    });
  }
});

app.get("/google/resolve-assets", async (req, res) => {
  try {
    const { clientName, domain, location } = req.query;

    const resolution = await resolveClientAssets({
      clientName,
      domain,
      location
    });

    return res.json({
      ok: true,
      source: "google_assets_resolver",
      resolution
    });
  } catch (error) {
    console.error("Error resolviendo activos Google:", error);
    return res.status(500).json({
      ok: false,
      source: "google_assets_resolver",
      error: "No se pudieron resolver los activos del cliente/proyecto.",
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
      source: "search_console",
      data
    });
  } catch (error) {
    console.error("Error consultando Search Console mensual:", error);
    return res.status(500).json({
      ok: false,
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
        error: "Falta client.name en el JSON enviado."
      });
    }

    const enrichedInput = await enrichInputWithSearchConsole(data);
    const report = buildMonthlyReport(enrichedInput);

    return res.json({
      route_version: "api-report-monthly-enriched-2026-05-21",
      enrichment_input_received: {
        has_search_console: Boolean(data.search_console),
        siteUrl: data.search_console?.siteUrl || null,
        startDate: data.search_console?.startDate || null,
        endDate: data.search_console?.endDate || null
      },
      search_console_loaded: report.data_enrichment?.search_console_real_data_loaded ?? false,
      report
    });
  } catch (error) {
    return res.status(500).json({
      route_version: "api-report-monthly-enriched-2026-05-21",
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
      version: "1.2.0",
      description:
        "API para convertir datos mensuales de marketing local en una estructura de informe para clientes de Cleanify."
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
      "/api/report/monthly": {
        post: {
          operationId: "generateMonthlyReport",
          summary: "Generar estructura de informe mensual para un cliente.",
          description:
            "Recibe datos de GA4, Search Console, Google Business Profile, llamadas, formularios, CRM y tareas realizadas. Si Search Console incluye siteUrl, startDate y endDate, intenta cargar datos reales desde Google Search Console.",
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
                    ga4: { type: "object" },
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
});
