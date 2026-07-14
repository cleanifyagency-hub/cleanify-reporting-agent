import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalogFromSources, assertClientReportable } from "../client-catalog.js";

test("un alta nueva en Google aparece sin hoja ni despliegue", () => {
  const clients = buildCatalogFromSources({
    assets: {
      search_console: [{ siteUrl: "sc-domain:nuevocliente.es", domain: "nuevocliente.es", permissionLevel: "siteOwner" }],
      ga4: [{ propertyId: "999", propertyName: "Nuevo Cliente", accountName: "Cleanify" }]
    },
    sheetClients: [],
    env: {}
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0].domain, "nuevocliente.es");
  assert.equal(clients[0].ga4PropertyId, "999");
  assert.equal(clients[0].reportingAllowed, true);
  assert.equal(clients[0].source, "google_auto");
});

test("Econeta queda bloqueada aunque siga entre los activos de Google", () => {
  const clients = buildCatalogFromSources({
    assets: {
      search_console: [{ siteUrl: "https://econeta.es/", domain: "econeta.es", permissionLevel: "siteFullUser" }],
      ga4: [{ propertyId: "526346028", propertyName: "Econeta", accountName: "Cleanify" }]
    },
    sheetClients: [],
    env: {}
  });
  assert.equal(clients[0].status, "inactive");
  assert.equal(clients[0].reportingAllowed, false);
  assert.throws(() => assertClientReportable(clients[0]), (error) => error.code === "CLIENT_NOT_ACTIVE" && error.statusCode === 409);
});

test("una propiedad sin permisos suficientes no queda habilitada", () => {
  const clients = buildCatalogFromSources({
    assets: {
      search_console: [{ siteUrl: "sc-domain:sinpermiso.es", domain: "sinpermiso.es", permissionLevel: "siteUnverifiedUser" }],
      ga4: []
    },
    sheetClients: [],
    env: {}
  });
  assert.equal(clients[0].status, "permission_required");
  assert.equal(clients[0].reportingAllowed, false);
});

test("la hoja opcional puede marcar una baja sin ser necesaria para el alta", () => {
  const clients = buildCatalogFromSources({
    assets: {
      search_console: [{ siteUrl: "sc-domain:antiguo.es", domain: "antiguo.es", permissionLevel: "siteOwner" }],
      ga4: []
    },
    sheetClients: [{ client_id: "old", name: "Antiguo", domain: "antiguo.es", estado: "baja", aliases: [] }],
    env: {}
  });
  assert.equal(clients[0].status, "inactive");
  assert.equal(clients[0].metadata_source, "google_sheet_optional");
});
