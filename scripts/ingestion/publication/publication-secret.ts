import { timingSafeEqual } from 'node:crypto';

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MINIMUM_SECRET_BYTES = 32;

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (!CANONICAL_BASE64.test(value)) {
    return undefined;
  }

  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!CANONICAL_BASE64URL.test(value)) {
    return undefined;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

export function decodeCanonicalPublicationSecret(value: string, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must use canonical base64 or unpadded base64url`);
  }

  const decoded = decodeCanonicalBase64(value) ?? decodeCanonicalBase64Url(value);
  if (decoded === undefined) {
    throw new Error(`${label} must use canonical base64 or unpadded base64url`);
  }
  if (decoded.length < MINIMUM_SECRET_BYTES) {
    throw new Error(`${label} must decode to at least ${MINIMUM_SECRET_BYTES} random bytes`);
  }

  return decoded;
}

export function assertDistinctPublicationSecrets(options: {
  readonly left: Buffer;
  readonly leftLabel: string;
  readonly right: Buffer;
  readonly rightLabel: string;
}): void {
  if (
    options.left.length === options.right.length &&
    timingSafeEqual(options.left, options.right)
  ) {
    throw new Error(
      `${options.leftLabel} and ${options.rightLabel} must use different secret bytes`,
    );
  }
}
