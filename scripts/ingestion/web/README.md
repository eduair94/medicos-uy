# Enriquecimiento web interno

Este pipeline amplía la investigación puntual a todos los perfiles normalizados del MSP sin
convertir una coincidencia de nombre en un hecho. “Cobertura completa” significa que cada perfil
recibe un estado para el conjunto de fuentes configurado; no significa que Internet haya sido
explorado por completo ni que la ausencia de resultados pruebe ausencia de información.

## Modelo de recolección

1. Se carga el último `professionals.ndjson` del MSP, o la ruta fijada por
   `WEB_ENRICHMENT_PROFESSIONALS_PATH`.
2. Se recorren una sola vez las páginas públicas habilitadas por una política revisada. Este modelo
   `source-first` evita hacer decenas de miles de búsquedas nominales.
3. Crawl4AI recibe únicamente URLs HTTPS públicas y admitidas. No recibe cookies, credenciales,
   documentos privados, código JavaScript ni consultas nominales.
   Si el servicio devuelve contenido truncado, sólo una fuente cuya política declare
   `directFetchAllowed: true` puede usar el adaptador HTTP directo; éste vuelve a validar DNS,
   redirects, tipo, tamaño y host.
4. El texto se clasifica antes de buscar nombres. Contenido judicial, adverso, de menores o sobre
   salud privada se descarta sin persistir nombre, URL, titular, fragmento ni ID profesional.
5. Las menciones benignas producen candidatos internos con identidad y hecho sin confirmar.
6. Se escribe una fila de cobertura por cada perfil MSP.

DuckDuckGo es un proveedor opcional de descubrimiento para lotes pequeños de perfiles sin
resultados. Sus títulos y fragmentos no son evidencia. El adaptador se detiene ante CAPTCHA,
`202`, `403` o `429` y nunca intenta evadir esa protección.

## Puesta en marcha

Copiar `config/web-enrichment-sources.example.json` fuera del checkout, completar revisión de
derechos, fechas, hosts y URLs, y configurar:

```dotenv
WEB_ENRICHMENT_SOURCE_POLICY_PATH=/ruta/privada/web-enrichment-sources.json
WEB_ENRICHMENT_CRAWL4AI_BASE_URL=https://crawl4ai.checkleaked.cc
WEB_ENRICHMENT_DUCKDUCKGO_ENABLED=false
```

Revisar el plan sin red:

```bash
pnpm data:enrich:web:plan
```

Ejecutar un lote:

```bash
pnpm data:enrich:web:tick
```

La salida se crea de forma atómica bajo:

```text
data/processed/web-enrichment/web-enrichment-v1-<fingerprint>/
  candidates.ndjson
  coverage.ndjson
  manifest.json
```

`candidates.ndjson` y las URLs del manifiesto son cuarentena interna. Ninguna salida de esta etapa
es entrada del snapshot factual, de PostgreSQL público ni del OpenAPI.

## Límites operativos

- Una solicitud concurrente por dominio y un máximo pequeño de páginas por ejecución.
- Reintentos sólo para errores de red y `429`, `503` o `504`.
- Límite de tiempo y de bytes tanto para el servicio de crawl como para la página devuelta.
- Validación del host solicitado y final contra la misma allowlist.
- El host Crawl4AI suministrado es externo y modificado; úsese como `best effort`. Para producción
  sostenida se recomienda una instancia propia oficial, autenticada y con salida de red limitada.
- Una fuente que falla deja `PARTIAL_SOURCE_FAILURE`; nunca convierte resultados anteriores en
  hechos ni modifica el directorio público.
