# API pública

La API es REST, versionada por URI, de solo lectura y anónima. El contrato canónico es OpenAPI
3.0 y se genera desde los mismos controladores y DTO que atienden las solicitudes.

## Superficies

| Recurso                             | Media type                 | Finalidad                     |
| ----------------------------------- | -------------------------- | ----------------------------- |
| `GET /openapi.json`                 | `application/json`         | contrato legible por máquinas |
| `GET /docs`                         | `text/html`                | referencia interactiva Scalar |
| `GET/HEAD /.well-known/api-catalog` | `application/linkset+json` | descubrimiento RFC 9727       |
| `GET /rsd.xml`                      | `application/rsd+xml`      | compatibilidad RSD solicitada |
| `GET /.well-known/rsd.xml`          | `application/rsd+xml`      | alias well-known de RSD       |

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
```

En producción `PUBLIC_API_BASE_URL` es obligatorio cuando la documentación está habilitada. Debe
ser un origen HTTP(S) sin credenciales, path, query ni fragmento. No se infiere desde `Host` o
`X-Forwarded-Host`, evitando publicar un host inyectado.

`SWAGGER_ENABLED` se acepta temporalmente como alias de compatibilidad, pero el nombre nuevo es
`API_DOCUMENTATION_ENABLED`. La UI de Swagger no se instala: Scalar consume `/openapi.json` y su
bundle CDN está fijado a una versión exacta, con telemetría deshabilitada y CSP explícita.

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
- rate limit configurable por instancia;
- `trustProxy=false` hasta configurar explícitamente el proxy;
- Helmet, compresión y UUID de solicitud generado por el servidor;
- usuario PostgreSQL de la API con `SELECT` solo sobre vistas públicas `security_barrier`.

La API no requiere Bearer token y por eso el contrato no declara un esquema de autenticación. Las
futuras operaciones autenticadas deben vivir en el command API, no ampliar implícitamente este
contrato anónimo.

## Disclaimer de datos

La respuesta representa el último corte aprobado, no estado en tiempo real. Debe verificarse ante
la fuente oficial. No constituye consejo médico, recomendación profesional, calificación de
calidad, determinación de identidad ni asesoramiento jurídico.
