# Actualización diaria de fuentes

`data:refresh:daily` ejecuta un pipeline secuencial y fail-fast. Su objetivo es actualizar
artefactos internos auditables; no importa automáticamente datos a PostgreSQL ni publica
coincidencias.

## Plan por defecto

1. crea las zonas locales de datos;
2. elimina artefactos de noticias vencidos;
3. descarga y valida Infotítulos del MSP;
4. ejecuta los adaptadores habilitados de CASMU, Asociación Española, SMI, Médica Uruguaya y
   Hospital Británico;
5. lee únicamente índices de noticias autorizados;
6. genera candidatos de noticias en cuarentena a partir del lote recién recolectado;
7. genera candidatos de vinculación institucional;
8. construye un snapshot factual interno.

Los metadatos públicos del Tribunal de Ética del Colegio Médico no forman parte de este
orquestador. En servidor 104 los recolecta `medicos-private-analysis`, bajo su propio lock,
inmediatamente antes del análisis privado diario. No agregue un segundo cron para CMU: produciría
snapshots duplicados y dificultaría atribuir fallos de política o cobertura.

El plan puede inspeccionarse sin red ni escritura:

```bash
corepack pnpm data:refresh:daily:plan
```

## Frontera de publicación

`DAILY_REFRESH_PUBLIC_EXPORT_ENABLED=false` es el valor seguro y recomendado. Si se cambia a
`true`, se agrega `data:build:public-directory` al final. Ese comando igualmente exige política
canónica aprobada, firma Ed25519, huella de clave anclada, secretos independientes, snapshot exacto
y vigencia. Si falta cualquier control, falla sin producir una exportación.

El pipeline declara explícitamente:

- no confirmar identidades automáticamente;
- no publicar noticias, sanciones o hechos adversos;
- no mutar la base de la API;
- no convertir un score de revisión en probabilidad.

La proyección transaccional mínima MSP está implementada como
`data:sync:msp-catalog` y se ejecuta en el scheduler PM2 después de un análisis correcto. Consume
exclusivamente el último snapshot privado completo y una aprobación operativa explícita; no
proyecta candidatos ni fuentes web. El identificador del snapshot queda fijado en el entorno y la
función rechaza cualquier lote distinto, aunque sea más reciente. Este pipeline diario de
recolección todavía no importa por sí
mismo el nuevo snapshot a PostgreSQL: esa transferencia verificada debe terminar antes de ejecutar
la proyección. Tras el `COMMIT`, el mismo proceso actualiza las estadísticas del planificador sobre
un conjunto fijo de tablas mediante una función de privilegio mínimo. Un fallo de `ANALYZE` marca la
ejecución como fallida, pero no intenta revertir la proyección ya confirmada; el siguiente cron
idempotente repite la actualización.

## Variables

Parta de [`deployment/cron/daily-refresh.env.example`](../deployment/cron/daily-refresh.env.example)
y complete los secretos fuera del repositorio.

| Variable                              | Default     | Uso                                       |
| ------------------------------------- | ----------- | ----------------------------------------- |
| `DATA_INGESTION_DIR`                  | `data`      | raíz común de artefactos                  |
| `MSP_LINKAGE_HMAC_KEY`                | sin default | seudonimización interna del documento MSP |
| `NODE_EXTRA_CA_CERTS`                 | del sistema | CA adicional oficial si el host la omite  |
| `DAILY_REFRESH_MUTUALISTAS`           | todas       | allowlist CSV de adaptadores              |
| `DAILY_REFRESH_NEWS_ENABLED`          | `true`      | habilita índices con política vigente     |
| `DAILY_REFRESH_PUBLIC_EXPORT_ENABLED` | `false`     | agrega el exportador firmado              |
| `CRAWL4AI_BASE_URL`                   | adaptador   | servicio Crawl4AI autorizado              |

Los booleanos deben ser explícitos (`true/false`, `1/0`, `yes/no`, `on/off`). Un nombre de
mutualista desconocido aborta antes de descargar.

No use `MSP_ALLOW_INSECURE_TLS=true` para resolver una cadena incompleta. Instale la CA oficial en
el almacén del sistema o configure `NODE_EXTRA_CA_CERTS` con un archivo verificado, de propiedad de
root y no escribible por el usuario del servicio. La variable debe existir antes de iniciar cada
proceso Node; el orquestador diario la hereda a todas las etapas.

