# Candidatos médico ↔ noticia

## Recolección acotada de índices uruguayos

`pnpm.cmd data:ingest:news-indexes` genera atómicamente
`data/normalized/news/news-index-v1-<fingerprint>/{articles.ndjson,manifest.json}` desde sitemap/RSS
oficiales. El País usa únicamente `news-sitemap-content.xml` para lograr cobertura reciente con una
sola solicitud y respetar su `Crawl-delay: 10`; no se consulta `news-sitemap-latest.xml` ni sitemaps
mensuales. El Observador usa home/nacional/salud y Montevideo Portal destacados/noticias, con
deduplicación por URL. El RSS nacional de Subrayado se evalúa pero se omite como `STALE` cuando no
tiene publicaciones dentro de 72 horas. Aunque una fuente esté vigente, cada ítem que supere
30 días de antigüedad se descarta antes de clasificar o extraer nombres.

La disponibilidad técnica de un índice no equivale a permiso de reutilización comercial. El País y
Subrayado están deshabilitados por defecto: sólo se incorporan cuando la bandera de cada fuente es
`true`, existe una referencia a una autorización escrita vigente y su SHA-256 está en la allowlist
provisionada por el responsable legal. El manifiesto guarda únicamente ese SHA-256. En El
Observador y Montevideo Portal sólo deben reutilizarse los campos expresamente entregados por sus
RSS (título, enlace y fecha), respetando sus condiciones vigentes y sin republicar el contenido de
la nota. Toda fuente tiene fecha de revisión de derechos; el colector falla cerrado cuando ésta
vence y el artefacto nunca sobrevive a esa vigencia.

El matcher vuelve a exigir esas mismas variables cuando el manifiesto incluye una fuente sujeta a
autorización: recomputa el SHA-256 de la referencia y lo contrasta con la allowlist externa. Un hash
autodeclarado dentro del manifiesto no habilita la fuente.

El colector no descarga cuerpos, descripciones, páginas de artículos ni resultados de buscadores.
Antes de extraer nombres aplica los vetos de titular adverso/judicial, sobre menores o salud
privada; el manifiesto conserva sólo conteos por motivo. Para los restantes hace una comparación
efímera con los nombres MSP y sólo persiste el resultado cuando **todo** el titular, una vez
enmascarado el nombre, coincide con una plantilla pública cerrada de premio, cargo o actividad
académica/institucional. No alcanza con que aparezcan palabras sueltas de una allowlist. Todo lo
demás se agrega como
`NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT`, sin titular, URL ni nombre. Los nombres admitidos deben
contrastar con el MSP (exacto, subconjunto único u honorífico compatible), y nunca se persisten IDs
profesionales.
`articles.ndjson` usa el esquema cerrado de este matcher, es interno/no publicable y vence a los
90 días. No hay requests condicionales/ETag en v1: sin un snapshot previo seguro, un `304` podría
convertir incorrectamente una corrida útil en un lote vacío.

Variables opcionales: `NEWS_PROFESSIONALS_PATH` fija el snapshot MSP y `NEWS_INDEX_OUTPUT_DIR` fija
la salida, siempre dentro de `DATA_INGESTION_DIR`. `NEWS_ENABLE_ELPAIS` /
`NEWS_ELPAIS_AUTHORIZATION_REFERENCE` y `NEWS_ENABLE_SUBRAYADO` /
`NEWS_SUBRAYADO_AUTHORIZATION_REFERENCE`, junto con sus respectivas variables
`*_AUTHORIZATION_SHA256_ALLOWLIST`, controlan las fuentes que requieren permiso escrito. Si todas
las fuentes fallan, no se instala ningún artefacto. Un lote válido con cero coincidencias sí produce
`articles.ndjson` vacío y el matcher genera una cuarentena vacía.

Este módulo compara nombres de un snapshot factual del MSP con menciones de personas ya
normalizadas por un proceso anterior. Su única salida es una lista interna en cuarentena para
revisión humana. No descarga noticias, no confirma identidad, no acepta las afirmaciones de un
artículo como hechos, no vincula registros y no produce una salida publicable.

## Entradas

`NEWS_PROFESSIONALS_PATH` admite uno de estos NDJSON:

- `professionals.ndjson` normalizado por `data:ingest:msp`, con `linkageId` HMAC, `fullName`,
  títulos habilitados y procedencia MSP;
