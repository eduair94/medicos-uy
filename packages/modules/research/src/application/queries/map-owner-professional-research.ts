import { sanitizeOwnerResearchDossier } from '../models/owner-research-read-model';

import type {
  OwnerProfessionalResearch,
  PersistedOwnerResearchRecord,
} from '../models/owner-research-read-model';

const OWNER_RESEARCH_NOTICE = {
  associationsAreUnconfirmedCandidates: true,
  sourceDeclaredSpecialtyIsNotMspCredential: true,
  publishedScheduleIsNotRealtimeAvailability: true,
  absenceOfFindingsDoesNotProveAbsence: true,
  verifyWithOriginalSource: true,
  text: 'Las asociaciones son candidatos de investigación no confirmados. La especialidad es una etiqueta declarada por la institución, no una credencial del MSP. Los horarios publicados pueden cambiar y deben verificarse en la fuente original.',
} as const;

export function mapOwnerProfessionalResearch(
  record: PersistedOwnerResearchRecord,
): OwnerProfessionalResearch {
  const { researchView, ...metadata } = record;

  return {
    ...metadata,
    notice: OWNER_RESEARCH_NOTICE,
    dossier: sanitizeOwnerResearchDossier(researchView),
  };
}
