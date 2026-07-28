# Importación privada del directorio factual

Este comando carga un snapshot `factual-v3` únicamente en las tablas de staging
`ingestion_private.snapshot` e `ingestion_private.professional_profile`. No escribe en `catalog`,
`credentials` ni `provenance`, y no habilita ninguna vista o exportación pública.

## Migración

El esquema privado forma parte del flujo ordenado del catálogo:

```powershell
$env:CATALOG_MIGRATION_DATABASE_URL = 'postgresql://medicos_migrator:...@host:5432/medicos_catalog'
pnpm db:migrate:catalog
```

La migración `0005_young_namora.sql` revoca acceso al esquema, sus objetos actuales y sus
privilegios por defecto para `PUBLIC` y `medicos_catalog_reader`. El importador exige el rol
dedicado `medicos_private_ingestor`; no admite el rol bootstrap, el migrador ni las cuentas
lectoras. Ese rol no debe tener membresías ni ser propietario de objetos; recibe únicamente
`CONNECT`, `USAGE` y `SELECT/INSERT` sobre las dos tablas privadas.

## Aprobación e importación

Calcule y revise el SHA-256 del manifiesto exacto que desea cargar. Después configure:

```dotenv
PRIVATE_DIRECTORY_IMPORT_APPROVAL=IMPORT_TO_PRIVATE_STAGING_ONLY
PRIVATE_DIRECTORY_EXPECTED_SNAPSHOT_ID=factual-v3-0123456789abcdef
PRIVATE_DIRECTORY_EXPECTED_MANIFEST_SHA256=<sha256-en-minúsculas>
PRIVATE_DIRECTORY_MANIFEST_PATH=<ruta-absoluta-al-manifest.json>
DATA_INGESTION_DIR=<ruta-absoluta-a-data>
PRIVATE_INGESTION_DATABASE_URL=postgresql://medicos_private_ingestor:<password>@<host>:5432/medicos_catalog
PRIVATE_INGESTION_DATABASE_SSL_CA_PATH=<ruta-absoluta-a-ca.pem>
PRIVATE_DIRECTORY_IMPORT_BATCH_SIZE=500
```

Ejecute:

```powershell
pnpm data:import:private-directory
```

El URL PostgreSQL no puede contener ningún query parameter ni fragmento. Esto evita que
`node-postgres` permita que opciones embebidas en el URL reemplacen la configuración segura del
cliente. El comando carga la CA indicada y usa TLS con `rejectUnauthorized=true`, incluida la
validación del hostname. En el servidor 104, la regla HBA del ingestor también debe ser `hostssl`.

Antes de conectarse verifica la aprobación literal, el ID y SHA-256 esperado del manifiesto, la
ruta canónica, el tipo `factual-v3`, el bloqueo de publicación, y el SHA-256 y cantidad de
`profiles.ndjson`. Durante la transacción vuelve a verificar que los archivos no cambiaron.

La escritura usa nivel `SERIALIZABLE`, un advisory lock transaccional, lotes parametrizados y
rollback integral. Repetir el mismo snapshot completo devuelve `already_imported`; reutilizar el
mismo ID con metadatos diferentes falla por colisión.

Cada fila conserva solamente:

- ID HMAC interno;
- nombre de presentación y nombre normalizado;
- títulos registrados;
- referencia del registro oficial;
- SHA-256 de la fila fuente.

Campos identificatorios crudos, perfiles que permitan exportación pública y contratos de entrada
desconocidos se rechazan. La existencia de estas filas no constituye autorización de publicación.
