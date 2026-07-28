# Ingesta de fuentes públicas

Este documento describe el primer pipeline reproducible para obtener y normalizar información
pública sobre profesionales de la salud en Uruguay. Los snapshots reales se mantienen fuera de
Git porque contienen datos personales, aunque su origen sea público.

## Alcance

El pipeline separa tres clases de dato:

1. **Registro oficial:** títulos y estado publicados por el MSP en Infotítulos.
2. **Cartelera institucional:** médico, especialidad, sede y horario que un prestador publica.
3. **Enriquecimiento editorial:** publicaciones académicas, noticias, resoluciones o sentencias.

Las dos primeras clases pueden recolectarse de manera determinística. La tercera no se asocia ni
publica automáticamente: una coincidencia de nombre no demuestra identidad, participación,
responsabilidad ni firmeza de una decisión judicial.

## Fuentes del primer corte

| Publicador          | Fuente                                                                                                            | Información obtenible                                   | Interpretación                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| MSP                 | [Infotítulos](https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos) | Nombre, título, estado y registro temporario            | Registro oficial con fecha de corte; puede diferir de la consulta en vivo |
| CASMU               | [Nuestros médicos](https://casmu.com.uy/nuestros-medicos/)                                                        | Médico, especialidad, centro y dirección                | Directorio; la fuente no publica horas por fila                           |
| Asociación Española | [Agenda médica](https://www.asesp.com.uy/Agenda-Medica/Agenda-Medica-uc30)                                        | Médico, especialidad, sede, días y horas                | Cartelera de consulta; no son cupos disponibles                           |
| SMI                 | [Horarios médicos](https://www.smi.com.uy/mvdcms/Cartelera-Medica/Horarios-medicos-uc98)                          | Médico, especialidad, sede, días, horas y observaciones | Cartelera de consulta; no son cupos disponibles                           |
| Médica Uruguaya     | [Cartelera médica](https://www.medicauruguaya.com.uy/mvdcaad/acasasadheridas.aspx)                                | Médico, especialidad, sede, días, horas y frecuencia    | Cartelera de consulta; no son cupos disponibles                           |
| Hospital Británico  | [Horarios de consulta](https://www.hospitalbritanico.org.uy/medicos_horarios_de_consulta_medica.php)              | Médico, especialidad, clínica, día y horario            | Cartelera de consulta; no son cupos disponibles                           |

También se relevaron COSEM, MP, BlueCross, CAMCEL y varias instituciones del interior. Se agregan
por etapas después de validar condiciones de reutilización, estabilidad técnica y semántica de
cada fuente. No se rastrean los endpoints de horarios del Círculo Católico porque su `robots.txt`
los excluye expresamente.

## Resultado del snapshot factual exhaustivo

La ejecución del 27 de julio de 2026 produjo:

| Fuente              | Alcance descargado                         |                                                                                              Resultado |
| ------------------- | ------------------------------------------ | -----------------------------------------------------------------------------------------------------: |
| MSP                 | CSV con corte al 30/06/2026                |                      148.461 filas; 27.747 perfiles de médicos publicables; 3 conflictos en cuarentena |
| Asociación Española | 1.554 opciones del filtro de profesionales |                                          3.578 filas de cartelera; 0 fallos; 0 alertas de truncamiento |
| CASMU               | Directorio y 50 páginas de centros         | 1.373 filas únicas de directorio; 1.375 filas de horario; 786 filas de directorio con horario enlazado |
| SMI                 | 533 opciones del filtro de profesionales   |                                            906 filas de cartelera; 0 fallos; 0 alertas de truncamiento |
| Médica Uruguaya     | 835 opciones del filtro de profesionales   |                                          1.680 filas de cartelera; 0 fallos; 0 alertas de truncamiento |
| Hospital Británico  | Consulta pública sin filtros restrictivos  |                                                                1.080 filas de horario para 408 médicos |

El cruce conservador reconcilió 9.992 filas institucionales sin cuarentenas y las agrupó en 4.380
identidades por institución. Encontró 350 candidatos con nombre completo y título registrado
concordantes, 338 con nombre completo pero sin concordancia de título suficiente y 3.692 sin
coincidencia exacta. El snapshot retuvo los 27.747 perfiles MSP y generó 4.380 resoluciones
`ABSTAINED`: no fusionó, adjuntó ni publicó ninguna identidad institucional automáticamente.

El manifiesto factual agregado, que no contiene nombres ni documentos, está en
[`data/manifests/factual-directory-crossing-2026-07-27.json`](../data/manifests/factual-directory-crossing-2026-07-27.json).
El
[`manifiesto inicial`](../data/manifests/initial-public-ingestion-2026-07-27.json)
se conserva como evidencia histórica del corte anterior a la ingesta completa de Asociación
Española.

## Directorios locales

```text
data/
  raw/          # respuestas originales y bundles CAAD autocontenidos; ignorados por Git
  normalized/   # lotes transitorios de índices/noticias; ignorados por Git
  processed/    # NDJSON normalizado de MSP, CASMU, HB y linkage; ignorado por Git
  manifests/    # conteos y hashes sin datos personales; versionable
```

Los ingestors de SMI y Médica Uruguaya conservan `schedules.ndjson` junto al subdirectorio `raw/` de
cada ejecución para que la evidencia y su derivación formen un bundle atómico. Los nombres y rutas
exactos producidos por cada comando se imprimen al finalizar. Un manifiesto no es evidencia
suficiente por sí solo: el hash referencia el snapshot crudo que debe custodiarse en un
almacenamiento privado, cifrado y con retención definida.

## Ejecución

```powershell
pnpm.cmd data:ingest:msp
pnpm.cmd data:ingest:casmu
pnpm.cmd data:ingest:asociacion-espanola
pnpm.cmd data:ingest:smi
pnpm.cmd data:ingest:medica-uruguaya
pnpm.cmd data:ingest:hospital-britanico
pnpm.cmd data:ingest:news-indexes
pnpm.cmd data:link:candidates
pnpm.cmd data:link:news-candidates
pnpm.cmd data:build:directory
```

`data:ingest:news-indexes` consulta solamente índices públicos oficiales: RSS
home/nacional/salud de El Observador y RSS destacados/noticias de Montevideo Portal. El sitemap de
El País y el RSS nacional de Subrayado están deshabilitados por defecto y exigen bandera explícita
más referencia a autorización escrita vigente cuyo SHA-256 figure en una allowlist provisionada por
el responsable legal. No visita páginas de artículos, buscadores ni históricos mensuales; valida
HTTPS y cada redirect contra una allowlist, impone límites de tiempo/tamaño y respeta pacing por
host. Cualquier ítem individual con más de 30 días se descarta antes de clasificar o extraer
nombres. Si ninguna fuente queda `FETCHED`, la ejecución falla sin instalar un artefacto.

Que un índice sea accesible no autoriza su explotación comercial. El País y Subrayado no se
solicitan sin la compuerta de autorización; para El Observador y Montevideo Portal se conservan
únicamente los metadatos incluidos en sus RSS y siempre sujetos a sus condiciones vigentes. El
manifiesto registra la base y vigencia de revisión de cada fuente, y el proceso falla cerrado si
vence. El TTL se acorta automáticamente a esa vigencia. No se republica el contenido de los
artículos.

El filtro de minimización se ejecuta antes de extraer nombres. Titulares adversos/judiciales,
referidos a menores o a salud privada sólo incrementan contadores agregados: no se guardan sus
titulares, URLs, nombres ni IDs médicos. Para titulares admisibles se contrastan secuencias exactas,
subconjuntos únicos, menciones con honorífico e iniciales puntuadas más un token completo contra el
snapshot MSP, pero únicamente cuando el titular combina contexto médico con un evento público
benigno en allowlist. Las iniciales se omiten cuando superan el límite de 25 candidatos. Los demás
titulares se reducen a un contador sin detalles. La salida nunca contiene IDs profesionales.
`articles.ndjson` no conserva cuerpo ni descripción, queda bajo `data/normalized/`, no es publicable
y tiene un TTL máximo de 90 días registrado en `manifest.json`.

`data:link:news-candidates` no recolecta noticias: usa el `articles.ndjson` normalizado más reciente
dentro de `DATA_INGESTION_DIR`, o el lote exacto indicado por `NEWS_ARTICLES_PATH`, y exige su
manifiesto verificable. Rechaza hashes, conteos o TTL vencidos y sólo produce hipótesis nominales
internas con estado `NEEDS_HUMAN_REVIEW`. El contrato de entrada, las reglas conservadoras de
matching y las salvaguardas de cuarentena están documentados en
[`scripts/ingestion/news/README.md`](../scripts/ingestion/news/README.md). Su salida no alimenta la
exportación pública. La prioridad interna de revisión está acotada a 49 puntos, se declara como
heurística no probabilística, baja cuando el titular no contiene contexto médico y vence a los 90
días junto con el candidato. La salida diferencia flexibilidad 0 (exacto), 1 (parcial) y 2
(iniciales más token completo), siempre con alerta visible en el artefacto interno. Los títulos
oficiales y futuras instituciones verificadas sólo funcionan como señales de apoyo; su ausencia es
neutral y ninguna combinación flexible confirma identidad ni habilita publicación.

`data:purge:news` hace un dry-run de los artefactos vencidos y `data:purge:news:apply` los elimina
de los dos roots exclusivos de noticias. El modo `apply` debe ejecutarse diariamente; valida rutas
reales y falla cerrado si un manifiesto no contiene un vencimiento canónico. Se incluye una unidad
y timer de systemd en `deployment/systemd/medicos-news-retention.{service,timer}` para producción.

La ingesta del MSP necesita una clave de indexación que no debe confirmarse en Git:

```powershell
pnpm.cmd data:setup
pnpm.cmd data:ingest:msp
```

`data:setup` crea `.env.data.local` con permisos restrictivos cuando el sistema los admite, no
imprime la clave y se niega a sobrescribir un secreto existente. En producción, la misma clave debe
vivir en el gestor de secretos de la plataforma.

El HMAC permite comparar registros dentro de un entorno controlado sin conservar el documento en
la salida normalizada. No vuelve anónimo al conjunto ni autoriza a publicar ese identificador.

Los clientes verifican TLS de manera predeterminada. Cualquier excepción de desarrollo debe ser
explícita, temporal y quedar fuera de producción.

## Semántica de horarios

Cada observación usa uno de estos estados:

- `published_consultation_roster`: día u hora de atención anunciados por la institución.
- `facility_hours`: horario general de una sede, recepción o servicio.
- `not_published_on_source`: el directorio confirma la relación, pero no publica el horario.
- `live_appointment_slot`: cupo reservable en tiempo real.

Las fuentes anónimas relevadas permiten obtener los tres primeros estados. El pipeline no genera
`live_appointment_slot`: para eso se necesita una integración autorizada con el prestador; no se
reutilizan cuentas, cookies ni sesiones de socios.

## Unión de identidades

El documento del MSP se usa sólo en memoria para agrupar títulos y producir un HMAC interno. Las
carteleras no publican ese identificador. Por eso la unión se trata como una lista de candidatos:

1. nombre normalizado exacto y sin homónimos;
2. comparación alternativa por el multiconjunto exacto de todos los tokens del nombre, sin
   descartar segundos nombres, apellidos ni partículas;
3. concordancia explícita entre título/especialidad, cuando existe;
4. revisión humana antes de consolidar un perfil;
5. estado `ambiguous` cuando hay más de una persona posible;
6. nunca resolver sólo por similitud difusa.

Las diferencias de tildes, puntuación, orden `apellido, nombre` y prefijos `Dr.`/`Dra.` pueden
normalizarse. No se descartan segundos nombres o apellidos para forzar coincidencias.

El esquema de candidatos v2 usa `sourceProfessionalId` cuando la institución lo publica. Si no
existe, conserva explícitamente la base más débil `institution_and_exact_name`. Cada referencia se
guarda como el par inseparable `{ sourceFile, recordId }`; no se mantienen listas paralelas que
puedan perder la procedencia. Los bundles CAAD de muestra, incompletos, con fallos o posibles
truncamientos quedan fuera de la selección automática.

## Snapshot de directorio

`data:build:directory` verifica hashes y conteos contra los manifests MSP y linkage antes de
materializar:

```text
data/processed/directory/factual-v3-<fingerprint>/
  profiles.ndjson
  linkage-resolutions.ndjson
  privacy-and-publication-notice.json
  manifest.json
```

- `profiles.ndjson` contiene los 27.747 perfiles canónicos MSP del corte actual, títulos sin
  identificadores gubernamentales crudos, fecha de corte, frecuencia mensual prevista y aviso
  versionado.
- `linkage-resolutions.ndjson` contiene exactamente una resolución por identidad institucional.
- Sin archivo de decisiones humanas aprobado, todas las resoluciones son `ABSTAINED`.
- No se adjuntan horarios, reseñas, noticias ni antecedentes a un perfil abstendido.
- El ID del snapshot deriva de los hashes de entrada, manifests, aviso y versión de política; no se
  sobrescribe una salida existente.
- `publicExportAllowed` siempre queda en `false` en este finalizador interno.

El aviso requiere responsable, domicilio, nombre e inscripción de la base, canal de derechos,
encargados, destinatarios y transferencias. Rechaza placeholders, correos inválidos y URLs de
política que no sean HTTPS absolutas. Completar esos campos tampoco levanta el bloqueo:
`approval.required` permanece en `true`, `approval.approved` en `false`, y cada fuente mantiene
compuertas independientes de base jurídica, compatibilidad de finalidad y reutilización. La
clasificación y licencia del MSP son provisionales hasta la confirmación específica del dataset.
Véase
[`PRIVACY_PUBLICATION_GATE.md`](./PRIVACY_PUBLICATION_GATE.md).

## Exportación pública separada

La salida interna no debe servirse directamente. La única proyección sanitizada se construye con:

```powershell
$env:PUBLICATION_POLICY_PATH='C:\ruta\politica-aprobada.json'
$env:PUBLICATION_POLICY_SIGNATURE_PATH='C:\ruta\politica-aprobada.sig'
$env:PUBLICATION_POLICY_PUBLIC_KEY_PATH='C:\ruta\firmante-publica.pem'
$env:PUBLICATION_POLICY_SIGNER_KEY_ID='legal-release-2026-01'
$env:PUBLICATION_POLICY_SIGNER_FINGERPRINT_SHA256='<sha256-der-spki-en-minusculas>'
$env:PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY='<base64url-de-32-bytes-aleatorios>'
$env:PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY_ID='delivery-auth-2026-01'
$env:PUBLIC_PROFILE_ID_SECRET='<otro-base64url-de-32-bytes-aleatorios>'
pnpm.cmd data:build:public-directory
```

Cada secreto se genera por separado, por ejemplo ejecutando dos veces:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

El proceso acepta base64 canónico con padding o base64url canónico sin padding, exige al menos 32
bytes decodificados y falla si ambos valores representan los mismos bytes, incluso cuando usan
codificaciones distintas.

La firma es Ed25519 sobre los bytes exactos del JSON y el archivo `.sig` contiene la firma en
base64 canónico. La clave privada nunca se entrega al proceso ni se guarda en este repositorio. La
huella confiable es SHA-256 de la clave pública DER/SPKI y debe fijarse en la configuración de
despliegue; no debe calcularse dinámicamente desde el mismo archivo que se intenta autenticar.
Antes de firmar, el JSON debe serializarse con dos espacios, saltos LF y un único salto final; el
verificador rechaza otras serializaciones y, por esa comparación canónica, también claves
duplicadas.

El comando:

- valida aprobación de base jurídica, finalidad y reutilización;
- valida aprobaciones separadas del aviso del responsable, registro de base, circuito de derechos,
  seguridad/retención y determinación de EIPD/DPO;
- verifica la firma separada contra la clave Ed25519 y la huella confiable;
- exige que `approvedSnapshot.snapshotId` y `approvedSnapshot.profilesSha256` coincidan exactamente;
- rechaza políticas o autorizaciones vencidas;
- rechaza una fuente cuya fecha de corte supere `maxSourceAgeDays`;
- exige un snapshot factual-v3, comprueba sus cuatro entradas, manifests de MSP/linkage, aviso
  legal, ledger de abstenciones, hashes, procedencia, fechas y compuertas bloqueadas;
- exige que el aviso incluya responsable, domicilio, contacto, política de privacidad, inscripción,
  base identificada, encargados, destinatarios y transferencias, sin placeholders pendientes;
- exige que la fuente coincida exactamente con la política;
- aplica una allowlist fija;
- reemplaza `internalLinkageId` por un UUID público derivado con un secreto separado;
- no incluye candidatos, resoluciones, IDs institucionales, rutas raw, reseñas ni datos adversos;
- publica como vigencia efectiva el menor vencimiento entre política y fuente;
- produce un manifiesto con hashes y salvaguardas e instala el par de archivos atómicamente;
- es idempotente y se niega a sobrescribir un artefacto diferente.

El snapshot factual-v3 interno también se monta como directorio completo mediante staging y un
único `rename`; un fallo no deja un directorio seleccionable con archivos parciales.

El directorio de salida es almacenamiento interno y no debe exponerse con Nginx, un bucket público
ni middleware estático. Toda futura entrega debe abrirlo mediante
`readPublicDirectoryArtifactForDelivery`: este lector verifica nuevamente ubicación, hash, conteo,
salvaguardas, el HMAC del manifiesto y `effectiveValidUntil` antes y después de cargar el contenido.
Su contrato devuelve solamente `profilesContent`, los bytes ya verificados, y no entrega la ruta
del archivo para evitar que una capa HTTP vuelva a abrir contenido mutable después de validarlo.
La clave HMAC es independiente del secreto de IDs y nunca se publica; ambos son valores aleatorios
de al menos 32 bytes en base64/base64url canónico y su reutilización se rechaza. El `keyId` cambia
con cada rotación. Un artefacto vencido o un manifiesto autoconsistente pero forjado no se devuelve
aunque el archivo todavía se conserve para auditoría. El reloj inyectable existe sólo para pruebas
y nunca se construye desde parámetros de una solicitud.

El lector actual acepta un único par `{ keyId, key }` y falla cerrado ante cualquier otro. Para una
rotación con despliegue gradual, el artefacto, su ruta selectora, el `keyId` y la clave deben viajar
como una sola versión de configuración: las instancias antiguas conservan el par y artefacto
anteriores mientras drenan, y las nuevas reciben juntos el par y artefacto nuevos. El artefacto
anterior se conserva privado y disponible hasta retirar la última instancia antigua. No se debe
cambiar un selector compartido antes que la clave correspondiente. Si la plataforma no puede
acoplar esos valores por versión, la rotación requiere una ventana controlada o implementar un
keyring explícito antes de producción.

La plantilla
[`config/source-publication-policy.example.json`](../config/source-publication-policy.example.json)
tiene todas las decisiones en `approved: false`. Su finalidad es documentar el contrato; no debe
marcarse como aprobada ni firmarse sin evidencia jurídica revisada y vigente. Debe completarse
además con el identificador y hash del snapshot exacto que el firmante inspeccionó.

## Enriquecimiento público

Puede publicarse automáticamente una afirmación académica sólo cuando existe un vínculo estable,
por ejemplo un ORCID autenticado, DOI/PMID o perfil institucional que enlaza al profesional. ORCID,
Crossref, PubMed, CVUy, Colibrí y páginas oficiales son fuentes de descubrimiento; buscar sólo por
nombre no alcanza para atribuir una publicación.

LinkedIn queda fuera del crawler automatizado por sus condiciones de uso. Una URL puede incorporarse
si el propio profesional la aporta y autoriza.

Que una cartelera sea visible sin login no basta para republicarla. El
[Dictamen 10/020 de la URCDP](https://www.gub.uy/unidad-reguladora-control-datos-personales/institucional/normativa/dictamen-n-10020)
establece que Internet no es por sí mismo una fuente pública. Los datos institucionales permanecen
en cuarentena hasta documentar finalidad, base aplicable y autorización o condiciones de
reutilización de cada fuente.

Las noticias sirven para descubrir fuentes primarias, no para establecer hechos adversos. Las
sentencias requieren comprobar identidad, rol procesal, resultado, apelaciones y firmeza mediante
revisión jurídica. No se genera una etiqueta o puntaje de “mala praxis”.

## Crawl4AI

El endpoint compartido puede utilizarse para páginas públicas estáticas sin credenciales. El
cliente limita las URLs a una lista de hosts y conserva la URL de origen; nunca se le envían
documentos, cookies, tokens ni búsquedas nominales sensibles. Para producción se recomienda una
instancia propia detrás de un gateway autenticado, con:

- lista permitida de dominios;
- prevención de SSRF y bloqueo de redes privadas;
- límites de tamaño, tiempo y concurrencia;
- respeto de `robots.txt`, términos y licencias;
- snapshots inmutables y hashes antes de parsear.

El parser específico de cada fuente, no el texto generado por un modelo, es quien produce los
campos estructurados.

En el snapshot inicial, `/html` respondió correctamente para CASMU pero su versión procesada
conservó sólo 0,16 % de las filas completas y perdió los enlaces a centros. El control de integridad
rechazó esa respuesta y activó el `fetch` directo. Se guardaron ambos artefactos y sus hashes; esto
demuestra por qué Crawl4AI debe ser un transporte opcional, no la única fuente de verdad.

## Calidad y actualización

- una solicitud concurrente como máximo por dominio;
- reintentos acotados con espera progresiva;
- `User-Agent` identificable y contacto operativo antes de producción;
- fecha de observación y hash en cada release;
- pruebas con fixtures sintéticos, nunca snapshots reales en Git;
- actualización mensual del MSP y semanal de carteleras, ajustable por cabeceras y cambios reales;
- expiración visible de horarios que no pudieron revalidarse;
- canal de acceso y rectificación con plazo máximo de cinco días hábiles, suspensión visible
  mientras se investiga una impugnación y notificación de la corrección a destinatarios.

## Dossier privado por profesional

`data:research:professional -- --name "<nombre>"` proyecta en un solo artefacto privado el registro
MSP, candidatos institucionales, filas exactas de horarios, menciones web y referencias públicas
curadas. La proyección no modifica PostgreSQL ni el export público.

Las URLs completas pueden entregarse por una API personal autenticada. La marca
`publicExportAllowed: false` separa esa consulta privada del directorio público; no elimina los
vínculos del reporte interno.

La proyección sigue exclusivamente los `recordId` emitidos por parsers institucionales. Nunca
considera como evidencia una aparición del nombre dentro del selector general de una agenda.
LinkedIn se admite sólo como URL curada sin descarga automatizada; documentos que no contienen el
nombre se conectan únicamente como corroboración contextual de otra referencia nominada. El
contrato, variables y comando están en `scripts/ingestion/research/README.md`.

## Cobertura web para todos los perfiles

`data:enrich:web:tick` recorre fuentes expresamente habilitadas una vez y compara su contenido
benigno contra todo el padrón MSP. Produce una fila de `coverage.ndjson` por perfil, aun cuando no
haya candidato. El estado `NO_CANDIDATE_WITHIN_CONFIGURED_SCOPE` sólo describe las fuentes y el
momento de esa ejecución; no prueba ausencia de información.

Toda mención queda en cuarentena con `NOT_LINKED` y `NOT_PUBLISHED`. El clasificador descarta
contenido adverso, judicial, de menores o de salud privada antes de extraer nombres. Consulte
`scripts/ingestion/web/README.md` para la política, variables y límites.
