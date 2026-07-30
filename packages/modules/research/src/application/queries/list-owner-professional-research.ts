import { InvalidOwnerResearchListQueryError } from '../errors/owner-research.error';

import { mapOwnerProfessionalResearch } from './map-owner-professional-research';

import type { OwnerProfessionalResearchPage } from '../models/owner-research-page';
import type { OwnerResearchListReader } from '../ports/owner-research-list-reader.port';

export interface ListOwnerProfessionalResearchInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export class ListOwnerProfessionalResearch {
  public constructor(private readonly research: OwnerResearchListReader) {}

  public async execute(
    input: ListOwnerProfessionalResearchInput,
  ): Promise<OwnerProfessionalResearchPage> {
    const limit = input.limit ?? 20;

    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new InvalidOwnerResearchListQueryError('limit must be an integer between 1 and 50.');
    }

    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 1_000)) {
      throw new InvalidOwnerResearchListQueryError(
        'cursor must be a non-empty opaque value of at most 1000 characters.',
      );
    }

    const page = await this.research.listLatest({
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const items = page.records.map((record) => ({
      ...mapOwnerProfessionalResearch(record),
      labels: {
        associationReview: 'UNVERIFIED_REVIEW_CANDIDATE' as const,
        originalSourceVerificationRequired: true as const,
      },
    }));

    return {
      items,
      pagination: {
        limit,
        returned: items.length,
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
      labels: {
        access: 'OWNER_ONLY',
        associations: 'UNVERIFIED_CANDIDATES_INCLUDED',
        projection: 'SANITIZED_OWNER_RESEARCH_VIEW',
      },
    };
  }
}
