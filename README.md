# Cleanify Reporting Agent

Backend de informes mensuales de Cleanify con GA4, Google Search Console, PDF para cliente y PDF interno de agencia.

## Catálogo automático de clientes

La fuente principal es el inventario vivo de propiedades accesibles con la cuenta OAuth de Google:

- Una propiedad nueva de Search Console o GA4 aparece automáticamente en `GET /clients`.
- La hoja `Cleanify · Data Hub Clientes` es opcional y sólo enriquece nombre, sector, ubicación, servicios y estado.
- Si la hoja falla o desaparece, las altas siguen funcionando.
- Las propiedades con permiso insuficiente aparecen como `permission_required` y no pueden generar informes.
- Los clientes inactivos o pausados permanecen auditables con `GET /clients?includeInactive=true`, pero el backend bloquea sus informes con `CLIENT_NOT_ACTIVE`.
- Econeta está marcado como inactivo por decisión explícita de Cleanify.

Para una baja, lo más automático es retirar el activo de la cuenta Google autorizada. Si se necesita conservar acceso histórico, usar una de estas variables de Hostinger:

```text
INACTIVE_CLIENT_DOMAINS=econeta.es,otrocliente.es
CLIENT_STATUS_OVERRIDES={"cliente.es":"paused","Otro cliente":"inactive"}
```

## Informes

`client_v8`:

- tono sereno y honesto;
- sólo datos disponibles;
- secciones ausentes eliminadas por completo;
- acciones realizadas sólo si fueron aportadas;
- acciones confirmadas y recomendaciones futuras separadas.

`internal_v8`:

- diagnóstico directo;
- incidencias ordenadas por prioridad;
- evidencia, impacto, diagnóstico, confianza, acciones y validación;
- huecos de datos y permisos explícitos.

## Endpoints principales

```text
GET  /health
GET  /clients
GET  /clients?includeInactive=true
GET  /google/test
GET  /google/assets
POST /api/report/monthly
POST /api/report/monthly/client-pdf
POST /api/report/monthly/internal-pdf
POST /api/report/monthly/package
POST /api/report/render
POST /mcp
```

## Desarrollo

```text
pnpm install
pnpm test
pnpm start
```

Los PDF de QA se generan con `node scripts/generate-qa-pdfs.mjs` dentro de `output/pdf/`.
