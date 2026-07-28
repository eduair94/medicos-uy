# Vista privada de investigación por profesional

`data:research:professional` reúne evidencia ya recolectada sin modificar el directorio público ni
confirmar automáticamente identidades. La consulta puede hacerse por nombre flexible o por el ID
opaco del MSP:

```bash
pnpm data:research:professional -- --name "Tamara Diaz Sanz"
pnpm data:research:professional -- --id "msp_doc_v1_<sha256>"
```

El comando selecciona y valida los últimos manifiestos compatibles de MSP, linkage y
enriquecimiento web. Luego sigue los `sourceRecords` del linkage hasta los NDJSON de horarios. No
busca el nombre en los HTML crudos: las agendas CAAD contienen el catálogo completo dentro de un
`select`, que no prueba que el profesional corresponda a la página descargada.

## Referencias públicas curadas

La ruta predeterminada es:

```text
data/curation/professional-public-references.ndjson
```

Ese archivo queda fuera de Git por contener investigación nominal. Su formato está documentado en
`config/professional-public-references.example.ndjson`. Cada fila admite URL completa, título,
fecha, nombre observado, relación académica y una paráfrasis factual. Rechaza:

- cuerpo, HTML, fragmentos o citas copiadas de una fuente;
- cualquier decisión que confirme identidad, hecho, enlace o publicación;
- una referencia de LinkedIn que habilite descarga automatizada;
- documentos contextuales que no indiquen qué referencia nominada corroboran.

LinkedIn se conserva como `MANUAL_REFERENCE_NO_AUTOMATED_FETCH`. ResearchGate se limita a
metadatos y URL. Un documento oficial que no nombra al profesional puede corroborar el contexto de
un proyecto, pero aparece como `CONTEXT_CORROBORATION_ONLY`.

## Salida

Cada ejecución crea atómicamente:

```text
data/processed/professional-research/research-v1-<fecha>-<huella>/
  professional-research-view.json
  manifest.json
```

La vista contiene las URLs completas para consumo por una API privada y autenticada. Se mantiene
`publicExportAllowed: false` para evitar que candidatos no revisados entren accidentalmente al
directorio público; no impide mostrarlos al único usuario autorizado de la API privada.

Los índices `0`, `1` y `2` expresan soltura de la coincidencia (exacta, parcial, iniciales), no
probabilidad. El reporte devuelve todos los candidatos del mejor índice y declara ambigüedad si
hay más de uno.
