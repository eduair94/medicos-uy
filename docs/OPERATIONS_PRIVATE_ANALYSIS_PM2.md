# Análisis privado completo con PM2

La misma definición PM2 también ejecuta la API pública de solo lectura como
`medicos-public-query-api`. Su archivo de entorno es
`/etc/medicos-backend/public-query-api.env` (`root:root`, modo `0600`) y el proceso exige
`PUBLIC_QUERY_API_HOST=127.0.0.1` para quedar accesible únicamente mediante el origen local del
túnel:

```text
http://127.0.0.1:3001
```

Con el hostname definitivo configurado en `PUBLIC_API_BASE_URL`, la documentación queda publicada
en `/docs`, el contrato en `/openapi.json`, el catálogo en `/.well-known/api-catalog` y RSD en
`/rsd.xml`.

Este proceso ejecuta dos etapas fail-fast. Primero construye y persiste el análisis interno de
todos los profesionales del snapshot MSP seleccionado. Si esa etapa termina correctamente, proyecta
al catálogo público **únicamente** nombre y títulos oficiales de Infotítulos, con evidencia,
claims, vigencia y rutas estables. No publica candidatos, agendas, noticias, sanciones ni resultados
del análisis privado; tampoco confirma identidades a partir de coincidencias flexibles.

PM2 mantiene un único scheduler vivo. El proceso ejecuta el batch una vez al iniciar o reiniciar y
luego queda inactivo. `cron_restart` lo reinicia diariamente a las **06:37 UTC**, equivalentes a
las **03:37 de America/Montevideo**. La expresión usa UTC porque ésa es la zona del daemon PM2 en el
servidor 104.

## Controles incorporados

- una sola instancia, modo `fork`;
- lock local no bloqueante durante el batch y lock asesor de PostgreSQL como autoridad entre hosts;
- estado atómico, sin datos personales, en
  `/var/lib/medicos-backend/logs/private-analysis/latest.json`;
- `SIGTERM`/`SIGINT` se reenvían al batch y PM2 concede 120 segundos antes de terminar el árbol;
- máximo PM2 de 1536 MiB y heap Node de 1024 MiB;
- un error del batch queda registrado y el scheduler espera el próximo cron, sin bucle de reinicios;
- credenciales únicamente en un archivo `root:root 0600` externo al checkout;
- la proyección MSP exige aprobación explícita, referencia oficial y responsable de la revisión;
- evidencia inmutable por snapshot, vencimiento a 62 días del corte y supresión de ausentes;
- una reaparición sólo revierte una supresión automática si nadie moderó la fila mientras estuvo
  ausente; `DISABLED` y `UNDER_REVIEW` nunca son reactivados por el scheduler;
- `CMU_ETHICS_FETCH_ENABLED=false` es obligatorio y el wrapper aborta si alguien intenta activarlo.

