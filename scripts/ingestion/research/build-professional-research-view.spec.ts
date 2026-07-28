import { describe, expect, it } from 'vitest';

import { parseCuratedPublicReference } from './build-professional-research-view';

function reference(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    referenceId: `public_reference_v1_${'a'.repeat(64)}`,
    referenceKind: 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH',
    publisher: 'LinkedIn / tercero',
    canonicalUrl: 'https://es.linkedin.com/posts/example',
    title: 'Publicación académica',
    sourceDate: '2024-10-26',
    sourceDatePrecision: 'DAY',
    observedNames: ['Tamara Diaz Sanz'],
    claim: {
      relationship: 'SPECIALTY_MONOGRAPH_POSTER_COAUTHOR',
      factualSummary: 'Paráfrasis factual.',
      institutionContext: ['Hospital Vilardebó'],
      doesNotEstablish: ['IDENTITY', 'EMPLOYMENT'],
    },
    access: {
      mode: 'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH',
      automatedFetchAllowed: false,
      contentStored: false,
      rightsNote: 'URL para revisión interna.',
    },
    corroboratesReferenceIds: [],
    decision: {
      identityConfirmed: false,
      factConfirmed: false,
      linkageDecision: 'NOT_LINKED',
      publicationDecision: 'NOT_PUBLISHED',
      publicExportAllowed: false,
      requiresHumanReview: true,
    },
  };
}

describe('professional research ingestion boundary', () => {
  it('accepts a LinkedIn URL only as an unfetched internal review reference', () => {
    expect(parseCuratedPublicReference(reference(), 1)).toEqual(
      expect.objectContaining({
        referenceKind: 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH',
        access: expect.objectContaining({ automatedFetchAllowed: false }),
      }),
    );
  });

  it('rejects automated LinkedIn access, copied source bodies and publishable decisions', () => {
    const automated = reference();
    automated['access'] = {
      ...(automated['access'] as Record<string, unknown>),
      automatedFetchAllowed: true,
    };
    expect(() => parseCuratedPublicReference(automated, 1)).toThrow('LinkedIn');

    expect(() => parseCuratedPublicReference({ ...reference(), body: 'copied post' }, 1)).toThrow(
      'copied or raw source content',
    );

    expect(() =>
      parseCuratedPublicReference(
        {
          ...reference(),
          decision: {
            ...(reference()['decision'] as Record<string, unknown>),
            publicExportAllowed: true,
          },
        },
        1,
      ),
    ).toThrow('fail-closed');
  });

  it('requires a context-only document to point to a named reference', () => {
    expect(() =>
      parseCuratedPublicReference(
        {
          ...reference(),
          referenceKind: 'CONTEXT_CORROBORATION_ONLY',
          observedNames: [],
          corroboratesReferenceIds: [],
        },
        1,
      ),
    ).toThrow('context-only');
  });
});