- `profiles.ndjson` del snapshot interno `factual-v3`, con `internalLinkageId`, `displayName`,
  `officialRegistry` y `publication.publicExportAllowed=false`.

No admite número de documento, cédula, correo ni teléfono. Si la variable queda vacía, se
selecciona el último `professionals.ndjson` MSP dentro de `DATA_INGESTION_DIR`.

`NEWS_ARTICLES_PATH` es obligatorio y debe estar acompañado por su `manifest.json` (o por
`NEWS_ARTICLES_MANIFEST_PATH`). Antes del matching se verifican path, SHA-256, cantidad de registros,
TTL y vencimiento; un lote vencido no puede recibir un TTL nuevo. Cada línea de `articles.ndjson`
debe cumplir exactamente este contrato:

```json
{
  "schemaVersion": 1,
  "articleId": "medio-opaque-id:12345",
  "headline": "Titular conservado para la revisión humana",
  "extractedPersonNames": ["Nombre Apellido"],
  "source": {
    "sourceId": "elobservador_home",
    "publisher": "Nombre del medio",
    "canonicalUrl": "https://medio.example/noticia/12345",
    "publishedAt": "2026-07-01T12:00:00.000Z",
    "retrievedAt": "2026-07-02T12:00:00.000Z",
    "contentSha256": "64 caracteres hexadecimales en minúscula"
  },
  "extraction": {
    "method": "DETERMINISTIC_PARSER",
    "extractedAt": "2026-07-02T12:00:00.000Z",
    "extractorVersion": "uruguayan-public-indexes-v5"
  }
}
```

Reglas del contrato:

- `articleId` es un identificador estable y opaco del sistema fuente. No puede ser un nombre,
  documento, correo, URL ni otro dato personal crudo.
- Aunque el parser aislado reconoce tres métodos normalizados, un lote firmado por este colector
  sólo se acepta con `DETERMINISTIC_PARSER`, la versión vigente y `extractedAt=retrievedAt`.
- Las fechas son instantes ISO 8601 canónicos en UTC; recuperación no puede preceder a publicación
  y extracción no puede preceder a recuperación.
- `canonicalUrl` debe usar HTTPS sin credenciales y `contentSha256` identifica exactamente el
  contenido del cual se extrajeron las menciones.
- Las menciones deben ser únicas después de normalizar y contener al menos dos tokens.
- El esquema es cerrado. Campos como cuerpo, resumen o clasificación editorial son rechazados para
  minimizar datos y evitar que el matcher interprete contenido.

El matcher sólo acepta el manifiesto exacto del colector vigente: verifica versiones, política de
titulares y derechos, partición completa del catálogo, forma y estado de cada reporte, hash,
conteo y vencimiento. Además vincula cada artículo por `sourceId` a una fuente obtenida, exige que
publisher y host pertenezcan a esa fuente, revalida los 30 días y recomputa `articleId` y
`contentSha256`. El path, SHA-256, cantidad de filas y cantidad de nombres indexables del snapshot
profesional deben coincidir exactamente con los usados por el colector. `TEST_FIXTURE`, una fuente
manual, otro snapshot MSP o un manifiesto reempacado no son entradas productivas válidas.

## Matching

El algoritmo `context-aware-flexible-name-candidates-v5` considera, en este orden:

1. nombre exacto después de normalizar tildes, puntuación, honoríficos y orden
   `apellido, nombre` (`flexibility.index=0`);
2. subconjunto estricto de al menos dos tokens completos
   (`flexibility.index=1`);
3. una o más iniciales más al menos un token completo, conservando el orden del nombre
   (`flexibility.index=2`).

El índice mide cuán laxa fue la coincidencia: un número mayor significa más flexibilidad y mayor
riesgo de falso positivo. No mide confianza, probabilidad de identidad, riesgo, culpabilidad ni
calidad profesional. No se usa distancia de edición, fonética, apodos, género inferido, fotografía,
edad, nacionalidad ni redes sociales.

El colector reconoce iniciales puntuadas sintéticas como `N. Nube`, pero se abstiene si la mención es
compatible con más de 25 profesionales. El matcher aplica el mismo límite a cualquier mención
flexible para evitar explosiones de candidatos. Iniciales solas como `G. G.` no son admisibles:
siempre debe existir al menos un token completo.

