import { describe, expect, it, vi } from 'vitest';

import {
  InvalidProfessionalCredentialsQueryError,
  ProfessionalCredentialsNotFoundError,
} from '../../src/application/errors/professional-credentials.error';
import { GetProfessionalCredentials } from '../../src/application/queries/get-professional-credentials';

import type { ProfessionalCredentialsReader } from '../../src/application/ports/professional-credentials-reader.port';
import type { ApprovedEvidenceFinder, PublicEvidenceReference } from '@medicos/provenance';

describe('GetProfessionalCredentials', () => {
  const professionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc8';
  const evidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc9';
  const evidence: PublicEvidenceReference = {
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

  function reader(
    records: Awaited<ReturnType<ProfessionalCredentialsReader['findPublicByProfessionalId']>>,
  ): ProfessionalCredentialsReader {
    return {
      findPublicByProfessionalId: vi.fn().mockResolvedValue(records),
    };
  }

  function evidenceFinder(result: PublicEvidenceReference | undefined): ApprovedEvidenceFinder {
    return {
      findApprovedById: vi.fn().mockResolvedValue(result),
    };
  }

  it('returns enabled titles with independent approved evidence', async () => {
    const credentials = reader([
      {
        id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cca',
        title: 'Doctor en Medicina',
        temporaryRegistration: 'NONE',
        evidenceId,
      },
    ]);
    const approvedEvidence = evidenceFinder(evidence);
    const useCase = new GetProfessionalCredentials(credentials, approvedEvidence);

    await expect(useCase.execute(` ${professionalId} `)).resolves.toEqual({
      professionalId,
      registeredTitles: [
        {
          id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cca',
          title: 'Doctor en Medicina',
          registrationState: 'ENABLED',
          temporaryRegistration: 'NONE',
          evidence,
        },
      ],
    });
    expect(credentials.findPublicByProfessionalId).toHaveBeenCalledWith(professionalId);
    expect(approvedEvidence.findApprovedById).toHaveBeenCalledWith(evidenceId);
  });

  it('fails closed when evidence is revoked between projection reads', async () => {
    const useCase = new GetProfessionalCredentials(
      reader([
        {
          id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cca',
          title: 'Doctor en Medicina',
          temporaryRegistration: 'NONE',
          evidenceId,
        },
      ]),
      evidenceFinder(undefined),
    );

    await expect(useCase.execute(professionalId)).rejects.toBeInstanceOf(
      ProfessionalCredentialsNotFoundError,
    );
  });

  it('rejects malformed identifiers before querying persistence', async () => {
    const credentials = reader([]);
    const useCase = new GetProfessionalCredentials(credentials, evidenceFinder(evidence));

    await expect(useCase.execute('not-a-uuid')).rejects.toBeInstanceOf(
      InvalidProfessionalCredentialsQueryError,
    );
    expect(credentials.findPublicByProfessionalId).not.toHaveBeenCalled();
  });

  it('returns not found when no public registered title exists', async () => {
    const useCase = new GetProfessionalCredentials(reader(undefined), evidenceFinder(evidence));

    await expect(useCase.execute(professionalId)).rejects.toBeInstanceOf(
      ProfessionalCredentialsNotFoundError,
    );
  });
});
