import type {
  EnabledOwnerAuthenticationMethods,
  OwnerAuthenticator,
  OwnerAuthenticationHeaders,
} from './owner-authentication';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

const PUBLIC_HEALTH_PATHS = new Set(['/health/live', '/health/ready']);

export type OwnerAuthenticationCache = WeakMap<FastifyRequest, boolean>;

function requestPath(request: FastifyRequest): string {
  return new URL(request.url, 'http://localhost').pathname;
}

function isPublicRequest(request: FastifyRequest): boolean {
  if (request.method === 'OPTIONS') {
    return true;
  }

  return PUBLIC_HEALTH_PATHS.has(requestPath(request));
}

export function asOwnerAuthenticationHeaders(request: FastifyRequest): OwnerAuthenticationHeaders {
  return {
    ...(request.headers.authorization === undefined
      ? {}
      : { authorization: request.headers.authorization }),
    ...(request.headers['x-api-key'] === undefined
      ? {}
      : { 'x-api-key': request.headers['x-api-key'] }),
  };
}

function authenticationChallenge(methods: EnabledOwnerAuthenticationMethods): string | undefined {
  const challenges = [
    ...(methods.basic ? ['Basic realm="Medicos owner API"'] : []),
    ...(methods.firebaseBearer ? ['Bearer realm="medicos-owner"'] : []),
  ];

  return challenges.length === 0 ? undefined : challenges.join(', ');
}

function sendUnauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  methods: EnabledOwnerAuthenticationMethods,
): FastifyReply {
  const challenge = authenticationChallenge(methods);
  const response = reply.status(401).header('cache-control', 'private, no-store');

  if (challenge !== undefined) {
    void response.header('www-authenticate', challenge);
  }

  return response.type('application/problem+json').send({
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'Owner authentication is required.',
    instance: request.url,
    traceId: request.id,
  });
}

export function createOwnerAuthenticationHook(
  authenticator: OwnerAuthenticator,
  methods: EnabledOwnerAuthenticationMethods,
  authenticationCache?: OwnerAuthenticationCache,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (isPublicRequest(request)) {
      return;
    }

    const cachedAuthentication = authenticationCache?.get(request);
    const authenticated =
      cachedAuthentication ??
      (await authenticator.authenticate(asOwnerAuthenticationHeaders(request)));

    authenticationCache?.set(request, authenticated);

    if (!authenticated) {
      return sendUnauthorized(request, reply, methods);
    }

    void reply
      .header('cache-control', 'private, no-store')
      .header('vary', 'Authorization, X-API-Key, Origin');
    reply.raw.setHeader('cache-control', 'private, no-store');
    reply.raw.setHeader('vary', 'Authorization, X-API-Key, Origin');
  };
}
