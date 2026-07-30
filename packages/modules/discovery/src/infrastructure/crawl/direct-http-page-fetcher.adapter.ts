import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type {
  FetchedPublicPage,
  PublicPageFetcher,
} from '../../application/ports/public-page-fetcher.port';
import type { SourceUrlPolicy } from '../../domain/source-url-policy';

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first = 0, second = 0] = address.split('.').map(Number);
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized)
    );
  }
  return false;
}

export interface DirectHttpPageFetcherOptions {
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumRedirects?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export class DirectHttpPageFetcher implements PublicPageFetcher {
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumRedirects: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;

  public constructor(options: DirectHttpPageFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 5 * 1024 * 1024;
    this.maximumRedirects = options.maximumRedirects ?? 3;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.resolveAddresses =
      options.resolveAddresses ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
  }

  public async fetch(url: string, policy: SourceUrlPolicy): Promise<FetchedPublicPage> {
    const requestedUrl = policy.assertAllowed(url).href;
    let currentUrl = requestedUrl;
    for (let redirectCount = 0; redirectCount <= this.maximumRedirects; redirectCount += 1) {
      const checkedUrl = policy.assertAllowed(currentUrl);
      const addresses = await this.resolveAddresses(checkedUrl.hostname);
      if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw new Error('Direct source hostname resolves to a private or reserved network');
      }
      const response = await this.fetchImplementation(checkedUrl, {
        redirect: 'manual',
        headers: {
          accept: 'text/html, text/plain;q=0.8',
          'user-agent': 'MedicosUY-Ingestion/1.0',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (location === null || redirectCount === this.maximumRedirects) {
          throw new Error('Direct source redirect is missing or exceeds configured limit');
        }
        currentUrl = policy.assertAllowed(new URL(location, checkedUrl).href).href;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Direct source returned HTTP ${String(response.status)}`);
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'text/html' && mediaType !== 'text/plain') {
        throw new Error(
          `Direct source returned unsupported content type ${mediaType ?? 'unknown'}`,
        );
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > this.maximumResponseBytes) {
        throw new Error('Direct source response exceeds configured byte limit');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > this.maximumResponseBytes) {
        throw new Error('Direct source response is empty or exceeds configured byte limit');
      }
      return {
        requestedUrl,
        finalUrl: checkedUrl.href,
        text: new TextDecoder().decode(bytes),
        statusCode: response.status,
        contentBytes: bytes.byteLength,
      };
    }
    throw new Error('Direct source redirect invariant failed');
  }
}
