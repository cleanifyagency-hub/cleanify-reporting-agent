import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const BRAND = {
  primary: "#000026",
  accent: "#5271ff",
  text: "#000026",
  muted: "#596174",
  line: "#d9ddec",
  pale: "#f4f6ff",
  success: "#0f8f55",
  warning: "#9a6b00",
  danger: "#b91c1c",
  white: "#ffffff"
};

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABEL = { critical: "CRÍTICA", high: "ALTA", medium: "MEDIA", low: "BAJA" };

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasValue(value) {
  return safeNumber(value) !== null;
}

function compare(current, previous, inverse = false) {
  const currentNumber = safeNumber(current);
  const previousNumber = safeNumber(previous);
  let percentChange = null;
  if (currentNumber !== null && previousNumber !== null) {
    if (previousNumber === 0) percentChange = currentNumber === 0 ? 0 : null;
    else percentChange = Number((((currentNumber - previousNumber) / Math.abs(previousNumber)) * 100).toFixed(1));
  }
  let trend = "sin_comparativa";
  if (currentNumber !== null && previousNumber !== null) {
    if (currentNumber === previousNumber) trend = "estable";
    else if (inverse) trend = currentNumber < previousNumber ? "mejora" : "empeora";
    else trend = currentNumber > previousNumber ? "mejora" : "empeora";
  }
  return { current: currentNumber, previous: previousNumber, percent_change: percentChange, trend };
}

function nonEmptyArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : [];
}

function sourceLoaded(source, keys = []) {
  if (!source || source.real_data_loaded === false) return false;
  if (source.real_data_loaded === true) return true;
  return keys.some((key) => hasValue(source[key]));
}

function formatNumber(value, digits = 0) {
  const number = safeNumber(value);
  if (number === null) return null;
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(number);
}

function formatPercent(value, digits = 1) {
  const number = safeNumber(value);
  if (number === null) return null;
  return `${formatNumber(number * 100, digits)}%`;
}

function metricLine(label, metric, { percent = false, inverse = false } = {}) {
  if (!metric || metric.current === null) return null;
  const display = percent ? formatPercent(metric.current) : formatNumber(metric.current, Number.isInteger(metric.current) ? 0 : 2);
  if (metric.previous === null) return `${label}: ${display}.`;
  const previous = percent ? formatPercent(metric.previous) : formatNumber(metric.previous, Number.isInteger(metric.previous) ? 0 : 2);
  let change = "sin variación";
  if (metric.percent_change !== null && metric.percent_change !== 0) {
    const direction = metric.percent_change > 0 ? "sube" : "baja";
    change = `${direction} ${formatNumber(Math.abs(metric.percent_change), 1)}%`;
  }
  if (inverse && metric.current !== metric.previous) {
    change += metric.current < metric.previous ? " (mejora)" : " (retroceso)";
  }
  return `${label}: ${display} frente a ${previous}; ${change}.`;
}

function channelName(row = {}) {
  return String(row.sessionDefaultChannelGroup || row.channel || row.name || "").trim();
}

function channelSessions(row = {}) {
  return safeNumber(row.sessions) || 0;
}

