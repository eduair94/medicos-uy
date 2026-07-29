import type { PersistedOwnerResearchRecord } from '../models/owner-research-read-model';

export type OwnerResearchLookup =
  | {
      readonly kind: 'PUBLIC_UUID';
      readonly value: string;
    }
  | {
      readonly kind: 'SLUG';
      readonly value: string;
    };

export interface OwnerResearchReader {
  findLatestByProfessional(
    lookup: OwnerResearchLookup,
  ): Promise<PersistedOwnerResearchRecord | undefined>;
}

export const OWNER_RESEARCH_READER = Symbol('OWNER_RESEARCH_READER');
