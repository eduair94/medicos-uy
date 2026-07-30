import type { ProfessionalResearchSourceCoverage } from '../../../packages/modules/discovery/src';

export const CMU_ETHICS_SOURCE_URL =
  'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/';
export const CMU_ETHICS_SITEMAP_URL = 'https://www.colegiomedico.org.uy/fallos-sitemap.xml';

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

export function cmuEthicsMetadataCoverage(
  policyReviewedAt = '2026-07-29',
): ProfessionalResearchSourceCoverage {
  return {
    sourceId: 'cmu-tribunal-etica-fallos',
    publisher: 'Colegio Medico del Uruguay',
    sourceUrl: CMU_ETHICS_SITEMAP_URL,
    category: 'PROFESSIONAL_ETHICS_RULINGS',
    status: 'CHECKED',
    policyReviewedAt,
    automatedFetchPerformed: true,
    namedMatchStatus: 'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
    noFindingProvesAbsence: false,
    identityDecision: 'NOT_LINKED',
    publicationDecision: 'NOT_PUBLISHED',
    warnings: [
      'PUBLIC_SITEMAP_AND_ROBOTS_ALLOWED_CASE_PAGE_METADATA_ONLY',
      'SOURCE_DOCUMENTS_AND_PDFS_WERE_NOT_FETCHED',
      'NO_FINDING_PROVES_ABSENCE',
      'AN_ETHICS_CASE_OR_MENTION_DOES_NOT_ESTABLISH_A_SANCTION',
      'NO_AUTOMATIC_IDENTITY_LINK_FROM_NAME_ONLY',
      'EXACT_NAME_CANDIDATES_REQUIRE_HUMAN_REVIEW',
    ],
  };
}
