import {
  InvalidProfessionalQueryError,
  ProfessionalNotFoundError,
} from '../errors/professional-query.error';

import type { ProfessionalDetail } from '../models/professional-read-model';
import type { ProfessionalFinder } from '../ports/professional-reader.port';
import type { ApprovedEvidenceFinder } from '@medicos/provenance';

export class GetProfessional {
  public constructor(
    private readonly professionals: ProfessionalFinder,
    private readonly evidence: ApprovedEvidenceFinder,
  ) {}

  public async execute(rawIdOrSlug: string): Promise<ProfessionalDetail> {
    const idOrSlug = rawIdOrSlug.trim();

    if (idOrSlug.length === 0 || idOrSlug.length > 200) {
      throw new InvalidProfessionalQueryError('The professional identifier is invalid.');
    }

    const professional = await this.professionals.findPublicByIdOrSlug(idOrSlug);

    if (professional === undefined) {
      throw new ProfessionalNotFoundError();
    }

    const nameEvidence = await this.evidence.findApprovedById(professional.currentNameEvidenceId);

    if (nameEvidence === undefined) {
      throw new ProfessionalNotFoundError();
    }

    return {
      id: professional.id,
      slug: professional.slug,
      displayName: professional.displayName,
      nameEvidence,
    };
  }
}
