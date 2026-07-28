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
6. genera candidatos de vinculación en cuarentena;
7. construye un snapshot factual interno.

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

La carga transaccional de una exportación aprobada a PostgreSQL debe implementarse como un adaptador
independiente antes de poder afirmar que la API se actualiza sola. Hasta entonces el cron refresca
la zona de investigación y el catálogo público continúa con el último release aprobado.

## Variables

Parta de [`deployment/cron/daily-refresh.env.example`](../deployment/cron/daily-refresh.env.example)
y complete los secretos fuera del repositorio.

| Variable                              | Default     | Uso                                       |
| ------------------------------------- | ----------- | ----------------------------------------- |
| `DATA_INGESTION_DIR`                  | `data`      | raíz común de artefactos                  |
| `MSP_LINKAGE_HMAC_KEY`                | sin default | seudonimización interna del documento MSP |
| `DAILY_REFRESH_MUTUALISTAS`           | todas       | allowlist CSV de adaptadores              |
| `DAILY_REFRESH_NEWS_ENABLED`          | `true`      | habilita índices con política vigente     |
| `DAILY_REFRESH_PUBLIC_EXPORT_ENABLED` | `false`     | agrega el exportador firmado              |
| `CRAWL4AI_BASE_URL`                   | adaptador   | servicio Crawl4AI autorizado              |

Los booleanos deben ser explícitos (`true/false`, `1/0`, `yes/no`, `on/off`). Un nombre de
mutualista desconocido aborta antes de descargar.

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
