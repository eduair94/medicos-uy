import { InvalidProfessionalQueryError } from '../errors/professional-query.error';

import type { ProfessionalSearchPage } from '../models/professional-read-model';
import type { ProfessionalSearch } from '../ports/professional-reader.port';

export interface SearchProfessionalsInput {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export class SearchProfessionals {
  public constructor(private readonly professionals: ProfessionalSearch) {}

  public async execute(input: SearchProfessionalsInput): Promise<ProfessionalSearchPage> {
    const limit = input.limit ?? 20;
    const query = input.query?.trim();

    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new InvalidProfessionalQueryError('limit must be an integer between 1 and 50.');
    }

    if (query !== undefined && query.length > 200) {
      throw new InvalidProfessionalQueryError('query must not exceed 200 characters.');
    }

    return this.professionals.searchPublic({
      limit,
      ...(query === undefined || query.length === 0 ? {} : { query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  }
}