Cuando el snapshot factual aporta títulos oficiales, el matcher busca en el titular una señal
distintiva compatible de profesión o especialidad. También admite instituciones verificadas en el
contrato interno, aunque el adaptador factual actual no publica afiliaciones institucionales y por
eso las deja vacías. La ausencia de contexto es neutral y nunca se trata como contradicción. Una
coincidencia de profesión o institución sólo ordena la revisión; no es un identificador personal,
no resuelve homónimos automáticamente y no habilita publicación.

La política cerrada de titulares benignos admite un vocabulario controlado de roles específicos
—por ejemplo, anestesiólogo/a, cardiólogo/a o cirujano/a— delante del nombre. Palabras genéricas
como `médico`, `doctora` o `especialista` no cuentan como corroboración.

Un homónimo exacto produce un candidato separado para cada profesional, con
`ambiguity.kind=HOMONYM`, referencias a los IDs opacos competidores y prioridad reducida. Un nombre
parcial compatible con varias personas queda como `MULTIPLE_POSSIBLE_PROFESSIONALS`.
`match.reviewPriority` usa como máximo 49 puntos y declara expresamente
`REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY`: sólo ordena la cola humana. Cada candidato
incluye además `match.alert`, con advertencia obligatoria, severidad y códigos explicables. Los
parciales sin contexto, las iniciales y cualquier ambigüedad se marcan `CRITICAL`.

El `candidateId` es determinista y deriva únicamente del `linkageId` opaco del profesional y del
`articleId` opaco. Nombres, titulares y URLs nunca forman parte del ID.

## Ejecución y salida

```powershell
$env:DATA_INGESTION_DIR='data'
$env:NEWS_ARTICLES_PATH='data/normalized/news/articles.ndjson'
pnpm.cmd data:link:news-candidates
```

La salida predeterminada es:

```text
data/processed/news-linkage/news-quarantine-v2-<fingerprint>/
  candidates.ndjson
  manifest.json
```

El fingerprint deriva de los hashes de ambos inputs y de la versión del algoritmo. El directorio
se instala mediante staging y un único `rename`; nunca se sobrescribe. El manifiesto registra
paths relativos, SHA-256, conteos, formatos y salvaguardas. Cada candidato conserva además fila,
hash del artefacto, procedencia MSP, URL/fechas/hash del artículo y versión del extractor.
El artefacto y cada candidato declaran un máximo de 90 días. El vencimiento efectivo es el menor
entre ese máximo, el vencimiento del lote fuente y la vigencia de revisión de derechos; al vencer
deben eliminarse o revalidarse desde las fuentes.

La retención se ejecuta con:

```powershell
pnpm.cmd data:purge:news       # sólo informa lo que vencería
pnpm.cmd data:purge:news:apply # elimina artefactos vencidos
```

El modo `apply` debe programarse al menos una vez al día. Sólo inspecciona hijos directos de
`data/normalized/news/` y `data/processed/news-linkage/`, verifica rutas reales y manifiestos, y
falla cerrado ante un TTL inválido.

La plantilla de producción
`deployment/systemd/medicos-news-retention.{service,timer}` ejecuta y registra la purga diariamente.
Debe instalarse con el usuario/path del despliegue y verificarse con
`systemctl status medicos-news-retention.timer`.

Todos los candidatos tienen, sin excepción:

- `state=NEEDS_HUMAN_REVIEW`;
- `linkageDecision.decision=NOT_LINKED`;
- `publicationDecision.decision=NOT_PUBLISHED`;
- `publicationDecision.publicExportAllowed=false`;
- identidad, hechos, inferencia adversa y publicación automática en `false`.

Esta cuarentena no debe importarse al catálogo público ni consumirse desde
`scripts/ingestion/publication/`. Cualquier resolución futura necesita un flujo humano separado,
identificadores secundarios verificables, fuente primaria, análisis jurídico y una decisión
documentada. Una noticia y una coincidencia nominal nunca bastan.

El colector vigente excluye antes del matching titulares adversos/judiciales, datos de menores y
salud privada. Por tanto este flujo sólo genera candidatos sobre titulares benignos admitidos por
la política cerrada. Incorporar casos adversos requiere un pipeline jurídico separado; flexibilizar
el nombre no modifica ni elude esa restricción.
