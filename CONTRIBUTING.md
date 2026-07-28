# Contribuir

Gracias por contribuir. Este proyecto combina software público con un dominio que puede afectar
derechos de personas, por lo que una mejora técnicamente correcta también debe conservar los
límites de privacidad, procedencia y publicación.

## Antes de abrir un cambio

1. Abra un issue para cambios de contrato, esquema, fuente o política de publicación.
2. No incluya nombres, documentos, horarios, noticias ni expedientes de personas reales en
   fixtures, capturas, logs, commits o pull requests.
3. Use identidades claramente sintéticas y dominios `example.invalid`.
4. No reduzca un gate de publicación, retención o revisión legal para hacer pasar una prueba.
5. Mantenga los adaptadores de ingesta compatibles con términos, robots, límites y autorizaciones
   de la fuente.

## Desarrollo

```bash
corepack pnpm install
cp .env.example .env
corepack pnpm infra:up
corepack pnpm db:migrate:catalog
corepack pnpm db:seed:catalog
corepack pnpm quality
```

En PowerShell use `Copy-Item .env.example .env`.

Para cambios de persistencia ejecute además:

```bash
corepack pnpm test:integration
```

Para cambios de contrato:

```bash
corepack pnpm openapi:generate
git diff -- openapi/public-api.json
```

## Convenciones

- TypeScript estricto y formato automático con Prettier.
- Dominio y aplicación no dependen de Nest, PostgreSQL ni adaptadores.
- Los controladores son delgados; las reglas viven en casos de uso.
- Nuevas dependencias deben tener una finalidad concreta y licencia compatible.
- Los errores HTTP públicos conservan el formato RFC 9457 y no exponen stacks ni errores del
  proveedor.
- Un cambio de fuente incluye pruebas de parser, procedencia, límites y comportamiento fail-closed.

## Pull request

Describa resultado, riesgo, migraciones, compatibilidad y reversión. Complete el checklist del
template. La CI debe quedar verde y el diff no debe contener artefactos bajo `data/`, `.env`,
credenciales, topología privada ni datos personales.

Al participar acepta cumplir el [código de conducta](./CODE_OF_CONDUCT.md) y licenciar su
contribución bajo la [licencia MIT](./LICENSE).
