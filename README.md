# Cleanify Reporting Agent

Backend Node.js para generar reportes mensuales Cleanify con datos reales y PDFs en plantillas visuales bloqueadas.

## Versión

`1.10.0-locked-cleanify-v7-renderer`

## Cambio clave de esta versión

El diseño de los PDFs ya no queda a interpretación del agente/proyecto. La aplicación renderiza con dos plantillas internas fijas en PDFKit:

- `client_v7`: informe mensual para cliente, 6 páginas, estética Cleanify v7 cliente.
- `internal_v7`: informe interno Cleanify, 2 páginas, estética Cleanify v7 interno.

El agente y el proyecto deben enviar datos/JSON al backend. El backend decide la maquetación.

## Endpoints principales

- `POST /api/report/monthly/package` genera paquete con URLs de PDFs.
- `POST /api/report/monthly/client-pdf` devuelve el PDF cliente directo.
- `POST /api/report/monthly/internal-pdf` devuelve el PDF interno directo.
- `POST /api/report/render` es el render oficial Cleanify v7. Acepta `template_id: client_v7` o `template_id: internal_v7`.

## Regla operativa

No usar ChatGPT/Proyecto/Agente para diseñar PDFs. Solo deben estructurar contenido y llamar a este renderer oficial.
