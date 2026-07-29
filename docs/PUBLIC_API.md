# API privada de consulta

La API es REST, versionada por URI, de solo lectura y accesible únicamente al owner. El contrato
canónico es OpenAPI 3.0 y se genera desde los mismos controladores y DTO que atienden las
solicitudes. El nombre interno `public-query` describe la proyección factual del catálogo, no una
superficie HTTP anónima.

## Superficies

| Recurso                             | Media type                 | Finalidad                     |
| ----------------------------------- | -------------------------- | ----------------------------- |
| `GET /openapi.json`                 | `application/json`         | contrato legible por máquinas |
| `GET /docs`                         | `text/html`                | referencia interactiva Scalar |
| `GET/HEAD /.well-known/api-catalog` | `application/linkset+json` | descubrimiento RFC 9727       |
| `GET /rsd.xml`                      | `application/rsd+xml`      | compatibilidad RSD solicitada |
| `GET /.well-known/rsd.xml`          | `application/rsd+xml`      | alias well-known de RSD       |

Todas estas superficies requieren autenticación. Sólo `GET/HEAD /health/live` y
`GET/HEAD /health/ready` quedan públicos; los preflight `OPTIONS` de CORS no devuelven datos.

Todas las respuestas anuncian:

```http
Link: <https://api.example/openapi.json>; rel="service-desc"; type="application/json",
      <https://api.example/docs>; rel="service-doc"; type="text/html"
```

El catálogo `/.well-known/api-catalog` sigue RFC 9727 y usa las relaciones `service-desc`,
`service-doc`, `service-meta` y `status`. RSD es una compatibilidad XML legada y solamente declara
el contrato OpenAPI; no anuncia XML-RPC, MetaWeblog ni APIs de blogs.

## Configuración

```dotenv
API_DOCUMENTATION_ENABLED=true
PUBLIC_API_BASE_URL=https://api.example
OWNER_API_BASIC_USERNAME=owner
OWNER_API_KEY_SHA256=<sha256-hex-de-la-clave-owner>

# Alternativa o mecanismo adicional:
FIREBASE_PROJECT_ID=<firebase-project-id>
FIREBASE_OWNER_UIDS=<uid-owner-1>,<uid-owner-2>
```

En producción `PUBLIC_API_BASE_URL` es obligatorio cuando la documentación está habilitada. Debe
ser un origen HTTP(S) sin credenciales, path, query ni fragmento. No se infiere desde `Host` o
`X-Forwarded-Host`, evitando publicar un host inyectado.

`SWAGGER_ENABLED` se acepta temporalmente como alias de compatibilidad, pero el nombre nuevo es
`API_DOCUMENTATION_ENABLED`. La UI de Swagger no se instala: Scalar consume `/openapi.json` y su
bundle CDN está fijado a una versión exacta, con telemetría deshabilitada y CSP explícita.

## Autenticación owner

El servidor exige al menos uno de estos mecanismos antes de arrancar:

- `X-API-Key: <clave>`: la configuración conserva sólo `OWNER_API_KEY_SHA256`.
- HTTP Basic: usuario `OWNER_API_BASIC_USERNAME` (`owner` por defecto) y la misma clave como
  contraseña. Es la opción cómoda para abrir `/docs` en un navegador; el navegador reutiliza la
  credencial al cargar `/openapi.json`.
- `Authorization: Bearer <Firebase ID token>`: Firebase Admin valida firma, audiencia/proyecto y
  revocación; además, el `uid` debe pertenecer a `FIREBASE_OWNER_UIDS`.

Basic y `X-API-Key` son dos transportes para el mismo secreto de bootstrap. Se recomienda una clave
aleatoria de alta entropía y rotarla ante cualquier sospecha. Para Firebase, el proceso necesita
Application Default Credentials válidas, normalmente mediante `GOOGLE_APPLICATION_CREDENTIALS` o
la identidad administrada de la plataforma.

Ejemplos:

```bash
curl -H "X-API-Key: $OWNER_API_KEY" https://api.example/v1/professionals
curl -u "owner:$OWNER_API_KEY" https://api.example/docs
curl -H "Authorization: Bearer $FIREBASE_ID_TOKEN" https://api.example/openapi.json
```

Una credencial ausente, inválida, revocada o perteneciente a otro UID devuelve `401` sin revelar
qué verificación falló. Las respuestas autenticadas y la documentación usan
`Cache-Control: private, no-store`.

## Recursos de negocio

### Buscar profesionales

```http
GET /v1/professionals?q=ana&limit=20&cursor=<opaco>
```

| Parámetro | Tipo            | Regla                         |
| --------- | --------------- | ----------------------------- |
| `q`       | string opcional | máximo 200 caracteres         |
| `cursor`  | string opcional | opaco, máximo 1000 caracteres |
| `limit`   | entero opcional | 1–50; default 20              |

