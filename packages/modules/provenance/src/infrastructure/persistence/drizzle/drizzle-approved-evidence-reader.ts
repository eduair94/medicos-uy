import { eq } from 'drizzle-orm';

import { publicEvidenceRefView } from './provenance.schema';

import type { PublicEvidenceReference } from '../../../application/models/public-evidence-reference';
import type { ApprovedEvidenceFinder } from '../../../application/ports/approved-evidence-finder.port';
import type { CatalogDatabase } from '@medicos/database';

export class DrizzleApprovedEvidenceReader implements ApprovedEvidenceFinder {
  public constructor(private readonly database: CatalogDatabase) {}

  public async findApprovedById(evidenceId: string): Promise<PublicEvidenceReference | undefined> {
    const rows = await this.database
      .select({
        confidence: publicEvidenceRefView.confidence,
        sourceKind: publicEvidenceRefView.sourceKind,
        sourceName: publicEvidenceRefView.sourceName,
        sourceCanonicalUrl: publicEvidenceRefView.sourceCanonicalUrl,
        sourceLicenseUrl: publicEvidenceRefView.sourceLicenseUrl,
        sourceReuseBasis: publicEvidenceRefView.sourceReuseBasis,
        sourcePolicyId: publicEvidenceRefView.sourcePolicyId,
        sourceValidUntil: publicEvidenceRefView.sourceValidUntil,
        canonicalUrl: publicEvidenceRefView.canonicalUrl,
        observedAt: publicEvidenceRefView.observedAt,
        sourceCutoffDate: publicEvidenceRefView.sourceCutoffDate,
        validUntil: publicEvidenceRefView.validUntil,
        attribution: publicEvidenceRefView.attribution,
      })
      .from(publicEvidenceRefView)
      .where(eq(publicEvidenceRefView.evidenceId, evidenceId))
      .limit(1);
    const evidence = rows.at(0);

    if (
      evidence === undefined ||
      evidence.sourceReuseBasis === 'PENDING' ||
      evidence.confidence === 'CANDIDATE'
    ) {
      return undefined;
    }

    return {
      confidence: evidence.confidence,
      source: {
        kind: evidence.sourceKind,
        name: evidence.sourceName,
        canonicalUrl: evidence.sourceCanonicalUrl,
        reuseBasis: evidence.sourceReuseBasis,
        policyId: evidence.sourcePolicyId,
        validUntil: evidence.sourceValidUntil.toISOString(),
        ...(evidence.sourceLicenseUrl === null
          ? {}
          : {
              licenseUrl: evidence.sourceLicenseUrl,
            }),
      },
      canonicalUrl: evidence.canonicalUrl,
      observedAt: evidence.observedAt.toISOString(),
      sourceCutoffDate: evidence.sourceCutoffDate,
      ...(evidence.validUntil === null
        ? {}
        : {
            validUntil: evidence.validUntil.toISOString(),
          }),
      attribution: evidence.attribution,
    };
  }
}
