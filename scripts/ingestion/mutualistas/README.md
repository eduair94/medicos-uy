# Carteleras públicas de mutualistas

Estos ingestors descargan exclusivamente carteleras anónimas publicadas por las instituciones.
Los horarios son una grilla habitual de consulta, no cupos disponibles en tiempo real. No se
accede a autogestión, cuentas de socios ni agendas autenticadas.

## Ejecución

```powershell
pnpm exec tsx scripts/ingestion/mutualistas/ingest-smi.ts
pnpm exec tsx scripts/ingestion/mutualistas/ingest-medica-uruguaya.ts
pnpm exec tsx scripts/ingestion/mutualistas/ingest-asociacion-espanola.ts
```

Para una prueba limitada:

```powershell
pnpm exec tsx scripts/ingestion/mutualistas/ingest-smi.ts --limit 5 --delay-ms 350
```

Opciones:

- `--delay-ms`: pausa entre solicitudes secuenciales; mínimo 250 ms y valor predeterminado 350 ms.
- `--timeout-ms`: timeout por solicitud; predeterminado 20 segundos.
- `--retries`: reintentos para errores transitorios; predeterminado 3.
- `--limit`: procesa solamente los primeros N médicos del filtro público.
- `--output-dir`: usa un directorio nuevo explícito.

## Salida

La ruta predeterminada es `data/raw/mutualistas/{fuente}/{runId}/`:

- `raw/index.html`: formulario inicial.
- `raw/doctors/{secuencia}-{id}.html`: evidencia cruda de cada consulta individual.
- `doctor-filter-options.json`: opciones públicas del filtro y alcance seleccionado.
- `schedules.ndjson`: una fila normalizada por fila de la cartelera.
- `failures.ndjson`: solicitudes fallidas, si existen.
- `manifest.json`: procedencia, política HTTP, conteos, checksums, limitaciones y estado.

Cada registro conserva el texto fuente de los días y horas. Se etiqueta con
`scheduleType = "published_consultation_roster"` y
`appointmentAvailability = "not_observed"`.

## Estrategia y limitaciones

La consulta sin filtros devuelve únicamente 20 filas. Para evitar esa truncación se toma la lista
pública de `FiltroId2` y se hace un `POST` secuencial por médico con sede y especialidad en `0`.
Una respuesta individual con 20 o más filas queda señalada en el manifiesto como posible
truncamiento residual.

Los nombres no son identificadores únicos. La vinculación con MSP debe realizarse posteriormente
como un proceso explícito, auditable y con niveles de confianza. Los números de dependencia de
Médica Uruguaya se conservan como texto fuente porque su significado no está documentado en la
cartelera.

Asociación Española publica días abreviados (`Lun.`, `Mar.`, `Mié.`, etc.); el parser los conserva
como etiqueta fuente y los mapea al día normalizado. Su filtro también contiene servicios y roles
que no necesariamente representan una persona médica, por lo que no se vinculan automáticamente.

La visibilidad anónima de una agenda no constituye por sí sola autorización de reutilización. Los
snapshots se conservan para investigación y cualquier proyección pública queda bloqueada hasta
documentar finalidad, autorización de fuente y revisión humana.
