import type {
  FetchedPublicPage,
  PublicPageFetcher,
} from '../../application/ports/public-page-fetcher.port';
import type { SourceUrlPolicy } from '../../domain/source-url-policy';

type FetchImplementation = typeof fetch;

export interface Crawl4AiPageFetcherOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumAttempts?: number;
  readonly fetchImplementation?: FetchImplementation;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function extractText(result: Record<string, unknown>): string {
  if (typeof result['html'] === 'string') {
    return result['html'];
  }
  const markdown = result['markdown'];
  if (typeof markdown === 'string') {
    return markdown;
  }
  if (isObject(markdown) && typeof markdown['raw_markdown'] === 'string') {
    return markdown['raw_markdown'];
  }
  throw new Error('Crawl4AI response has no supported text content');
}

async function readTextBounded(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumBytes) {
    throw new Error('Crawl4AI response exceeds configured byte limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error('Crawl4AI response exceeds configured byte limit');
  }
  return new TextDecoder().decode(bytes);
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(30_000, Math.max(0, seconds * 1_000));
    }
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

export class Crawl4AiPageFetcher implements PublicPageFetcher {
  private readonly endpoint: string;
  private readonly simpleHtmlEndpoint: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumAttempts: number;
  private readonly fetchImplementation: FetchImplementation;
  private readonly wait: (milliseconds: number) => Promise<void>;

  public constructor(options: Crawl4AiPageFetcherOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
      throw new Error('Crawl4AI base URL must be credential-free HTTPS');
    }
    this.endpoint = new URL('/crawl', baseUrl).href;
    this.simpleHtmlEndpoint = new URL('/html', baseUrl).href;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 10 * 1024 * 1024;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((fulfill) => setTimeout(fulfill, milliseconds)));
  }

  public async fetch(url: string, policy: SourceUrlPolicy): Promise<FetchedPublicPage> {
    const requestedUrl = policy.assertAllowed(url).href;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maximumAttempts; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImplementation(this.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'MedicosUY-Ingestion/1.0',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({
            urls: [requestedUrl],
            browser_config: {
              type: 'BrowserConfig',
              params: { headless: true },
            },
            crawler_config: {
              type: 'CrawlerRunConfig',
              params: {
                cache_mode: 'BYPASS',
                check_robots_txt: true,
                page_timeout: Math.min(this.timeoutMs, 30_000),
                remove_overlay_elements: true,
                exclude_external_images: true,
              },
            },
          }),
        });
        if (!response.ok) {
          const retryable = [429, 503, 504].includes(response.status);
          if (retryable && attempt + 1 < this.maximumAttempts) {
            await this.wait(retryDelay(response, attempt));
            continue;
          }
          if (response.status >= 500 && !retryable) {
            return this.fetchSimpleHtml(requestedUrl, policy);
          }
          throw new Error(`Crawl4AI returned HTTP ${String(response.status)}`);
        }

        const raw = await readTextBounded(response, this.maximumResponseBytes);
        const envelope = parseJson(raw);
        if (!isObject(envelope) || !Array.isArray(envelope['results'])) {
          throw new Error('Crawl4AI returned an invalid envelope');
        }
        const results = envelope['results'] as unknown[];
        const result: unknown = results[0];
        if (!isObject(result) || result['success'] !== true) {
          throw new Error('Crawl4AI source crawl did not succeed');
        }
        const finalUrlValue =
          typeof result['redirected_url'] === 'string' && result['redirected_url'].length > 0
            ? result['redirected_url']
            : result['url'];
        if (typeof finalUrlValue !== 'string') {
          throw new Error('Crawl4AI response has no final URL');
        }
        const finalUrl = policy.assertAllowed(finalUrlValue).href;
        const text = extractText(result);
        if (
          text.length === 0 ||
          new TextEncoder().encode(text).byteLength > this.maximumResponseBytes
        ) {
          throw new Error('Crawl4AI page content is empty or exceeds configured byte limit');
        }
        const statusCode = typeof result['status_code'] === 'number' ? result['status_code'] : 200;
        if (statusCode >= 400) {
          throw new Error(`Crawl4AI source returned HTTP ${String(statusCode)}`);
        }
        return {
          requestedUrl,
          finalUrl,
          text,
          statusCode,
          contentBytes: new TextEncoder().encode(text).byteLength,
        };
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.maximumAttempts && response === undefined) {
          await this.wait(retryDelay(undefined, attempt));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async fetchSimpleHtml(
    requestedUrl: string,
    policy: SourceUrlPolicy,
  ): Promise<FetchedPublicPage> {
    const response = await this.fetchImplementation(this.simpleHtmlEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'MedicosUY-Ingestion/1.0',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ url: requestedUrl }),
    });
    if (!response.ok) {
      throw new Error(`Crawl4AI simple HTML endpoint returned HTTP ${String(response.status)}`);
    }
    const raw = await readTextBounded(response, this.maximumResponseBytes);
    const payload = parseJson(raw);
    if (
      !isObject(payload) ||
      payload['success'] !== true ||
      typeof payload['html'] !== 'string' ||
      typeof payload['url'] !== 'string'
    ) {
      throw new Error('Crawl4AI simple HTML endpoint returned an invalid payload');
    }
    const finalUrl = policy.assertAllowed(payload['url']).href;
    const contentBytes = new TextEncoder().encode(payload['html']).byteLength;
    if (contentBytes === 0 || contentBytes > this.maximumResponseBytes) {
      throw new Error('Crawl4AI page content is empty or exceeds configured byte limit');
    }
    return {
      requestedUrl,
      finalUrl,
      text: payload['html'],
      statusCode: 200,
      contentBytes,
    };
  }
}
