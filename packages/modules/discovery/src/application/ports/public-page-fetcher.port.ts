import type { SourceUrlPolicy } from '../../domain/source-url-policy';

export interface FetchedPublicPage {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly text: string;
  readonly statusCode: number;
  readonly contentBytes: number;
}

export interface PublicPageFetcher {
  fetch(url: string, policy: SourceUrlPolicy): Promise<FetchedPublicPage>;
}
