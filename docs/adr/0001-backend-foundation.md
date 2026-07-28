# ADR-0001 — Fundación ejecutable del backend

- Estado: aceptada
- Fecha: 2026-07-26

## Contexto

El producto necesita integrar fuentes oficiales, conservar procedencia, permitir correcciones y
eventualmente aceptar experiencias de pacientes. También contiene áreas con riesgos jurídicos y de
privacidad distintos. La fundación debe facilitar crecimiento sin convertir desde el inicio cada
concepto en un servicio distribuido.

## Decisión

Se adopta un monolito modular en un workspace pnpm, con tres composition roots:

- API pública de consultas;
- API separada para futuros comandos autenticados;
- worker standalone de catálogo.

Cada módulo aplica arquitectura hexagonal:

- dominio sin dependencias de framework;
- casos de uso y puertos en aplicación;
- adaptadores en infraestructura y presentación;
- ensamblaje de Nest exclusivamente en composition roots.

Las reglas se verifican automáticamente con TypeScript estricto, ESLint type-aware y
dependency-cruiser.

El primer corte vertical es `professionals`: búsqueda pública y detalle por UUID o slug mediante
puertos semánticos y un adaptador Drizzle. `provenance` registra fuente, release y evidencia; el
detalle publicado expone una referencia segura a esa evidencia.

PostgreSQL impone la FK entre el nombre del profesional y su evidencia. La restricción
intermodular se declara en la migración SQL, no mediante una importación de las tablas Drizzle de
otro módulo.

La API pública no recibe acceso a tablas base. Usa un rol lector con permisos explícitos sobre
vistas `security_barrier`, las cuales publican sólo perfiles `PUBLIC` respaldados por evidencia
`APPROVED`. Toda evidencia nueva queda `PENDING` por defecto. Los roles globales se provisionan
fuera de las migraciones de esquema; éstas sólo aplican permisos sobre roles preexistentes.

## Decisiones asociadas

- NestJS con Fastify para HTTP.
- PostgreSQL como fuente de verdad y Drizzle sólo en infraestructura.
- REST versionado y errores `application/problem+json`.
- UUID de correlación generado por el servidor y compartido entre respuesta, error y log.
- logs sin URL, parámetros, headers ni bodies para evitar registrar búsquedas o credenciales.
- procesos públicos y de comandos separados desde el inicio.
- Queue Redis durable y Cache Redis evictable físicamente separados.
- migraciones generadas, revisadas y almacenadas; nunca sincronización automática en producción.
- fixtures exclusivamente sintéticos.
- no crear bounded contexts vacíos.

## Consecuencias

### Positivas

- Los casos de uso se prueban sin levantar Nest ni PostgreSQL.
- Las direcciones de dependencia son ejecutables, no una convención informal.
- La API pública puede desplegarse con una identidad de base de datos limitada a proyecciones
  publicables.
- Los módulos se pueden extraer más adelante si seguridad, escala o equipos lo justifican.
- Toda evolución del esquema deja una migración auditable.

### Costos

- Existen más paquetes y archivos que en una aplicación Nest plana.
- Cada nueva capacidad requiere diseñar sus puertos antes de conectar SDKs.
- Las restricciones SQL entre módulos deben revisarse manualmente.
- Los tests de integración requieren Docker.
- El rate limit local no sustituye un control distribuido en el edge.
- La búsqueda inicial debe evolucionar a trigramas/FTS antes de cargar el padrón completo.

## Límites deliberados de esta entrega

La API de comandos y el worker sólo poseen bootstrap, configuración, observabilidad y health donde
aplica. No se implementa una autenticación Firebase parcial, una cola ficticia ni módulos vacíos de
reseñas/moderación.

El historial judicial permanece fuera de cualquier API pública. Su eventual investigación requiere
una decisión jurídica posterior, almacenamiento aislado y aprobación humana según la arquitectura
general.