La búsqueda devuelve únicamente campos del DTO público. El cursor no debe decodificarse ni
construirse en el cliente.

### Obtener un perfil

```http
GET /v1/professionals/{idOrSlug}
```

Acepta UUID público, slug actual o slug histórico. El detalle incluye evidencia de procedencia
aprobada. Una coincidencia de nombre o slug no prueba por sí sola identidad fuera de este catálogo.

### Obtener títulos registrados

```http
GET /v1/professionals/{professionalId}/credentials
```

Solo devuelve títulos `ENABLED` cuya evidencia y fuente están aprobadas y vigentes. No informa
causas de inhabilitación, antecedentes, noticias, rankings ni evaluaciones clínicas.

### Obtener el dossier privado de investigación

```http
GET /v1/professionals/{idOrSlug}/research
```

Devuelve el último dossier persistido para el UUID público, slug actual o slug histórico. La
respuesta separa el registro oficial MSP de los candidatos encontrados en instituciones y otras
fuentes. Incluye:

- especialidades declaradas por la institución y carteleras horarias observadas;
- sede, dependencia, URL y fecha de observación;
- referencias académicas, web y cobertura de fuentes disciplinarias;
- método de coincidencia y flexibilidad 0/1/2;
- decisiones `identityConfirmed`, `factConfirmed`, `linkageDecision` y `publicationDecision`;
- alertas y una advertencia estable para el frontend.

El índice de flexibilidad mide cuánto se relajó la comparación del nombre; no es un porcentaje de
confianza. Una especialidad institucional no es un título registrado por MSP. Un horario es una
cartelera observada y `appointmentAvailability: "not_observed"` indica que la API no conoce cupos
ni disponibilidad en tiempo real. La ausencia de candidatos o cobertura no demuestra ausencia de
antecedentes.

La vista de lectura elimina IDs HMAC, query original, rutas locales, hashes de artefactos y otros
detalles operativos. El rol de PostgreSQL recibe `SELECT` únicamente sobre
`research_private.owner_professional_dossier`.

### Salud

```http
GET /health/live
GET /health/ready
```

`live` no consulta dependencias. `ready` verifica PostgreSQL y devuelve `503` si una dependencia
obligatoria no está disponible, sin exponer su error interno.

## Errores

Los errores usan RFC 9457:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "One or more request fields are invalid.",
  "instance": "/v1/professionals?limit=0",
  "traceId": "c0a80101-7b7f-4f8c-9c84-38ae19fc5a22",
  "errors": ["limit must not be less than 1"]
}
```

Media type: `application/problem+json`. `traceId` coincide con `x-request-id`. Nunca se devuelven
stack traces, SQL, credenciales ni mensajes del proveedor.

Un acceso sin credencial owner devuelve:

```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Owner authentication is required.",
  "instance": "/v1/professionals",
  "traceId": "c0a80101-7b7f-4f8c-9c84-38ae19fc5a22"
}
```

## Versionado

- El path `/v1` representa la versión mayor.
- Agregar campos opcionales es compatible.
- Quitar o renombrar campos, cambiar semántica, estados o tipos exige una nueva versión mayor.
- El OpenAPI versionado en [`openapi/public-api.json`](../openapi/public-api.json) debe cambiar en el
  mismo pull request que el runtime.

Generación y verificación:

```bash
corepack pnpm openapi:generate
corepack pnpm openapi:check
```

La generación usa una URL y base PostgreSQL sintéticas; no conecta a una base ni incluye datos
reales.

## Límites y seguridad

- body máximo fijo: 1 MiB;
- CORS sin credenciales y con allowlist;
- rate limit configurable por instancia, con buckets separados para anónimos y para el digest
  SHA-256 de cada credencial owner (la clave nunca se almacena en claro);
- `trustProxy=false` hasta configurar explícitamente el proxy;
- Helmet, compresión y UUID de solicitud generado por el servidor;
- usuario PostgreSQL de la API con `SELECT` sólo sobre vistas de lectura `security_barrier`;
- pool de investigación separado y forzado a transacciones de sólo lectura.

El contrato declara únicamente los mecanismos habilitados en el proceso, como alternativas (`OR`),
y marca health con `security: []`. Basic se habilita sólo en `public-query-api` para navegar Scalar;
`command-api` no lo registra ni lo anuncia. Cada operación protegida documenta su respuesta `401`
como `application/problem+json`. El hook de autenticación se ejecuta en Fastify antes de resolver
rutas, por lo que también cubre Scalar, OpenAPI, API catalog, RSD y rutas inexistentes; no depende
únicamente de los guards de controladores Nest.

## Disclaimer de datos

La respuesta representa el último corte aprobado, no estado en tiempo real. Debe verificarse ante
la fuente oficial. No constituye consejo médico, recomendación profesional, calificación de
calidad, determinación de identidad ni asesoramiento jurídico.
