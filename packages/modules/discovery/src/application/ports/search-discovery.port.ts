export interface SearchDiscoveryResult {
  readonly url: string;
  readonly rank: number;
  readonly provider: 'DUCKDUCKGO';
  readonly evidenceStatus: 'DISCOVERY_ONLY';
}

export interface SearchDiscoveryPort {
  discover(query: string, maximumResults: number): Promise<readonly SearchDiscoveryResult[]>;
}
