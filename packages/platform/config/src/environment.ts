import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

const postgresConnectionUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      if (!URL.canParse(value)) {
        return false;
      }

      const protocol = new URL(value).protocol;
      return protocol === 'postgres:' || protocol === 'postgresql:';
    },
    {
      message: 'must use the postgres:// or postgresql:// scheme',
    },
  );

const corsOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    if (!URL.canParse(value)) {
      return z.NEVER;
    }

    const parsed = new URL(value);

    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be an HTTP(S) origin without credentials, path, query or fragment',
      });

      return z.NEVER;
    }

    return parsed.origin;
  });

const publicHttpBaseUrlSchema = z
  .string()
  .url()
  .transform((value, context) => {
    if (!URL.canParse(value)) {
      return z.NEVER;
    }

    const parsed = new URL(value);

    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be an HTTP(S) origin without credentials, path, query or fragment',
      });

      return z.NEVER;
    }

    return parsed.origin;
  });

const corsOriginsSchema = z
  .string()
  .default('http://localhost:3000')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(corsOriginSchema).min(1).max(20));

const baseEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: corsOriginsSchema,
  API_DOCUMENTATION_ENABLED: booleanFromEnvironment.optional(),
  SWAGGER_ENABLED: booleanFromEnvironment.optional(),
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(10_000).default(100),
  HTTP_RATE_LIMIT_WINDOW: z.string().trim().min(1).default('1 minute'),
});

const publicQueryApiEnvironmentSchema = baseEnvironmentSchema
  .extend({
    PUBLIC_QUERY_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    PUBLIC_QUERY_API_HOST: z.enum(['0.0.0.0', '127.0.0.1', '::1']).default('0.0.0.0'),
    PUBLIC_API_BASE_URL: publicHttpBaseUrlSchema.optional(),
    CATALOG_DATABASE_URL: postgresConnectionUrlSchema,
    CATALOG_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    CATALOG_DATABASE_SSL: booleanFromEnvironment.default(false),
  })
  .superRefine((environment, context) => {
    const documentationEnabled =
      environment.API_DOCUMENTATION_ENABLED ?? environment.SWAGGER_ENABLED ?? false;

    if (
      environment.NODE_ENV === 'production' &&
      documentationEnabled &&
      environment.PUBLIC_API_BASE_URL === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PUBLIC_API_BASE_URL'],
        message: 'is required in production when public API documentation is enabled',
      });
    }
  })
  .transform((environment) => {
    const documentationEnabled =
      environment.API_DOCUMENTATION_ENABLED ?? environment.SWAGGER_ENABLED ?? false;

    return {
      ...environment,
      API_DOCUMENTATION_ENABLED: documentationEnabled,
      PUBLIC_API_BASE_URL:
        environment.PUBLIC_API_BASE_URL ?? `http://localhost:${environment.PUBLIC_QUERY_API_PORT}`,
      HOST: environment.PUBLIC_QUERY_API_HOST,
      PORT: environment.PUBLIC_QUERY_API_PORT,
      SERVICE_NAME: 'public-query-api',
    };
  });

const commandApiEnvironmentSchema = baseEnvironmentSchema
  .extend({
    COMMAND_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  })
  .transform((environment) => {
    const documentationEnabled =
      environment.API_DOCUMENTATION_ENABLED ?? environment.SWAGGER_ENABLED ?? false;

    return {
      ...environment,
      API_DOCUMENTATION_ENABLED: documentationEnabled,
      HOST: '0.0.0.0',
      PORT: environment.COMMAND_API_PORT,
      SERVICE_NAME: 'command-api',
    };
  });

const catalogWorkerEnvironmentSchema = baseEnvironmentSchema
  .pick({
    NODE_ENV: true,
    LOG_LEVEL: true,
  })
  .transform((environment) => ({
    ...environment,
    SERVICE_NAME: 'catalog-worker',
  }));

export type PublicQueryApiEnvironment = z.output<typeof publicQueryApiEnvironmentSchema>;
export type CommandApiEnvironment = z.output<typeof commandApiEnvironmentSchema>;
export type CatalogWorkerEnvironment = z.output<typeof catalogWorkerEnvironmentSchema>;

export class EnvironmentValidationError extends Error {
  public constructor(issues: readonly z.core.$ZodIssue[]) {
    const details = issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'environment';
        return `${path}: ${issue.message}`;
      })
      .join('; ');

    super(`Invalid environment configuration: ${details}`);
    this.name = 'EnvironmentValidationError';
  }
}

function parseEnvironment<T>(schema: z.ZodType<T>, input: Record<string, unknown>): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return result.data;
}

export function validatePublicQueryApiEnvironment(
  input: Record<string, unknown>,
): PublicQueryApiEnvironment {
  return parseEnvironment(publicQueryApiEnvironmentSchema, input);
}

export function validateCommandApiEnvironment(
  input: Record<string, unknown>,
): CommandApiEnvironment {
  return parseEnvironment(commandApiEnvironmentSchema, input);
}

export function validateCatalogWorkerEnvironment(
  input: Record<string, unknown>,
): CatalogWorkerEnvironment {
  return parseEnvironment(catalogWorkerEnvironmentSchema, input);
}
