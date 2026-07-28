import type { ProfessionalResearchSourceCoverage } from '../../../packages/modules/discovery/src';

export const CMU_ETHICS_SOURCE_URL =
  'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/';

export function cmuEthicsBlockedCoverage(
  policyReviewedAt = '2026-07-28',
): ProfessionalResearchSourceCoverage {
  return {
    sourceId: 'cmu-tribunal-etica-fallos',
    publisher: 'Colegio Medico del Uruguay',
    sourceUrl: CMU_ETHICS_SOURCE_URL,
    category: 'PROFESSIONAL_ETHICS_RULINGS',
    status: 'SOURCE_BLOCKED_ROBOTS',
    policyReviewedAt,
    automatedFetchPerformed: false,
    namedMatchStatus: 'NOT_CHECKED_DUE_TO_AUTOMATION_PROHIBITED',
    noFindingProvesAbsence: false,
    identityDecision: 'NOT_LINKED',
    publicationDecision: 'NOT_PUBLISHED',
    warnings: [
      'SOURCE_ROBOTS_POLICY_PROHIBITS_AUTOMATED_COLLECTION',
      'NO_FINDING_PROVES_ABSENCE',
      'AN_ETHICS_CASE_OR_MENTION_DOES_NOT_ESTABLISH_A_SANCTION',
      'NO_AUTOMATIC_IDENTITY_LINK_FROM_NAME_ONLY',
      'AUTHORIZED_OR_MANUALLY_CURATED_EVIDENCE_REQUIRES_HUMAN_REVIEW',
    ],
  };
}
