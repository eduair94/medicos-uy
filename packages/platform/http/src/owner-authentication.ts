import { createHash, timingSafeEqual } from 'node:crypto';

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export const OWNER_API_KEY_HEADER = 'x-api-key' as const;
export const OWNER_FIREBASE_APP_NAME_PREFIX = 'medicos-owner-auth' as const;

const MAX_API_KEY_LENGTH = 4_096;
const MAX_FIREBASE_ID_TOKEN_LENGTH = 16_384;

export interface OwnerAuthenticationHeaders {
  readonly authorization?: string | readonly string[];
  readonly [OWNER_API_KEY_HEADER]?: string | readonly string[];
}

export interface OwnerCredentialVerifier {
  isPresented(headers: OwnerAuthenticationHeaders): boolean;
  verify(headers: OwnerAuthenticationHeaders): Promise<boolean>;
}

export interface FirebaseDecodedIdToken {
  readonly uid: string;
}

export type FirebaseIdTokenVerifier = (
  token: string,
  checkRevoked: boolean,
) => Promise<FirebaseDecodedIdToken>;

export interface FirebaseOwnerCredentialVerifierOptions {
  readonly projectId: string;
  readonly ownerUids: readonly string[];
  readonly verifyIdToken?: FirebaseIdTokenVerifier;
}

export interface OwnerAuthenticationConfiguration {
  readonly basicEnabled: boolean;
  readonly firebaseProjectId?: string;
  readonly firebaseOwnerUids: readonly string[];
  readonly ownerApiBasicUsername: string;
  readonly ownerApiKeySha256?: string;
}

export interface EnabledOwnerAuthenticationMethods {
  readonly basic: boolean;
  readonly firebaseBearer: boolean;
  readonly ownerApiKey: boolean;
}

class Sha256SecretMatcher {
  private readonly expectedDigest: Buffer;

  public constructor(expectedSha256: string) {
    this.expectedDigest = Buffer.from(expectedSha256, 'hex');

    if (this.expectedDigest.length !== 32) {
      throw new Error('Owner API key SHA-256 must decode to exactly 32 bytes.');
    }
  }

  public matches(value: string): boolean {
    // The input is a generated, high-entropy API key rather than a human password.
    // codeql[js/insufficient-password-hash]
    const presentedDigest = createHash('sha256').update(value, 'utf8').digest();
    return timingSafeEqual(presentedDigest, this.expectedDigest);
  }
}

function singleHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractBearerToken(headers: OwnerAuthenticationHeaders): string | undefined {
  const authorization = singleHeaderValue(headers.authorization);

  if (authorization === undefined) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1];
}

interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

function extractBasicCredentials(
  headers: OwnerAuthenticationHeaders,
): BasicCredentials | undefined {
  const authorization = singleHeaderValue(headers.authorization);

  if (authorization === undefined) {
    return undefined;
  }

  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(authorization);
  const encodedCredentials = match?.[1];

  if (
    encodedCredentials === undefined ||
    encodedCredentials.length > MAX_API_KEY_LENGTH * 2 ||
    encodedCredentials.length % 4 !== 0
  ) {
    return undefined;
  }

  const decodedCredentials = Buffer.from(encodedCredentials, 'base64').toString('utf8');
  const separatorIndex = decodedCredentials.indexOf(':');

  if (separatorIndex < 1) {
    return undefined;
  }

  return {
    username: decodedCredentials.slice(0, separatorIndex),
    password: decodedCredentials.slice(separatorIndex + 1),
  };
}

function createFirebaseIdTokenVerifier(projectId: string): FirebaseIdTokenVerifier {
  const appNameSuffix = createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 16);
  const appName = `${OWNER_FIREBASE_APP_NAME_PREFIX}-${appNameSuffix}`;
  const existingApp = getApps().find((app) => app.name === appName);
  const app =
    existingApp ??
    initializeApp(
      {
        credential: applicationDefault(),
        projectId,
      },
      appName,
    );
  const auth = getAuth(app);

  return async (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked);
}

export class ApiKeyOwnerCredentialVerifier implements OwnerCredentialVerifier {
  private readonly secretMatcher: Sha256SecretMatcher;

  public constructor(expectedSha256: string) {
    this.secretMatcher = new Sha256SecretMatcher(expectedSha256);
  }

  public isPresented(headers: OwnerAuthenticationHeaders): boolean {
    return headers[OWNER_API_KEY_HEADER] !== undefined;
  }

