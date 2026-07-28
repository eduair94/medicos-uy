import type {
  ProfessionalLookupRecord,
  ProfessionalSearchPage,
} from '../models/professional-read-model';

export interface ProfessionalSearchCriteria {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ProfessionalSearch {
  searchPublic(criteria: ProfessionalSearchCriteria): Promise<ProfessionalSearchPage>;
}

export interface ProfessionalFinder {
  findPublicByIdOrSlug(idOrSlug: string): Promise<ProfessionalLookupRecord | undefined>;
}

export const PROFESSIONAL_SEARCH = Symbol('PROFESSIONAL_SEARCH');
export const PROFESSIONAL_FINDER = Symbol('PROFESSIONAL_FINDER');
