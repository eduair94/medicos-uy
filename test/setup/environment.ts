process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';
process.env['SWAGGER_ENABLED'] = 'false';
process.env['CATALOG_DATABASE_URL'] =
  process.env['CATALOG_DATABASE_URL'] ?? 'postgresql://test:test@127.0.0.1:9/medicos_catalog_test';
process.env['CATALOG_DATABASE_POOL_MAX'] = '1';
process.env['CATALOG_DATABASE_SSL'] = 'false';
