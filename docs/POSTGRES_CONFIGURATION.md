# Configuración PostgreSQL

La aplicación no contiene un host, usuario o contraseña PostgreSQL por defecto. Cada operación usa
una variable distinta para mantener privilegio mínimo:

| Variable                         | Consumidor           | Privilegios esperados                           |
| -------------------------------- | -------------------- | ----------------------------------------------- |
| `CATALOG_DATABASE_URL`           | `public-query-api`   | `CONNECT` y `SELECT` solo sobre vistas públicas |
| `CATALOG_MIGRATION_DATABASE_URL` | Drizzle Kit          | DDL sobre los esquemas del catálogo             |
| `CATALOG_SEED_DATABASE_URL`      | seed sintético local | escritura de fixtures; nunca producción         |

Formato:

```dotenv
CATALOG_DATABASE_URL=postgresql://usuario:password@db.example:6432/medicos_catalog
```

Los caracteres reservados de usuario/password deben codificarse con percent-encoding. No coloque
el URL real en Dockerfile, Compose versionado, systemd unit, argumentos de proceso o GitHub
Actions. Guárdelo en el secret manager del entorno o en un archivo `EnvironmentFile` externo con
permisos restrictivos.

## Runtime

```dotenv
CATALOG_DATABASE_POOL_MAX=10
CATALOG_DATABASE_SSL=true
```

Con SSL habilitado, `node-postgres` usa `rejectUnauthorized=true`. La CA que firmó el certificado
del servidor debe estar instalada en el trust store del sistema/contendor. No se admite un modo
inseguro que omita la validación.

El pool fija:

- conexión: 3 segundos;
- statement timeout: 10 segundos;
- idle timeout: 30 segundos;
- `application_name` igual al servicio.

`/health/ready` ejecuta una consulta de metadatos sobre la vista pública y falla sin revelar el
error de conexión.

## Migraciones

```bash
export CATALOG_MIGRATION_DATABASE_URL='postgresql://...'
corepack pnpm db:migrate:catalog
```

La variable es obligatoria incluso en desarrollo; se eliminó todo fallback embebido. Revise y
versione SQL generado. No use `drizzle-kit push` en entornos compartidos.

## Seed

```bash
export NODE_ENV=development
export ALLOW_SYNTHETIC_SEED=true
export CATALOG_SEED_DATABASE_URL='postgresql://...'
corepack pnpm db:seed:catalog
```

El seed se niega en producción y contiene solo personas/URLs sintéticas.

## Docker local

Copie `.env.example` a `.env` y cambie sus contraseñas de ejemplo. Compose exige
`POSTGRES_SUPERUSER_PASSWORD` y `POSTGRES_PUBLIC_QUERY_PASSWORD`; el init crea el rol lector a
partir del entorno. Estos scripts solo corren al crear un volumen nuevo.

```bash
corepack pnpm infra:up
corepack pnpm db:migrate:catalog
```

## Checklist remoto

1. PostgreSQL escucha únicamente en interfaces y puerto previstos.
2. Firewall/HBA permiten solo orígenes necesarios.
3. Autenticación SCRAM y TLS con verificación completa.
4. Rol de la API sin superuser, DDL, escritura, `CREATE` ni acceso a tablas base.
5. Contraseña aleatoria rotada y distribuida por secret manager.
6. Backup cifrado, off-site, con retención y prueba de restauración.
7. Logs con rotación y sin parámetros/consultas sensibles.
8. Monitorización de conexiones, storage, replication/PITR y expiración del certificado.

El paquete operativo del servidor real se mantiene fuera de este repositorio porque contiene
topología, reglas y material específico. El código público ofrece contratos genéricos, no una copia
de infraestructura privada.
