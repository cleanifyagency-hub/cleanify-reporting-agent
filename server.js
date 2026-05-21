import {
  getGoogleAuthUrl,
  exchangeGoogleCodeForTokens
} from "./google-auth.js";
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
  const gbpCalls = compare(gbp.calls, gbp.previous_calls);
  const totalLeads = compare(crm.total_leads, crm.previous_total_leads);

  if (scClicks.trend === "sube") {
    signals.push("Aumentan los clics orgánicos desde Google Search Console.");
  }

  if (scImpressions.trend === "sube") {
    signals.push("Aumentan las impresiones, señal de mayor visibilidad en búsquedas.");
  }

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
    signals.push("Todavía no hay señales cuantitativas fuertes; el foco está en consolidar base técnica, medición y próximas acciones.");
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
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
        clicks: scClicks,
        impressions: scImpressions,
        ctr: compare(searchConsole.ctr, searchConsole.previous_ctr),
        average_position: compare(searchConsole.average_position, searchConsole.previous_average_position)
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
      que_necesita_tiempo: [
        "La consolidación de rankings locales y la conversión estable de leads necesitan más histórico.",
        "Algunas mejoras pueden verse primero en impresiones, visibilidad o interacción antes de convertirse en llamadas o presupuestos.",
        "Conviene evitar conclusiones fuertes si el volumen de datos todavía es bajo."
      ],
      proximo_mes: nextActions.length
        ? nextActions
        : ["Revisar datos del mes, priorizar oportunidades y continuar optimizando las páginas y canales con mayor potencial."],
      necesitamos_del_cliente: clientNeeds.length
        ? clientNeeds
        : ["Feedback sobre la calidad de los leads recibidos.", "Confirmación de servicios y zonas prioritarias."]
    },
    internal_summary_for_cleanify: {
      lectura_real_del_mes: "Revisar si las señales positivas se corresponden con leads reales y oportunidades comerciales.",
      riesgos_o_bloqueos: [
        "Datos incompletos o sin comparativa pueden limitar la lectura.",
        "Si hay llamadas perdidas o formularios poco cualificados, conviene revisarlo antes de prometer crecimiento."
      ],
      que_vigilar: [
        "Calidad de leads.",
        "Llamadas perdidas.",
        "Páginas con muchas impresiones y pocos clics.",
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
    version: "1.1.0"
  });

  server.registerTool(
    "generateMonthlyReport",
    {
      title: "Generar informe mensual de cliente",
      description: "Convierte datos mensuales de GA4, Search Console, Google Business Profile, llamadas, formularios, CRM y tareas realizadas en una estructura de informe mensual clara para clientes de Cleanify.",
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
      const report = buildMonthlyReport(input);

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

  return server;
}

app.get("/", (req, res) => {
  res.send("Cleanify Reporting Agent funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "cleanify-reporting-agent",
    version: "1.1.0",
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

app.post("/api/report/monthly", (req, res) => {
  try {
    const data = req.body || {};

    if (!data.client || !data.client.name) {
      return res.status(400).json({
        ok: false,
        error: "Falta client.name en el JSON enviado."
      });
    }

    const report = buildMonthlyReport(data);
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
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
      version: "1.1.0",
      description: "API para convertir datos mensuales de marketing local en una estructura de informe para clientes de Cleanify."
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
          description: "Recibe datos de GA4, Search Console, Google Business Profile, llamadas, formularios, CRM y tareas realizadas. Devuelve secciones listas para que el agente redacte un informe mensual claro para cliente y un resumen interno para Cleanify.",
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
                    search_console: { type: "object" },
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
