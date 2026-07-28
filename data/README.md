# Directorio de datos local

Este directorio es una zona de trabajo local para artefactos de ingestión. Los snapshots,
manifiestos, candidatos de vinculación, cuarentenas y logs pueden contener datos personales y
no se versionan ni se publican como artefactos de CI.

La estructura se crea con:

```bash
corepack pnpm data:setup
```

Consulte [`docs/DATA_INGESTION.md`](../docs/DATA_INGESTION.md) para conocer el contrato de cada
zona, la retención y los gates de publicación.
