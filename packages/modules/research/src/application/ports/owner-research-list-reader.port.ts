import type { PersistedOwnerResearchPage } from '../models/owner-research-page';

export interface OwnerResearchListCriteria {
  readonly cursor?: string;
  readonly limit: number;
}

export interface OwnerResearchListReader {
  listLatest(criteria: OwnerResearchListCriteria): Promise<PersistedOwnerResearchPage>;
}

export const OWNER_RESEARCH_LIST_READER = Symbol('OWNER_RESEARCH_LIST_READER');
