process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';
process.env['SWAGGER_ENABLED'] = 'false';
process.env['CATALOG_DATABASE_URL'] =
  process.env['CATALOG_DATABASE_URL'] ?? 'postgresql://test:test@127.0.0.1:9/medicos_catalog_test';
process.env['CATALOG_DATABASE_POOL_MAX'] = '1';
process.env['CATALOG_DATABASE_SSL'] = 'false';
process.env['OWNER_RESEARCH_DATABASE_URL'] =
  process.env['OWNER_RESEARCH_DATABASE_URL'] ??
  'postgresql://test:test@127.0.0.1:9/medicos_catalog_test';
process.env['OWNER_RESEARCH_DATABASE_POOL_MAX'] = '1';
process.env['OWNER_API_BASIC_USERNAME'] = 'owner';
process.env['OWNER_API_KEY_SHA256'] =
  'c64bcba7b5650a21e86aaa762fe60684b0cf4d9791120337bdb840047907fb0e';
