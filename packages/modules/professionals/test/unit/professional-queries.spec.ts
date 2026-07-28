import { describe, expect, it, vi } from 'vitest';

import {
  InvalidProfessionalCursorError,
  InvalidProfessionalQueryError,
  ProfessionalNotFoundError,
} from '../../src/application/errors/professional-query.error';
import {
  PROFESSIONAL_FINDER,
  PROFESSIONAL_SEARCH,
} from '../../src/application/ports/professional-reader.port';
import { GetProfessional } from '../../src/application/queries/get-professional';
import { SearchProfessionals } from '../../src/application/queries/search-professionals';
import { ProfessionalVisibility } from '../../src/domain/professional-visibility';

import type {
  ProfessionalFinder,
  ProfessionalSearch,
} from '../../src/application/ports/professional-reader.port';
import type { ApprovedEvidenceFinder, PublicEvidenceReference } from '@medicos/provenance';

describe('professional queries', () => {
  const nameEvidence: PublicEvidenceReference = {
    confidence: 'DETERMINISTIC',
    source: {
      kind: 'GOVERNMENT_OPEN_DATA',
      name: 'Synthetic MSP fixture',
      canonicalUrl: 'https://example.invalid/open-data',
      licenseUrl: 'https://example.invalid/license',
      reuseBasis: 'OPEN_DATA_LICENSE',
      policyId: 'synthetic-policy-v1',
      validUntil: '2026-08-27T12:00:00.000Z',
    },
    canonicalUrl: 'https://example.invalid/open-data/medicos.csv',
    observedAt: '2026-07-26T12:00:00.000Z',
    sourceCutoffDate: '2026-07-01',
    validUntil: '2026-08-26T12:00:00.000Z',
    attribution: 'Synthetic unit fixture',
  };

  function approvedEvidenceFinder(
    evidence: PublicEvidenceReference | undefined,
  ): ApprovedEvidenceFinder {
    return {
      findApprovedById: vi
        .fn<ApprovedEvidenceFinder['findApprovedById']>()
        .mockResolvedValue(evidence),
    };
  }

  it('normalizes search input and delegates through the semantic port', async () => {
    const searchPublic = vi.fn<ProfessionalSearch['searchPublic']>().mockResolvedValue({
      items: [],
    });
    const useCase = new SearchProfessionals({
      searchPublic,
    });

    await expect(
      useCase.execute({
        query: '  Ana Pérez  ',
      }),
    ).resolves.toEqual({
      items: [],
    });
    expect(searchPublic).toHaveBeenCalledWith({
      limit: 20,
      query: 'Ana Pérez',
    });
  });

  it.each([0, 51, 1.5])('rejects an invalid limit (%s)', async (limit) => {
    const useCase = new SearchProfessionals({
      searchPublic: vi.fn<ProfessionalSearch['searchPublic']>(),
    });

    await expect(
      useCase.execute({
        limit,
      }),
    ).rejects.toBeInstanceOf(InvalidProfessionalQueryError);
  });

  it('omits blank search text and forwards an opaque cursor', async () => {
    const searchPublic = vi.fn<ProfessionalSearch['searchPublic']>().mockResolvedValue({
      items: [],
    });
    const useCase = new SearchProfessionals({
      searchPublic,
    });

    await useCase.execute({
      query: '   ',
      cursor: 'opaque-cursor',
      limit: 50,
    });

    expect(searchPublic).toHaveBeenCalledWith({
      cursor: 'opaque-cursor',
      limit: 50,
    });
  });

  it('rejects an overlong search query before calling the port', async () => {
    const searchPublic = vi.fn<ProfessionalSearch['searchPublic']>();
    const useCase = new SearchProfessionals({
      searchPublic,
    });

    await expect(
      useCase.execute({
        query: 'a'.repeat(201),
      }),
    ).rejects.toBeInstanceOf(InvalidProfessionalQueryError);
    expect(searchPublic).not.toHaveBeenCalled();
  });

  it('returns a public professional from the finder port', async () => {
    const detail = {
      id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc8',
      slug: 'ana-perez',
      displayName: 'Ana Pérez',
      currentNameEvidenceId: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc9',
    };
    const findPublicByIdOrSlug = vi
      .fn<ProfessionalFinder['findPublicByIdOrSlug']>()
      .mockResolvedValue(detail);
    const evidence = approvedEvidenceFinder(nameEvidence);
    const useCase = new GetProfessional(
      {
        findPublicByIdOrSlug,
      },
      evidence,
    );

    await expect(useCase.execute(' ana-perez ')).resolves.toEqual({
      id: detail.id,
      slug: detail.slug,
      displayName: detail.displayName,
      nameEvidence,
    });
    expect(findPublicByIdOrSlug).toHaveBeenCalledWith('ana-perez');
    expect(evidence.findApprovedById).toHaveBeenCalledWith(detail.currentNameEvidenceId);
  });

  it('turns an absent professional into an application error', async () => {
    const useCase = new GetProfessional(
      {
        findPublicByIdOrSlug: vi
          .fn<ProfessionalFinder['findPublicByIdOrSlug']>()
          .mockResolvedValue(undefined),
      },
      approvedEvidenceFinder(nameEvidence),
    );

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(ProfessionalNotFoundError);
  });

  it('fails closed when the name evidence is unavailable or revoked', async () => {
    const useCase = new GetProfessional(
      {
        findPublicByIdOrSlug: vi
          .fn<ProfessionalFinder['findPublicByIdOrSlug']>()
          .mockResolvedValue({
            id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc8',
            slug: 'ana-perez',
            displayName: 'Ana Pérez',
            currentNameEvidenceId: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc9',
          }),
      },
      approvedEvidenceFinder(undefined),
    );

    await expect(useCase.execute('ana-perez')).rejects.toBeInstanceOf(ProfessionalNotFoundError);
  });

  it.each(['', 'a'.repeat(201)])(
    'rejects an invalid professional identifier before using the finder',
    async (idOrSlug) => {
      const findPublicByIdOrSlug = vi.fn<ProfessionalFinder['findPublicByIdOrSlug']>();
      const useCase = new GetProfessional(
        {
          findPublicByIdOrSlug,
        },
        approvedEvidenceFinder(nameEvidence),
      );

      await expect(useCase.execute(idOrSlug)).rejects.toBeInstanceOf(InvalidProfessionalQueryError);
      expect(findPublicByIdOrSlug).not.toHaveBeenCalled();
    },
  );

  it('exposes stable, distinct dependency-injection tokens', () => {
    expect(PROFESSIONAL_SEARCH).toBeTypeOf('symbol');
    expect(PROFESSIONAL_FINDER).toBeTypeOf('symbol');
    expect(PROFESSIONAL_SEARCH).not.toBe(PROFESSIONAL_FINDER);
  });

  it('uses a dedicated error for malformed persistence cursors', () => {
    const error = new InvalidProfessionalCursorError();

    expect(error.name).toBe('InvalidProfessionalCursorError');
    expect(error.message).toContain('cursor');
  });

  it('keeps visibility as a framework-free domain concept', () => {
    expect(ProfessionalVisibility.PUBLIC).toBe('PUBLIC');
  });
});