La
[página oficial de fallos del Tribunal de Ética](https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/)
puede conservarse como cobertura o referencia curada. Este job no descarga automáticamente el
índice, las páginas de fallo ni sus PDF: el
[`robots.txt` oficial](https://www.colegiomedico.org.uy/robots.txt) bloquea esas rutas. La ausencia
de un vínculo curado tampoco prueba que una persona carezca de antecedentes.

## Preparar código, usuario y directorios

Ejecute primero las migraciones y el import privado del mismo snapshot factual. No habilite el
scheduler si `ingestion_private.professional_profile` no contiene el universo MSP esperado.

```bash
sudo install -d -o root -g root -m 0700 \
  /var/lib/medicos-backend \
  /srv/medicos-backend/data \
  /var/lib/medicos-backend/logs \
  /var/lib/medicos-backend/logs/private-analysis
sudo install -d -o root -g root -m 0700 /etc/medicos-backend
sudo install -d -o root -g root -m 0750 /var/log/medicos-backend

sudo install -o root -g root -m 0600 \
  deployment/pm2/private-analysis.env.example \
  /etc/medicos-backend/private-analysis.env
```

Complete `/etc/medicos-backend/private-analysis.env` sin cambiar propietario ni modo. Fije
`PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID` al snapshot ya importado, y configure la CA y el DNS
del certificado en `PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH` y
`PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME`. El release debe conservar su ejecutable Linux
`node_modules/.bin/tsx`; no dependa de un `pnpm` global inexistente en el host. Nunca copie la
contraseña a la línea de comandos, al ecosistema o al log.

Complete además `MSP_CATALOG_PROJECTION_APPROVAL=PROJECT_OFFICIAL_MSP_FIELDS`,
`MSP_CATALOG_PROJECTION_REVIEWED_BY` con el identificador del operador o cambio aprobado y
`MSP_CATALOG_PROJECTION_REVIEWED_AT` con la fecha UTC ISO-8601 exacta de esa aprobación, y
`MSP_CATALOG_PROJECTION_REVIEW_REFERENCE` con la URL oficial exacta de Infotítulos. La función
PostgreSQL se ejecuta con privilegios definidos y el rol de ingesta conserva acceso directo
revocado sobre `catalog`, `credentials`, `provenance` y las tablas privadas de mapeo.

## Sincronizar los datos sin aceptar un lote parcial

Los artefactos personales no pertenecen a Git. Sincronice a un directorio temporal del mismo
filesystem y renómbrelo sólo cuando todos los hashes y conteos coincidan. No ejecute `rsync
--delete` directamente sobre el último lote válido.

Use
[`deployment/pm2/data-sync-manifest.example.json`](../deployment/pm2/data-sync-manifest.example.json)
como acta externa de cada transferencia:

1. registre el commit exacto desplegado;
2. liste el manifiesto y payload de MSP, linkage, enriquecimiento web y referencias curadas;
3. calcule `sha256sum` en origen y nuevamente en el servidor;
4. compare `records` con el conteo físico NDJSON y con el manifiesto de cada productor;
5. compruebe que todos los paths resuelven debajo de `/srv/medicos-backend/data`;
6. marque `completedAt` sólo después del rename atómico.

El acta contiene hashes y conteos, nunca nombres, snippets, URLs privadas ni secretos. Guárdela por
ejecución, por ejemplo en `/srv/medicos-backend/data/manifests/sync/`, y conserve el último lote
válido hasta verificar la carga. El batch vuelve a validar los manifiestos productores; el acta de
sync es evidencia operacional adicional, no sustituye esas validaciones.

Verificación mínima antes de iniciar PM2:

```bash
cd /srv/medicos-backend/current
find /srv/medicos-backend/data -type f -name manifest.json -print
sha256sum /srv/medicos-backend/data/processed/*/*/manifest.json
test "$(stat -c '%U:%G %a' /etc/medicos-backend/private-analysis.env)" = "root:root 600"
test -r /etc/medicos-backend/private-analysis.env
test -w /var/lib/medicos-backend/logs/private-analysis
```

Seleccione explícitamente los paths en el env para un replay. Déjelos vacíos sólo cuando el
selector del batch deba tomar el último manifiesto completo y compatible. Nunca apunte a un
directorio que aún recibe archivos.

## Instalar y habilitar en PM2 6

Use el daemon PM2 6 existente, que en servidor 104 corre como root y en UTC. No cree un segundo
`PM2_HOME` ni agregue `uid`/`gid` no verificados al ecosistema.

```bash
cd /srv/medicos-backend/current
pm2 start deployment/pm2/ecosystem.config.cjs --only medicos-private-analysis
pm2 save
pm2 describe medicos-private-analysis
```

No instale simultáneamente cron clásico ni un timer systemd para este batch. El lock evita
solapamientos accidentales, pero dos schedulers dificultan alertas, ownership y recuperación.

El primer `pm2 start` ejecuta el análisis de inmediato. Para instalar sin afectar una ventana de
producción, prepare primero datos, migraciones y credenciales, y haga el `start` sólo dentro de la
ventana acordada.

## Verificación viva

```bash
pm2 status medicos-private-analysis
pm2 logs medicos-private-analysis --lines 200 --nostream
cat /var/lib/medicos-backend/logs/private-analysis/latest.json

# Debe haber una sola fila online y cron 37 6 * * *.
pm2 jlist | jq '.[] | select(.name == "medicos-private-analysis") |
  {status: .pm2_env.status, instances: .pm2_env.instances,
   exec_mode: .pm2_env.exec_mode, cron_restart: .pm2_env.cron_restart}'
```

Después de una ejecución completa, contraste PostgreSQL usando un rol privado de sólo lectura o una
transacción read-only:

```sql
SELECT status, count(*) FROM research_private.work_item
WHERE run_id = (SELECT run_id FROM research_private.analysis_run
                ORDER BY created_at DESC LIMIT 1)
GROUP BY status ORDER BY status;

SELECT run_id, snapshot_id, status, started_at, heartbeat_at, completed_at
FROM research_private.analysis_run
ORDER BY created_at DESC LIMIT 5;

SELECT count(*) FROM catalog.public_professional;
SELECT count(*) FROM catalog.public_professional_route WHERE route_kind = 'CURRENT';
SELECT count(*) FROM credentials.public_registered_title;
SELECT count(*) FROM provenance.public_evidence_ref;
```

Los totales terminales deben reconciliar con el número de perfiles del snapshot privado. Revise
separadamente `FAILED`, `PARTIAL`, candidatos no adjudicados y cobertura de fuentes; no interprete
`NO_CANDIDATE` como “sin antecedentes”. La proyección es idempotente: repetir el mismo snapshot no
crea UUID, rutas ni evidencia duplicados. Un snapshot posterior conserva identidad pública,
revoca la evidencia anterior y suprime perfiles ausentes. Una reaparición reactiva únicamente una
supresión automática intacta; cualquier intervención posterior del operador conserva
`SUPPRESSED`.

## Operación y recuperación

- Ejecución manual controlada: `pm2 restart medicos-private-analysis`.
- Detener sin borrar configuración: `pm2 stop medicos-private-analysis`.
- Cambio de env: edite el archivo root:root 0600 y luego haga un único `pm2 restart`; no use
  `--update-env` para inyectar secretos.
- `SKIPPED_OVERLAP`: identifique el dueño del lock y el run PostgreSQL antes de reiniciar.
- `FAILED`: conserve artefactos y último dossier válido, corrija la causa y reinicie una sola vez.
- `INTERRUPTED`: confirme que el lease/advisory lock expiró o fue liberado antes del replay.
- Presión de memoria: no aumente límites a ciegas; reduzca `PROFESSIONAL_ANALYSIS_BATCH_SIZE` y mida.
- Rotación de credenciales: detenga PM2, rote la contraseña, actualice el archivo 0600 y reinicie.

Para retirar el scheduler:

```bash
pm2 stop medicos-private-analysis
pm2 delete medicos-private-analysis
pm2 save
```

Esto no borra dossiers, manifests ni logs. Su retención y eventual supresión deben seguir la
política privada y el procedimiento de derechos aplicable.