## Estado y observabilidad

Cada transición actualiza:

```text
<DATA_INGESTION_DIR>/logs/daily-refresh/latest.json
```

El archivo tiene modo `0600` e incluye `runId`, estado global, timestamps, etapa fallida, exit code
y fronteras de publicación. No incluye registros médicos, nombres ni secretos.

Eventos JSON se escriben a stdout/stderr:

- `daily_refresh_stage_started`;
- `daily_refresh_stage_completed`;
- `daily_refresh_completed`;
- `daily_refresh_failed`.

Una etapa no-cero detiene el ciclo. Los adaptadores instalan artefactos completos mediante
directorios inmutables/renombres; una falla no reemplaza el último snapshot válido.

## Opción A: cron clásico

Instalación sugerida:

```bash
sudo install -d -o medicos -g medicos -m 0700 /var/lib/medicos-backend
sudo install -d -o root -g medicos -m 0750 /etc/medicos-backend
sudo install -o root -g medicos -m 0640 \
  deployment/cron/daily-refresh.env.example \
  /etc/medicos-backend/daily-refresh.env
sudo install -o root -g root -m 0755 \
  deployment/cron/medicos-daily-refresh.sh \
  /usr/local/sbin/medicos-daily-refresh
```

Complete `/etc/medicos-backend/daily-refresh.env`. El wrapper rechaza un archivo que no sea de
root o sea escribible por grupo/otros, valida directorio/binario y usa `flock` para impedir
solapamientos.

Archivo `/etc/cron.d/medicos-daily-refresh`:

```cron
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=America/Montevideo
17 3 * * * medicos /usr/local/sbin/medicos-daily-refresh
```

## Opción B: systemd timer

```bash
sudo install -o root -g root -m 0644 \
  deployment/systemd/medicos-daily-refresh.service \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 \
  deployment/systemd/medicos-daily-refresh.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now medicos-daily-refresh.timer
```

El timer corre a las 03:17 con retraso aleatorio de hasta 15 minutos y `Persistent=true`, por lo
que recupera una ejecución omitida. Configure el host en `America/Montevideo` si su versión de
systemd no admite zona horaria dentro de `OnCalendar`.

Active cron o systemd, nunca ambos. Ambos usan el mismo lock, pero duplicar schedulers dificulta
operación y alertas.

## Verificación

```bash
systemctl list-timers medicos-daily-refresh.timer
systemctl start medicos-daily-refresh.service
journalctl -u medicos-daily-refresh.service -n 200 --no-pager
cat /var/lib/medicos-backend/data/logs/daily-refresh/latest.json
```

Para cron:

```bash
sudo -u medicos /usr/local/sbin/medicos-daily-refresh
```

## Fallas y recuperación

- Fuente temporalmente caída: conserve el último artefacto válido; no fuerce un snapshot parcial.
- Cambio de HTML/CSV: actualice parser y fixture sintético, luego ejecute tests.
- Política o autorización vencida: mantenga la fuente/publicación deshabilitada.
- Ejecución superpuesta: `flock` registra y omite la segunda.
- Secreto expuesto: deshabilite el job, rote la clave y considere inválidos los artefactos
  derivados.
- Disco lleno: libere únicamente artefactos vencidos según política; no borre el último release
  aprobado sin backup.

No se recomienda GitHub Actions para este cron: obligaría a trasladar secretos y potenciales datos
personales a runners externos o abrir PostgreSQL a rangos cambiantes. GitHub Actions se limita a CI
con fixtures sintéticos.

## Enriquecimiento web opcional

Mantenga `DAILY_REFRESH_WEB_ENRICHMENT_ENABLED=false` hasta instalar fuera del repositorio una
política vigente en `WEB_ENRICHMENT_SOURCE_POLICY_PATH`. Antes de habilitar el cron:

```bash
sudo -u medicos pnpm data:enrich:web:plan
sudo -u medicos pnpm data:enrich:web:tick
```

Compruebe que el manifiesto declara `publicExportAllowed=false`, que `coverage.ndjson` tiene una
fila por perfil MSP y que una falla de fuente se representa como `PARTIAL_SOURCE_FAILURE`. La etapa
es interna y no es entrada de `data:build:directory`.