  public verify(headers: OwnerAuthenticationHeaders): Promise<boolean> {
    const apiKey = singleHeaderValue(headers[OWNER_API_KEY_HEADER]);

    if (apiKey === undefined || apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
      return Promise.resolve(false);
    }

    return Promise.resolve(this.secretMatcher.matches(apiKey));
  }
}

export class BasicOwnerCredentialVerifier implements OwnerCredentialVerifier {
  private readonly secretMatcher: Sha256SecretMatcher;

  public constructor(
    private readonly expectedUsername: string,
    expectedSha256: string,
  ) {
    this.secretMatcher = new Sha256SecretMatcher(expectedSha256);
  }

  public isPresented(headers: OwnerAuthenticationHeaders): boolean {
    return extractBasicCredentials(headers) !== undefined;
  }

  public verify(headers: OwnerAuthenticationHeaders): Promise<boolean> {
    const credentials = extractBasicCredentials(headers);

    if (credentials?.username !== this.expectedUsername) {
      return Promise.resolve(false);
    }

    if (credentials.password.length === 0 || credentials.password.length > MAX_API_KEY_LENGTH) {
      return Promise.resolve(false);
    }

    return Promise.resolve(this.secretMatcher.matches(credentials.password));
  }
}

export class FirebaseOwnerCredentialVerifier implements OwnerCredentialVerifier {
  private readonly ownerUids: ReadonlySet<string>;
  private readonly verifyIdToken: FirebaseIdTokenVerifier;

  public constructor(options: FirebaseOwnerCredentialVerifierOptions) {
    this.ownerUids = new Set(options.ownerUids);
    this.verifyIdToken = options.verifyIdToken ?? createFirebaseIdTokenVerifier(options.projectId);

    if (this.ownerUids.size === 0) {
      throw new Error('At least one Firebase owner UID is required.');
    }
  }

  public isPresented(headers: OwnerAuthenticationHeaders): boolean {
    return headers.authorization !== undefined;
  }

  public async verify(headers: OwnerAuthenticationHeaders): Promise<boolean> {
    const token = extractBearerToken(headers);

    if (token === undefined || token.length > MAX_FIREBASE_ID_TOKEN_LENGTH) {
      return false;
    }

    try {
      const decodedToken = await this.verifyIdToken(token, true);
      return this.ownerUids.has(decodedToken.uid);
    } catch {
      return false;
    }
  }
}

export class OwnerAuthenticator {
  public constructor(private readonly verifiers: readonly OwnerCredentialVerifier[]) {
    if (verifiers.length === 0) {
      throw new Error('Owner authentication cannot start without a credential verifier.');
    }
  }

  public async authenticate(headers: OwnerAuthenticationHeaders): Promise<boolean> {
    for (const verifier of this.verifiers) {
      if (!verifier.isPresented(headers)) {
        continue;
      }

      try {
        if (await verifier.verify(headers)) {
          return true;
        }
      } catch {
        // Authentication adapters are deliberately fail-closed.
      }
    }

    return false;
  }
}

export function createOwnerAuthenticator(
  configuration: OwnerAuthenticationConfiguration,
): OwnerAuthenticator {
  const verifiers: OwnerCredentialVerifier[] = [];

  if (configuration.ownerApiKeySha256 !== undefined) {
    verifiers.push(new ApiKeyOwnerCredentialVerifier(configuration.ownerApiKeySha256));

    if (configuration.basicEnabled) {
      verifiers.push(
        new BasicOwnerCredentialVerifier(
          configuration.ownerApiBasicUsername,
          configuration.ownerApiKeySha256,
        ),
      );
    }
  }

  if (configuration.firebaseProjectId !== undefined && configuration.firebaseOwnerUids.length > 0) {
    verifiers.push(
      new FirebaseOwnerCredentialVerifier({
        projectId: configuration.firebaseProjectId,
        ownerUids: configuration.firebaseOwnerUids,
      }),
    );
  }

  return new OwnerAuthenticator(verifiers);
}

export function resolveEnabledOwnerAuthenticationMethods(
  configuration: OwnerAuthenticationConfiguration,
): EnabledOwnerAuthenticationMethods {
  const ownerApiKey = configuration.ownerApiKeySha256 !== undefined;

  return {
    basic: configuration.basicEnabled && ownerApiKey,
    firebaseBearer:
      configuration.firebaseProjectId !== undefined && configuration.firebaseOwnerUids.length > 0,
    ownerApiKey,
  };
}
