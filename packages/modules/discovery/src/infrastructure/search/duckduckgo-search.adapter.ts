import type {
  SearchDiscoveryPort,
  SearchDiscoveryResult,
} from '../../application/ports/search-discovery.port';
import type { SourceUrlPolicy } from '../../domain/source-url-policy';

export class SearchProviderBlockedError extends Error {}

export interface DuckDuckGoSearchAdapterOptions {
  readonly resultUrlPolicy: SourceUrlPolicy;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly circuitBreakMilliseconds?: number;
  readonly now?: () => number;
}

function decodeHtml(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    '&amp;': '&',
    '&quot;': '"',
    '&#x27;': "'",
    '&lt;': '<',
    '&gt;': '>',
  };

  return value.replace(/&(?:amp|quot|#x27|lt|gt);/gu, (entity) => entities[entity] ?? entity);
}

export class DuckDuckGoSearchAdapter implements SearchDiscoveryPort {
  private readonly resultUrlPolicy: SourceUrlPolicy;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly circuitBreakMilliseconds: number;
  private readonly now: () => number;
  private blockedUntil = 0;

  public constructor(options: DuckDuckGoSearchAdapterOptions) {
    this.resultUrlPolicy = options.resultUrlPolicy;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.circuitBreakMilliseconds = options.circuitBreakMilliseconds ?? 86_400_000;
    this.now = options.now ?? Date.now;
  }

  public async discover(
    query: string,
    maximumResults: number,
  ): Promise<readonly SearchDiscoveryResult[]> {
    if (this.now() < this.blockedUntil) {
      throw new SearchProviderBlockedError('DuckDuckGo circuit is open');
    }
    if (!Number.isInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
      throw new Error('DuckDuckGo maximumResults must be between 1 and 10');
    }
    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    const response = await this.fetchImplementation(endpoint, {
      redirect: 'error',
      headers: {
        accept: 'text/html',
        'user-agent': 'MedicosUY-Ingestion/1.0',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const html = await response.text();
    if (
      [202, 403, 429].includes(response.status) ||
      /\b(anomaly-modal|captcha|verify\s+you\s+are\s+human)\b/iu.test(html)
    ) {
      this.blockedUntil = this.now() + this.circuitBreakMilliseconds;
      throw new SearchProviderBlockedError(
        `DuckDuckGo blocked automated discovery with HTTP ${String(response.status)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`DuckDuckGo returned HTTP ${String(response.status)}`);
    }

    const results: SearchDiscoveryResult[] = [];
    const seen = new Set<string>();
    const linkPattern = /class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/giu;
    for (const match of html.matchAll(linkPattern)) {
      const rawHref = decodeHtml(match[1] ?? '');
      let candidateUrl: string;
      try {
        const redirect = new URL(rawHref, endpoint);
        candidateUrl = redirect.searchParams.get('uddg') ?? redirect.href;
      } catch {
        continue;
      }
      if (!this.resultUrlPolicy.isAllowed(candidateUrl)) {
        continue;
      }
      const canonicalUrl = this.resultUrlPolicy.assertAllowed(candidateUrl).href;
      if (seen.has(canonicalUrl)) {
        continue;
      }
      seen.add(canonicalUrl);
      results.push({
        url: canonicalUrl,
        rank: results.length + 1,
        provider: 'DUCKDUCKGO',
        evidenceStatus: 'DISCOVERY_ONLY',
      });
      if (results.length >= maximumResults) {
        break;
      }
    }
    return results;
  }
}
