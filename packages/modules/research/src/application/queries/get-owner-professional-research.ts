import {
  InvalidOwnerResearchQueryError,
  OwnerResearchNotFoundError,
} from '../errors/owner-research.error';
import { sanitizeOwnerResearchDossier } from '../models/owner-research-read-model';

import type { OwnerProfessionalResearch } from '../models/owner-research-read-model';
import type { OwnerResearchLookup, OwnerResearchReader } from '../ports/owner-research-reader.port';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function parseLookup(rawIdOrSlug: string): OwnerResearchLookup {
  const idOrSlug = rawIdOrSlug.trim();

  if (UUID_PATTERN.test(idOrSlug)) {
    return {
      kind: 'PUBLIC_UUID',
      value: idOrSlug.toLowerCase(),
    };
  }

  const slug = idOrSlug.toLocaleLowerCase('en-US');

  if (slug.length === 0 || slug.length > 200 || !SLUG_PATTERN.test(slug)) {
    throw new InvalidOwnerResearchQueryError();
  }

  return {
    kind: 'SLUG',
    value: slug,
  };
}

export class GetOwnerProfessionalResearch {
  public constructor(private readonly research: OwnerResearchReader) {}

  public async execute(rawIdOrSlug: string): Promise<OwnerProfessionalResearch> {
    const record = await this.research.findLatestByProfessional(parseLookup(rawIdOrSlug));

    if (record === undefined) {
      throw new OwnerResearchNotFoundError();
    }

    const { researchView, ...metadata } = record;

    return {
      ...metadata,
      notice: {
        associationsAreUnconfirmedCandidates: true,
        sourceDeclaredSpecialtyIsNotMspCredential: true,
        publishedScheduleIsNotRealtimeAvailability: true,
        absenceOfFindingsDoesNotProveAbsence: true,
        verifyWithOriginalSource: true,
        text: 'Las asociaciones son candidatos de investigación no confirmados. La especialidad es una etiqueta declarada por la institución, no una credencial del MSP. Los horarios publicados pueden cambiar y deben verificarse en la fuente original.',
      },
      dossier: sanitizeOwnerResearchDossier(researchView),
    };
  }
}
