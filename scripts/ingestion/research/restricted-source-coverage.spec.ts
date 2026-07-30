import { describe, expect, it } from 'vitest';

import { CMU_ETHICS_SOURCE_URL, cmuEthicsBlockedCoverage } from './restricted-source-coverage';

describe('CMU ethics source coverage', () => {
  it('records the official source as blocked, unqueried, unlinked and unpublished', () => {
    expect(cmuEthicsBlockedCoverage('2026-07-28')).toEqual({
      sourceId: 'cmu-tribunal-etica-fallos',
      publisher: 'Colegio Medico del Uruguay',
      sourceUrl: CMU_ETHICS_SOURCE_URL,
      category: 'PROFESSIONAL_ETHICS_RULINGS',
      status: 'SOURCE_BLOCKED_ROBOTS',
      policyReviewedAt: '2026-07-28',
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
    });
  });

  it('returns independent metadata objects for each dossier', () => {
    const first = cmuEthicsBlockedCoverage();
    const second = cmuEthicsBlockedCoverage();

    expect(first).not.toBe(second);
    expect(first.warnings).not.toBe(second.warnings);
  });
});