function normalize(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildOpportunityRows(searchConsole = {}) {
  return nonEmptyArray(searchConsole.top_queries)
    .filter((query) => {
      const impressions = safeNumber(query.impressions) || 0;
      const ctr = safeNumber(query.ctr);
      const position = safeNumber(query.position);
      return impressions >= 20 && ((ctr !== null && ctr < 0.03) || (position !== null && position >= 5 && position <= 15));
    })
    .slice(0, 8)
    .map((query) => ({
      query: query.query,
      clicks: safeNumber(query.clicks) || 0,
      impressions: safeNumber(query.impressions) || 0,
      ctr: safeNumber(query.ctr),
      position: safeNumber(query.position),
      suggested_action: "Revisar intención, title, metadescription, contenido de destino y enlazado interno."
    }));
}

function issue({ priority, title, evidence, impact, diagnosis, confidence = "media", actions, validation, category = "performance" }) {
  return {
    priority,
    priority_order: PRIORITY_ORDER[priority],
    category,
    title,
    evidence: nonEmptyArray(evidence),
    impact,
    diagnosis,
    confidence,
    recommended_actions: nonEmptyArray(actions),
    validation
  };
}

function buildIssues({ client, ga4, searchConsole, ga4Loaded, scLoaded, data }) {
  const issues = [];
  const engagement = compare(ga4.engagement_rate, ga4.previous_engagement_rate);
  const conversions = compare(ga4.conversions, ga4.previous_conversions);
  const impressions = compare(searchConsole.impressions, searchConsole.previous_impressions);
  const ctr = compare(searchConsole.ctr, searchConsole.previous_ctr);
  const sessions = safeNumber(ga4.sessions) || 0;
  const channels = nonEmptyArray(ga4.top_channels);
  const totalChannelSessions = channels.reduce((sum, row) => sum + channelSessions(row), 0) || sessions;
  const directSessions = channels
    .filter((row) => normalize(channelName(row)).includes("direct"))
    .reduce((sum, row) => sum + channelSessions(row), 0);
  const directShare = totalChannelSessions > 0 ? directSessions / totalChannelSessions : null;

  if (!ga4Loaded) {
    issues.push(issue({
      priority: "high",
      category: "data",
      title: "GA4 no aporta datos utilizables",
      evidence: [ga4.error || "No hay una lectura real de tráfico y comportamiento para el periodo."],
      impact: "No se puede evaluar con rigor la calidad del tráfico, la interacción ni los eventos de contacto.",
      diagnosis: ga4.propertyId ? "Posible problema de permisos, propiedad, fechas o respuesta de la API." : "La propiedad GA4 no se ha resuelto automáticamente.",
      confidence: "alta",
      actions: ["Verificar la propiedad resuelta y los permisos del usuario OAuth.", "Ejecutar una consulta de prueba sobre el mismo periodo."],
      validation: "GA4 devuelve resumen mensual, canales y eventos sin error."
    }));
  }

  if (!scLoaded) {
    issues.push(issue({
      priority: "high",
      category: "data",
      title: "Search Console no aporta datos utilizables",
      evidence: [searchConsole.error || "No hay una lectura real de clics, impresiones, CTR y consultas."],
      impact: "La evolución orgánica y las oportunidades SEO no pueden diagnosticarse con datos del periodo.",
      diagnosis: searchConsole.siteUrl ? "Probable problema de permisos, propiedad o fechas." : "La propiedad de Search Console no se ha resuelto automáticamente.",
      confidence: "alta",
      actions: ["Confirmar que la cuenta OAuth tiene permiso completo o de propietario.", "Verificar que la URL de propiedad coincide exactamente con el activo descubierto."],
      validation: "Search Console devuelve resumen y consultas del periodo."
    }));
  }

  if (directShare !== null && directShare >= 0.7 && sessions >= 20) {
    issues.push(issue({
      priority: "high",
      title: "Dependencia anómala del canal Direct",
      evidence: [`Direct concentra ${formatPercent(directShare)} de las sesiones (${formatNumber(directSessions)} de ${formatNumber(totalChannelSessions)}).`],
      impact: "La atribución de adquisición puede estar degradada y ocultar el origen real de tráfico y conversiones.",
      diagnosis: "Puede existir etiquetado UTM incompleto, pérdida de referrer, redirecciones o configuración deficiente entre dominios.",
      confidence: "media",
      actions: ["Auditar UTMs y enlaces de campañas.", "Revisar cross-domain, redirecciones y exclusiones de referencia.", "Comparar landing pages y eventos del canal Direct."],
      validation: "El peso de Direct desciende y el tráfico se redistribuye hacia canales identificables sin pérdida artificial de sesiones."
    }));
  }

  if (engagement.percent_change !== null && engagement.percent_change <= -30) {
    issues.push(issue({
      priority: "high",
      title: "Caída acusada de la tasa de interacción",
      evidence: [metricLine("Tasa de interacción", engagement, { percent: true })],
      impact: "El tráfico muestra menor calidad o encuentra más fricción para avanzar en la web.",
      diagnosis: "Debe segmentarse por canal, dispositivo y landing page antes de atribuir la caída a una causa concreta.",
      confidence: "alta",
      actions: ["Comparar engagement por canal y landing page.", "Revisar cambios técnicos, velocidad, consentimiento y experiencia móvil.", "Contrastar el descenso con eventos de contacto."],
      validation: "La tasa recupera estabilidad y se identifica el segmento responsable de la variación."
    }));
  }

  if (conversions.percent_change !== null && conversions.percent_change <= -20) {
    const lowBase = (conversions.previous || 0) < 10;
    issues.push(issue({
      priority: lowBase ? "medium" : "high",
      title: "Descenso de eventos de contacto detectados",
      evidence: [metricLine("Eventos de contacto", conversions), lowBase ? "La base comparativa es baja; la variación porcentual puede sobredimensionar el cambio." : null],
      impact: "Puede indicar menor captación real o un problema de medición de conversiones.",
      diagnosis: "Primero hay que separar caída comercial de pérdida de tracking.",
      confidence: lowBase ? "media" : "alta",
      actions: ["Validar eventos de formulario, teléfono, WhatsApp y email.", "Revisar volumen por landing y canal.", "Contrastar con CRM o registros manuales."],
      validation: "Los eventos se disparan correctamente y coinciden razonablemente con los contactos registrados."
    }));
  }

  if (impressions.percent_change !== null && impressions.percent_change > 10 && ctr.percent_change !== null && ctr.percent_change < -10) {
    issues.push(issue({
      priority: "medium",
      title: "Más visibilidad, pero menor capacidad de generar clics",
      evidence: [metricLine("Impresiones", impressions), metricLine("CTR", ctr, { percent: true })],
      impact: "El crecimiento de apariciones no se está convirtiendo proporcionalmente en visitas orgánicas.",
      diagnosis: "Puede haber expansión hacia consultas menos relevantes, snippets poco competitivos o posiciones todavía insuficientes.",
      confidence: "alta",
      actions: ["Separar consultas con crecimiento de impresiones y pérdida de CTR.", "Optimizar titles y metadescriptions de las URLs implicadas.", "Alinear contenido e intención de búsqueda."],
      validation: "El CTR se recupera en las consultas priorizadas sin perder impresiones relevantes."
    }));
  }

  if (scLoaded) {
    const brandTokens = [...new Set([
      ...normalize(client.name).split(" "),
      normalize(String(client.domain || "").split(".")[0])
    ].filter((token) => token.length >= 4))];
    const queries = nonEmptyArray(searchConsole.top_queries);
    const totalClicks = safeNumber(searchConsole.clicks) || 0;
    const brandClicks = queries
      .filter((row) => brandTokens.some((token) => normalize(row.query).includes(token)))
      .reduce((sum, row) => sum + (safeNumber(row.clicks) || 0), 0);
    const brandShare = totalClicks > 0 ? brandClicks / totalClicks : null;
    if (brandShare !== null && brandShare >= 0.7 && totalClicks >= 10) {
      issues.push(issue({
        priority: "medium",
        title: "Alta dependencia de búsquedas de marca",
        evidence: [`Las consultas identificadas como marca aportan al menos ${formatPercent(brandShare)} de los clics totales del periodo.`],
        impact: "La captación orgánica depende en gran medida de usuarios que ya conocen la empresa.",
        diagnosis: "La muestra procede de las consultas principales y debe confirmarse con una extracción más amplia.",
        confidence: "media",
        actions: ["Ampliar el análisis de consultas no de marca.", "Crear o reforzar páginas de servicio y zona con intención transaccional.", "Medir separadamente marca y no marca."],
        validation: "Crece la cuota de clics no de marca y aparecen nuevas consultas transaccionales relevantes."
      }));
    }
  }

  const opportunities = buildOpportunityRows(searchConsole);
  if (opportunities.length) {
    issues.push(issue({
      priority: "medium",
      title: "Consultas con margen inmediato de optimización",
      evidence: opportunities.slice(0, 5).map((row) => `${row.query}: ${formatNumber(row.impressions)} impresiones, CTR ${formatPercent(row.ctr) || "sin dato"}, posición ${formatNumber(row.position, 1) || "sin dato"}.`),
      impact: "Existe visibilidad que todavía no genera el volumen de clics esperable.",
      diagnosis: "Las consultas combinan impresiones suficientes con CTR bajo o posiciones cercanas a primera página.",
      confidence: "alta",
      actions: ["Priorizar las URLs asociadas.", "Mejorar snippet, cobertura de intención y enlazado interno.", "Revisar cambios a 28 días."],
      validation: "Mejoran CTR, clics o posición de las consultas trabajadas."
    }));
  }

  const dataGaps = [
    !data.google_business_profile ? "Google Business Profile" : null,
    !data.calls ? "llamadas" : null,
    !data.forms ? "formularios" : null,
    !data.crm ? "CRM" : null,
    nonEmptyArray(data.tasks_done).length === 0 ? "registro de acciones realizadas" : null
  ].filter(Boolean);
  if (dataGaps.length) {
    issues.push(issue({
      priority: "low",
      category: "data",
      title: "Huecos de contexto operativo y comercial",
      evidence: [`No se aportaron: ${dataGaps.join(", ")}.`],
      impact: "La lectura no puede conectar completamente rendimiento, trabajo ejecutado y resultado comercial.",
      diagnosis: "Es una carencia del paquete de datos, no necesariamente un problema de rendimiento del cliente.",
      confidence: "alta",
      actions: ["Incorporar únicamente las fuentes y registros que existan.", "No completar ni presentar al cliente secciones sin evidencia."],
      validation: "El siguiente informe incluye los bloques disponibles y omite de forma limpia los ausentes."
    }));
  }

  return issues.sort((a, b) => a.priority_order - b.priority_order);
}

function buildPositiveSignals({ ga4, searchConsole, ga4Loaded, scLoaded }) {
  const signals = [];
  const users = compare(ga4.users, ga4.previous_users);
  const sessions = compare(ga4.sessions, ga4.previous_sessions);
  const conversions = compare(ga4.conversions, ga4.previous_conversions);
  const clicks = compare(searchConsole.clicks, searchConsole.previous_clicks);
  const impressions = compare(searchConsole.impressions, searchConsole.previous_impressions);
  const position = compare(searchConsole.average_position, searchConsole.previous_average_position, true);
  if (ga4Loaded && users.trend === "mejora") signals.push(users.percent_change === null ? `Los usuarios activos aumentan hasta ${formatNumber(users.current)}.` : `Los usuarios activos crecen ${formatNumber(users.percent_change, 1)}% frente al periodo anterior.`);
  if (ga4Loaded && sessions.trend === "mejora") signals.push(sessions.percent_change === null ? `Las sesiones aumentan hasta ${formatNumber(sessions.current)}.` : `Las sesiones crecen ${formatNumber(sessions.percent_change, 1)}% frente al periodo anterior.`);
  if (ga4Loaded && conversions.trend === "mejora") signals.push(conversions.percent_change === null ? `Los eventos de contacto detectados aumentan hasta ${formatNumber(conversions.current)}.` : `Los eventos de contacto detectados suben ${formatNumber(conversions.percent_change, 1)}%.`);
  if (scLoaded && clicks.trend === "mejora") signals.push(clicks.percent_change === null ? `Los clics orgánicos aumentan hasta ${formatNumber(clicks.current)}.` : `Los clics orgánicos aumentan ${formatNumber(clicks.percent_change, 1)}%.`);
  if (scLoaded && impressions.trend === "mejora") signals.push(impressions.percent_change === null ? `Las impresiones orgánicas aumentan hasta ${formatNumber(impressions.current)}.` : `La visibilidad orgánica crece ${formatNumber(impressions.percent_change, 1)}% en impresiones.`);
  if (scLoaded && position.trend === "mejora") signals.push(`La posición media mejora de ${formatNumber(position.previous, 1)} a ${formatNumber(position.current, 1)}.`);
  return signals;
}

function buildClientRecommendations(issues, opportunities) {
  const actions = [];
  for (const currentIssue of issues.filter((item) => item.category !== "data" && item.priority !== "low").slice(0, 3)) {
    actions.push(clientActionForIssue(currentIssue));
  }
  if (!actions.length && opportunities.length) actions.push("Priorizar las consultas y páginas con visibilidad suficiente y margen de mejora en clics.");
  return [...new Set(actions)].slice(0, 4);
}

function clientActionForIssue(currentIssue) {
  const title = currentIssue.title || "";
  if (/Direct/i.test(title)) return "Revisar la medición de campañas y enlaces para identificar mejor el origen del tráfico.";
  if (/interacción/i.test(title)) return "Analizar por canal y página dónde podemos mejorar la interacción.";
  if (/eventos de contacto/i.test(title)) return "Comprobar que formularios, llamadas y otros contactos se estén registrando correctamente.";
  if (/visibilidad/i.test(title)) return "Optimizar los resultados que ya ganan visibilidad para convertir más impresiones en clics.";
  if (/marca/i.test(title)) return "Reforzar páginas de servicios y zonas para ampliar la captación de búsquedas sin marca.";
  if (/consultas/i.test(title)) return "Priorizar las consultas con visibilidad y margen de crecimiento en clics.";
  return currentIssue.recommended_actions[0] || "Seguir su evolución y ajustar el trabajo con datos confirmados.";
}

function clientFriendlyIssueText(currentIssue) {
  const title = currentIssue.title || "";
  let calmTitle = title;
  if (/Direct/i.test(title)) calmTitle = "Mejorar la identificación del origen del tráfico";
  else if (/interacción/i.test(title)) calmTitle = "Reforzar la calidad de la interacción en la web";
  else if (/eventos de contacto/i.test(title)) calmTitle = "Revisar la medición y evolución de los contactos";
  else if (/visibilidad/i.test(title)) calmTitle = "Aprovechar mejor el crecimiento de visibilidad";
  else if (/marca/i.test(title)) calmTitle = "Ampliar la captación de búsquedas no vinculadas a la marca";
  else if (/consultas/i.test(title)) calmTitle = "Convertir mejor las consultas que ya muestran potencial";
  return `${calmTitle}. ${clientActionForIssue(currentIssue)}`;
}

function buildCalmSummary({ client, period, positiveSignals, issues, ga4Loaded, scLoaded }) {
  const name = client.name || "el proyecto";
  const month = period.month || "este mes";
  if (positiveSignals.length && !issues.some((item) => ["critical", "high"].includes(item.priority) && item.category !== "data")) {
    return `Durante ${month}, ${name} muestra señales favorables en los datos disponibles. El siguiente foco será consolidarlas y convertir la visibilidad y el tráfico en oportunidades de contacto más consistentes.`;
  }
  if (ga4Loaded || scLoaded) {
    return `Durante ${month}, los datos disponibles permiten identificar avances y áreas concretas de mejora para ${name}. La lectura es accionable: el próximo trabajo se concentrará en reforzar lo que funciona y corregir los puntos con mayor potencial.`;
  }
  return `Durante ${month}, el seguimiento de ${name} se centra en mantener el trabajo ordenado y preparar una lectura más completa en cuanto estén disponibles nuevas mediciones. Las decisiones se tomarán únicamente con información confirmada.`;
}

export function buildMonthlyReport(data = {}) {
  const client = data.client || {};
  const period = data.period || {};
  const ga4 = data.ga4 || {};
  const searchConsole = data.search_console || {};
  const gbp = data.google_business_profile || {};
  const calls = data.calls || {};
  const forms = data.forms || {};
  const crm = data.crm || {};
  const tasks = nonEmptyArray(data.tasks_done);
  const confirmedActions = nonEmptyArray(data.next_month_actions);
  const clientNeeds = nonEmptyArray(data.client_needs);
  const ga4Loaded = sourceLoaded(ga4, ["users", "sessions", "conversions", "engagement_rate"]);
  const scLoaded = sourceLoaded(searchConsole, ["clicks", "impressions", "ctr", "average_position"]);
  const opportunities = scLoaded ? buildOpportunityRows(searchConsole) : [];
  const issues = buildIssues({ client, ga4, searchConsole, ga4Loaded, scLoaded, data });
  const positiveSignals = buildPositiveSignals({ ga4, searchConsole, ga4Loaded, scLoaded });
  const recommendedActions = confirmedActions.length ? [] : buildClientRecommendations(issues, opportunities);

  const metrics = {
    ...(ga4Loaded ? {
      ga4: {
        real_data_loaded: true,
        propertyId: ga4.propertyId || null,
        propertyName: ga4.propertyName || null,
        users: compare(ga4.users, ga4.previous_users),
        sessions: compare(ga4.sessions, ga4.previous_sessions),
        engaged_sessions: compare(ga4.engaged_sessions, ga4.previous_engaged_sessions),
        page_views: compare(ga4.page_views, ga4.previous_page_views),
        event_count: compare(ga4.event_count, ga4.previous_event_count),
        conversions: compare(ga4.conversions, ga4.previous_conversions),
        engagement_rate: compare(ga4.engagement_rate, ga4.previous_engagement_rate),
        top_channels: nonEmptyArray(ga4.top_channels),
        top_pages: nonEmptyArray(ga4.top_pages),
        top_events: nonEmptyArray(ga4.top_events),
        lead_events: nonEmptyArray(ga4.lead_events)
      }
    } : {}),
    ...(scLoaded ? {
      search_console: {
        real_data_loaded: true,
        siteUrl: searchConsole.siteUrl || null,
        clicks: compare(searchConsole.clicks, searchConsole.previous_clicks),
        impressions: compare(searchConsole.impressions, searchConsole.previous_impressions),
        ctr: compare(searchConsole.ctr, searchConsole.previous_ctr),
        average_position: compare(searchConsole.average_position, searchConsole.previous_average_position, true),
        top_queries: nonEmptyArray(searchConsole.top_queries),
        previous_top_queries: nonEmptyArray(searchConsole.previous_top_queries),
        opportunities
      }
    } : {}),
    ...(data.google_business_profile ? {
      google_business_profile: {
        calls: compare(gbp.calls, gbp.previous_calls),
        website_clicks: compare(gbp.website_clicks, gbp.previous_website_clicks),
        reviews: compare(gbp.reviews, gbp.previous_reviews)
      }
    } : {}),
    ...((data.calls || data.forms || data.crm) ? {
      commercial: {
        ...(data.calls ? { calls_total: compare(calls.total, calls.previous_total), calls_qualified: compare(calls.qualified, calls.previous_qualified) } : {}),
        ...(data.forms ? { forms_total: compare(forms.total, forms.previous_total), forms_qualified: compare(forms.qualified, forms.previous_qualified) } : {}),
        ...(data.crm ? { leads_total: compare(crm.total_leads, crm.previous_total_leads), quotes_sent: compare(crm.quotes_sent, crm.previous_quotes_sent), sales_closed: compare(crm.sales_closed, crm.previous_sales_closed) } : {})
      }
    } : {})
  };

  const clientSections = {
    resumen_del_mes: buildCalmSummary({ client, period, positiveSignals, issues, ga4Loaded, scLoaded }),
    ...(tasks.length ? { que_se_ha_hecho: tasks } : {}),
    ...(ga4Loaded ? {
      lectura_ga4: [
        metricLine("Usuarios activos", metrics.ga4.users),
        metricLine("Sesiones", metrics.ga4.sessions),
        metricLine("Eventos de contacto detectados", metrics.ga4.conversions),
        metricLine("Tasa de interacción", metrics.ga4.engagement_rate, { percent: true })
      ].filter(Boolean)
    } : {}),
    ...(scLoaded ? {
      lectura_search_console: [
        metricLine("Clics orgánicos", metrics.search_console.clicks),
        metricLine("Impresiones", metrics.search_console.impressions),
        metricLine("CTR", metrics.search_console.ctr, { percent: true }),
        metricLine("Posición media", metrics.search_console.average_position, { inverse: true })
      ].filter(Boolean),
      ...(metrics.search_console.top_queries.length ? { consultas_principales: metrics.search_console.top_queries.slice(0, 10) } : {}),
      ...(opportunities.length ? { oportunidades_search_console: opportunities } : {})
    } : {}),
    ...(positiveSignals.length ? { senales_positivas: positiveSignals } : {}),
    ...(issues.some((item) => item.category !== "data" && ["high", "medium"].includes(item.priority)) ? {
      puntos_a_trabajar: issues
        .filter((item) => item.category !== "data" && ["high", "medium"].includes(item.priority))
        .slice(0, 4)
        .map(clientFriendlyIssueText)
    } : {}),
    ...(confirmedActions.length ? { proximo_mes: confirmedActions } : {}),
    ...(recommendedActions.length ? { proximo_mes_recomendado: recommendedActions } : {}),
    ...(clientNeeds.length ? { necesitamos_del_cliente: clientNeeds } : {})
  };

  return {
    ok: true,
    report_version: "2.0",
    generated_at: new Date().toISOString(),
    data_enrichment: {
      ga4_real_data_loaded: ga4Loaded,
      ga4_propertyId: ga4.propertyId || null,
      search_console_real_data_loaded: scLoaded,
      search_console_siteUrl: searchConsole.siteUrl || null,
      internal_data_gaps: issues.filter((item) => item.category === "data").map((item) => item.title)
    },
    client: {
      name: client.name || "Cliente sin nombre",
      sector: client.sector || null,
      location: client.location || null,
      domain: client.domain || null,
      priority_services: client.priority_services || [],
      status: client.status || client.estado || null
    },
    period: { month: period.month || null, previous_month: period.previous_month || null },
    metrics_summary: metrics,
    client_report_sections: clientSections,
    internal_summary_for_cleanify: {
      executive_diagnosis: issues.length
        ? `${issues.filter((item) => ["critical", "high"].includes(item.priority)).length} incidencias de prioridad alta o crítica y ${issues.filter((item) => item.priority === "medium").length} de prioridad media. La actuación debe seguir el orden indicado.`
        : "No se detectan incidencias relevantes con los datos disponibles.",
      source_status: {
        ga4: { loaded: ga4Loaded, propertyId: ga4.propertyId || null, error: ga4.error || null },
        search_console: { loaded: scLoaded, siteUrl: searchConsole.siteUrl || null, error: searchConsole.error || null },
        google_business_profile: { loaded: Boolean(data.google_business_profile) },
        calls: { loaded: Boolean(data.calls) },
        forms: { loaded: Boolean(data.forms) },
        crm: { loaded: Boolean(data.crm) },
        tasks_done: { loaded: tasks.length > 0, count: tasks.length }
      },
      issues,
      raw_metrics: metrics,
      confirmed_actions: confirmedActions,
      generated_recommendations: recommendedActions,
      client_needs: clientNeeds,
      account_manager_guidance: "Comunicar los datos con serenidad y precisión. Separar resultados observados, acciones realmente ejecutadas y recomendaciones futuras.",
      do_not_promise: "No prometer posiciones, volumen de leads ni plazos de recuperación sin evidencia suficiente."
    }
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function markdownList(items) {
  return nonEmptyArray(items).map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

function htmlList(items) {
  const rows = nonEmptyArray(items);
  return rows.length ? `<ul>${rows.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>` : "";
}

function pushMarkdown(parts, title, content) {
  const body = Array.isArray(content) ? markdownList(content) : String(content || "").trim();
  if (!body) return;
  parts.push(`## ${title}\n\n${body}`);
}

function pushHtml(parts, title, content) {
  if (Array.isArray(content) && !content.length) return;
  if (!Array.isArray(content) && !String(content || "").trim()) return;
  parts.push(`<section><h2>${escapeHtml(title)}</h2>${Array.isArray(content) ? htmlList(content) : `<p>${escapeHtml(content)}</p>`}</section>`);
}

export function buildFinalReportOutputs(report = {}) {
  const client = report.client || {};
  const period = report.period || {};
  const sections = report.client_report_sections || {};
  const internal = report.internal_summary_for_cleanify || {};
  const clientName = client.name || "Cliente";
  const month = period.month || "este mes";

  const markdown = [`# Informe mensual · ${clientName}\n\nPeriodo: ${month}`];
  pushMarkdown(markdown, "Resumen del mes", sections.resumen_del_mes);
  pushMarkdown(markdown, "Trabajo realizado", sections.que_se_ha_hecho);
  if (sections.lectura_ga4 || sections.lectura_search_console) {
    const resultParts = [];
    if (sections.lectura_ga4) resultParts.push(`### Tráfico y comportamiento web\n\n${markdownList(sections.lectura_ga4)}`);
    if (sections.lectura_search_console) resultParts.push(`### Visibilidad orgánica\n\n${markdownList(sections.lectura_search_console)}`);
    pushMarkdown(markdown, "Resultados del mes", resultParts.join("\n\n"));
  }
  pushMarkdown(markdown, "Señales favorables", sections.senales_positivas);
  pushMarkdown(markdown, "Puntos a reforzar", sections.puntos_a_trabajar);
  pushMarkdown(markdown, "Qué haremos el próximo mes", sections.proximo_mes);
  pushMarkdown(markdown, "Próximos pasos recomendados", sections.proximo_mes_recomendado);
  pushMarkdown(markdown, "Qué necesitamos de vosotros", sections.necesitamos_del_cliente);
  pushMarkdown(markdown, "Cierre", "Seguiremos revisando la evolución y ajustando las prioridades con datos confirmados, para que cada acción contribuya a una captación más sólida.");

  const htmlSections = [];
  pushHtml(htmlSections, "Resumen del mes", sections.resumen_del_mes);
  pushHtml(htmlSections, "Trabajo realizado", sections.que_se_ha_hecho);
  if (sections.lectura_ga4 || sections.lectura_search_console) {
    const blocks = [];
    if (sections.lectura_ga4) blocks.push(`<h3>Tráfico y comportamiento web</h3>${htmlList(sections.lectura_ga4)}`);
    if (sections.lectura_search_console) blocks.push(`<h3>Visibilidad orgánica</h3>${htmlList(sections.lectura_search_console)}`);
    htmlSections.push(`<section><h2>Resultados del mes</h2>${blocks.join("")}</section>`);
  }
  pushHtml(htmlSections, "Señales favorables", sections.senales_positivas);
  pushHtml(htmlSections, "Puntos a reforzar", sections.puntos_a_trabajar);
  pushHtml(htmlSections, "Qué haremos el próximo mes", sections.proximo_mes);
  pushHtml(htmlSections, "Próximos pasos recomendados", sections.proximo_mes_recomendado);
  pushHtml(htmlSections, "Qué necesitamos de vosotros", sections.necesitamos_del_cliente);
  pushHtml(htmlSections, "Cierre", "Seguiremos revisando la evolución y ajustando las prioridades con datos confirmados, para que cada acción contribuya a una captación más sólida.");

  const internalMarkdown = [`# Informe interno Cleanify · ${clientName}\n\nPeriodo: ${month}`];
  pushMarkdown(internalMarkdown, "Diagnóstico ejecutivo", internal.executive_diagnosis);
  for (const currentIssue of nonEmptyArray(internal.issues)) {
    internalMarkdown.push(`## [${PRIORITY_LABEL[currentIssue.priority] || currentIssue.priority}] ${currentIssue.title}\n\n**Evidencia**\n\n${markdownList(currentIssue.evidence)}\n\n**Impacto**\n\n${currentIssue.impact}\n\n**Diagnóstico**\n\n${currentIssue.diagnosis} (confianza: ${currentIssue.confidence})\n\n**Acciones recomendadas**\n\n${markdownList(currentIssue.recommended_actions)}\n\n**Validación**\n\n${currentIssue.validation}`);
  }
  pushMarkdown(internalMarkdown, "Acciones confirmadas", internal.confirmed_actions);
  pushMarkdown(internalMarkdown, "Recomendaciones generadas", internal.generated_recommendations);
  pushMarkdown(internalMarkdown, "Guía para account manager", internal.account_manager_guidance);
  pushMarkdown(internalMarkdown, "Qué no prometer", internal.do_not_promise);

  const emailSubjects = [
    `Informe mensual de ${clientName} · Evolución y próximos pasos`,
    `${clientName} · Resumen de ${month}`
  ];
  const emailLines = [
    "Hola,",
    "",
    `Te compartimos el informe mensual de ${clientName}, con una lectura clara de los datos disponibles y las prioridades para seguir mejorando.`
  ];
  if (sections.que_se_ha_hecho) emailLines.push("", "También encontrarás las acciones realizadas durante el periodo.");
  if (sections.proximo_mes) emailLines.push("", "El informe distingue los trabajos ya previstos para el próximo mes.");
  else if (sections.proximo_mes_recomendado) emailLines.push("", "Incluimos próximos pasos recomendados a partir de las mediciones observadas.");
  if (sections.necesitamos_del_cliente) emailLines.push("", "Se detallan asimismo los puntos concretos en los que necesitamos vuestra colaboración.");
  emailLines.push("", "Cualquier duda, lo revisamos juntos.", "", "Un saludo,", "El equipo de Cleanify");

  return {
    client_report_markdown: markdown.join("\n\n"),
    client_report_html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe mensual · ${escapeHtml(clientName)}</title><style>body{margin:0;background:#f4f6fb;color:#000026;font-family:Montserrat,Arial,sans-serif;line-height:1.6}.page{max-width:860px;margin:32px auto;background:white;padding:54px 62px;box-shadow:0 12px 36px rgba(0,0,38,.08)}.eyebrow{color:#5271ff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{font-size:38px;margin:4px 0 5px}h2{font-size:22px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid #d9ddec}h3{font-size:16px;margin:20px 0 7px}li{margin:7px 0}.period{color:#596174}.footer{margin-top:38px;padding-top:18px;border-top:1px solid #d9ddec;color:#596174;font-size:13px}@media print{body{background:white}.page{margin:0;box-shadow:none}}</style></head><body><main class="page"><div class="eyebrow">Informe mensual</div><h1>${escapeHtml(clientName)}</h1><div class="period">Periodo: ${escapeHtml(month)}</div>${htmlSections.join("")}<div class="footer">Cleanify · Informe mensual</div></main></body></html>`,
    internal_summary_markdown: internalMarkdown.join("\n\n"),
    email_subjects: emailSubjects,
    email_body: emailLines.join("\n")
  };
}

function assetPath(fileName) {
  return path.join(process.cwd(), "assets", fileName);
}

function registerFonts(doc) {
  const title = process.env.CLEANIFY_TITLE_FONT_PATH || assetPath("Cleanifyok-Regular.ttf");
  const body = process.env.CLEANIFY_BODY_FONT_PATH || assetPath("Montserrat-Regular.ttf");
  if (fs.existsSync(title)) doc.registerFont("CleanifyTitle", title);
  if (fs.existsSync(body)) {
    doc.registerFont("CleanifyBody", body);
    doc.registerFont("CleanifyBodyBold", body);
  }
  return {
    title: fs.existsSync(title) ? "CleanifyTitle" : "Helvetica-Bold",
    body: fs.existsSync(body) ? "CleanifyBody" : "Helvetica",
    bold: fs.existsSync(body) ? "CleanifyBodyBold" : "Helvetica-Bold"
  };
}

function createDocument(title) {
  const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true, info: { Title: title, Author: "Cleanify" } });
  doc.cleanifyFonts = registerFonts(doc);
  doc.cleanifyPageDark = [true];
  return doc;
}

function drawLogo(doc, white = false, x = 56, y = 48, width = 145) {
  const file = process.env[white ? "CLEANIFY_LOGO_WHITE_PATH" : "CLEANIFY_LOGO_PATH"] || assetPath(white ? "cleanify-logo-white.png" : "cleanify-logo.png");
  if (fs.existsSync(file)) doc.image(file, x, y, { fit: [width, 42] });
  else doc.font(doc.cleanifyFonts.title).fontSize(22).fillColor(white ? BRAND.white : BRAND.primary).text("Cleanify", x, y);
}

function addPage(doc, { dark = false, internal = false } = {}) {
  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(dark ? BRAND.primary : BRAND.white);
  doc.rect(0, 0, 9, doc.page.height).fill(BRAND.accent);
  drawLogo(doc, dark, 56, 38, internal ? 122 : 138);
  doc.cleanifyY = 102;
  doc.cleanifyDark = dark;
  doc.cleanifyPageDark[doc.bufferedPageRange().count - 1] = dark;
}

function ensureSpace(doc, height = 80, options = {}) {
  const bottom = doc.page.height - 62;
  if ((doc.cleanifyY || 100) + height > bottom) addPage(doc, options);
}

function heading(doc, text, { size = 25, dark = doc.cleanifyDark, spaceBefore = 0 } = {}) {
  doc.cleanifyY = (doc.cleanifyY || 100) + spaceBefore;
  ensureSpace(doc, size * 2.1 + 20, { dark });
  doc.font(doc.cleanifyFonts.title).fontSize(size).fillColor(dark ? BRAND.white : BRAND.text)
    .text(text, 56, doc.cleanifyY, { width: 490, lineGap: 2 });
  doc.cleanifyY = doc.y + 14;
}

function paragraph(doc, text, { size = 10.2, dark = doc.cleanifyDark, color = null, gap = 12 } = {}) {
  if (!text) return;
  const height = doc.heightOfString(String(text), { width: 482, lineGap: 3 });
  ensureSpace(doc, height + gap, { dark });
  doc.font(doc.cleanifyFonts.body).fontSize(size).fillColor(color || (dark ? BRAND.white : BRAND.text))
    .text(String(text), 56, doc.cleanifyY, { width: 482, lineGap: 3 });
  doc.cleanifyY = doc.y + gap;
}

function bullets(doc, items, { dark = doc.cleanifyDark, size = 9.7, gap = 9 } = {}) {
  for (const item of nonEmptyArray(items)) {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    const height = doc.heightOfString(text, { width: 454, lineGap: 3 });
    ensureSpace(doc, height + gap + 5, { dark });
    doc.circle(63, doc.cleanifyY + 5, 2.2).fill(BRAND.accent);
    doc.font(doc.cleanifyFonts.body).fontSize(size).fillColor(dark ? BRAND.white : BRAND.text)
      .text(text, 76, doc.cleanifyY, { width: 462, lineGap: 3 });
    doc.cleanifyY = doc.y + gap;
  }
}

function section(doc, title, items, options = {}) {
  const rows = Array.isArray(items) ? nonEmptyArray(items) : items ? [items] : [];
  if (!rows.length) return;
  heading(doc, title, { size: options.headingSize || options.size || 21, spaceBefore: options.spaceBefore ?? 15, dark: options.dark });
  bullets(doc, rows, { ...options, size: options.bulletSize || 9.7 });
}

function addPageNumbers(doc, { internal = false } = {}) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    if (index === 0) continue;
    const page = index + 1;
    const dark = Boolean(doc.cleanifyPageDark[index]);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(doc.cleanifyFonts.body).fontSize(7.5).fillColor(dark ? BRAND.white : BRAND.muted)
      .text(`${internal ? "Uso interno · " : ""}Cleanify · ${page}/${range.count}`, 56, doc.page.height - 35, { width: doc.page.width - 112, align: "right", lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

function finalizeDocument(doc, options = {}) {
  addPageNumbers(doc, options);
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

function metricRows(report) {
  const rows = [];
  const ga4 = report.metrics_summary?.ga4;
  const sc = report.metrics_summary?.search_console;
  if (ga4) {
    rows.push(metricLine("Usuarios activos", ga4.users));
    rows.push(metricLine("Sesiones", ga4.sessions));
    rows.push(metricLine("Eventos de contacto detectados", ga4.conversions));
    rows.push(metricLine("Tasa de interacción", ga4.engagement_rate, { percent: true }));
  }
  if (sc) {
    rows.push(metricLine("Clics orgánicos", sc.clicks));
    rows.push(metricLine("Impresiones", sc.impressions));
    rows.push(metricLine("CTR", sc.ctr, { percent: true }));
    rows.push(metricLine("Posición media", sc.average_position, { inverse: true }));
  }
  return rows.filter(Boolean);
}

export async function buildClientPdfBuffer(report) {
  const client = report.client || {};
  const period = report.period || {};
  const sections = report.client_report_sections || {};
  const doc = createDocument(`Informe mensual · ${client.name || "Cliente"}`);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(BRAND.primary);
  doc.rect(0, 0, 11, doc.page.height).fill(BRAND.accent);
  doc.rect(doc.page.width - 11, 0, 11, doc.page.height).fill(BRAND.accent);
  drawLogo(doc, true, 70, 72, 220);
  doc.font(doc.cleanifyFonts.title).fontSize(42).fillColor(BRAND.white).text("Informe mensual", 70, 225, { width: 460 });
  doc.font(doc.cleanifyFonts.bold).fontSize(21).text(client.name || "Cliente", 70, 328, { width: 455 });
  doc.font(doc.cleanifyFonts.body).fontSize(12).fillColor("#d9ddec").text(period.month || "Periodo analizado", 70, 380, { width: 455 });

  addPage(doc);
  heading(doc, "Resumen ejecutivo", { size: 31 });
  paragraph(doc, sections.resumen_del_mes, { size: 11 });
  section(doc, "Señales favorables", sections.senales_positivas);
  section(doc, "Puntos a reforzar", sections.puntos_a_trabajar);

  const rows = metricRows(report);
  if (rows.length) {
    addPage(doc);
    heading(doc, "Resultados del mes", { size: 31 });
    if (sections.lectura_ga4) section(doc, "Tráfico y comportamiento web", sections.lectura_ga4, { spaceBefore: 5 });
    if (sections.lectura_search_console) section(doc, "Visibilidad orgánica", sections.lectura_search_console);
  }

  const hasOperational = sections.que_se_ha_hecho || sections.proximo_mes || sections.proximo_mes_recomendado || sections.necesitamos_del_cliente;
  if (hasOperational) {
    addPage(doc);
    if (sections.que_se_ha_hecho) section(doc, "Trabajo realizado", sections.que_se_ha_hecho, { size: 29, spaceBefore: 0 });
    if (sections.proximo_mes) section(doc, "Qué haremos el próximo mes", sections.proximo_mes, { size: 27 });
    if (sections.proximo_mes_recomendado) section(doc, "Próximos pasos recomendados", sections.proximo_mes_recomendado, { size: 27 });
    if (sections.necesitamos_del_cliente) section(doc, "Qué necesitamos de vosotros", sections.necesitamos_del_cliente, { size: 25 });
  }

  addPage(doc, { dark: true });
  heading(doc, "Cierre", { size: 38, dark: true });
  paragraph(doc, "Seguiremos revisando la evolución y ajustando las prioridades con datos confirmados, para que cada acción contribuya a una captación más sólida.", { size: 12, dark: true });
  doc.rect(56, doc.cleanifyY + 22, 120, 3).fill(BRAND.accent);
  return finalizeDocument(doc);
}

function sourceRows(sourceStatus = {}) {
  return Object.entries(sourceStatus).map(([key, value]) => {
    const label = {
      ga4: "GA4",
      search_console: "Search Console",
      google_business_profile: "Google Business Profile",
      calls: "Llamadas",
      forms: "Formularios",
      crm: "CRM",
      tasks_done: "Acciones realizadas"
    }[key] || key;
    const detail = value.propertyId || value.siteUrl || value.error || "";
    return `${label}: ${value.loaded ? "disponible" : "no disponible"}${detail ? ` · ${detail}` : ""}`;
  });
}

export async function buildInternalPdfBuffer(report) {
  const client = report.client || {};
  const period = report.period || {};
  const internal = report.internal_summary_for_cleanify || {};
  const doc = createDocument(`Informe interno Cleanify · ${client.name || "Cliente"}`);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(BRAND.primary);
  doc.rect(0, 0, 11, doc.page.height).fill(BRAND.accent);
  drawLogo(doc, true, 56, 56, 160);
  doc.font(doc.cleanifyFonts.title).fontSize(39).fillColor(BRAND.white).text("Informe interno", 56, 195, { width: 480 });
  doc.font(doc.cleanifyFonts.bold).fontSize(19).text(client.name || "Cliente", 56, 300, { width: 480 });
  doc.font(doc.cleanifyFonts.body).fontSize(11).fillColor("#d9ddec").text(period.month || "Periodo analizado", 56, 346, { width: 480 });
  doc.font(doc.cleanifyFonts.bold).fontSize(9).fillColor(BRAND.accent).text("USO INTERNO · DIAGNÓSTICO SIN SUAVIZAR", 56, 410, { width: 480, characterSpacing: 1.2 });

  addPage(doc, { internal: true });
  heading(doc, "Diagnóstico ejecutivo", { size: 30 });
  paragraph(doc, internal.executive_diagnosis, { size: 11 });
  section(doc, "Estado de fuentes", sourceRows(internal.source_status), { spaceBefore: 10 });
  section(doc, "Guía para account manager", [internal.account_manager_guidance]);
  section(doc, "Qué no prometer", [internal.do_not_promise]);

  const rawRows = metricRows(report);
  if (rawRows.length) {
    addPage(doc, { internal: true });
    heading(doc, "Métricas y evidencia base", { size: 30 });
    bullets(doc, rawRows);
  }

  for (const currentIssue of nonEmptyArray(internal.issues)) {
    addPage(doc, { internal: true });
    doc.font(doc.cleanifyFonts.bold).fontSize(8).fillColor(currentIssue.priority === "high" || currentIssue.priority === "critical" ? BRAND.danger : BRAND.warning)
      .text(`PRIORIDAD ${PRIORITY_LABEL[currentIssue.priority] || currentIssue.priority}`, 56, doc.cleanifyY, { characterSpacing: 1 });
    doc.cleanifyY = doc.y + 10;
    heading(doc, currentIssue.title, { size: 27 });
    section(doc, "Evidencia", currentIssue.evidence, { spaceBefore: 2 });
    section(doc, "Impacto", [currentIssue.impact]);
    section(doc, "Diagnóstico", [`${currentIssue.diagnosis} Nivel de confianza: ${currentIssue.confidence}.`]);
    section(doc, "Acciones recomendadas", currentIssue.recommended_actions);
    section(doc, "Criterio de validación", [currentIssue.validation]);
  }

  if (nonEmptyArray(internal.confirmed_actions).length || nonEmptyArray(internal.generated_recommendations).length || nonEmptyArray(internal.client_needs).length) {
    addPage(doc, { internal: true });
    heading(doc, "Plan operativo", { size: 30 });
    section(doc, "Acciones confirmadas", internal.confirmed_actions, { spaceBefore: 2 });
    section(doc, "Recomendaciones generadas", internal.generated_recommendations);
    section(doc, "Necesidades del cliente", internal.client_needs);
  }
  return finalizeDocument(doc, { internal: true });
}
