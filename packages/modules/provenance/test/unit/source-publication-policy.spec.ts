import { describe, expect, it } from 'vitest';

import { assessSourceEvidenceForPublication } from '../../src/domain/source-publication-policy';

describe('source evidence publication policy', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('allows only evidence backed by an approved source, purpose and reuse basis', () => {
    expect(
      assessSourceEvidenceForPublication(
        {
          sourcePublicationState: 'APPROVED',
          purposeCompatibility: 'COMPATIBLE',
          reuseBasis: 'OPEN_DATA_LICENSE',
          evidencePublicationState: 'APPROVED',
          confidence: 'DETERMINISTIC',
          sourceValidUntil: new Date('2026-08-27T12:00:00.000Z'),
          validUntil: new Date('2026-08-27T12:00:00.000Z'),
        },
        now,
      ),
    ).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('fails closed and explains every missing approval', () => {
    expect(
      assessSourceEvidenceForPublication(
        {
          sourcePublicationState: 'PENDING',
          purposeCompatibility: 'PENDING',
          reuseBasis: 'PENDING',
          evidencePublicationState: 'PENDING',
          confidence: 'CANDIDATE',
        },
        now,
      ),
    ).toEqual({
      allowed: false,
      reasons: [
        'SOURCE_NOT_APPROVED',
        'PURPOSE_NOT_COMPATIBLE',
        'REUSE_NOT_APPROVED',
        'EVIDENCE_NOT_APPROVED',
        'CONFIDENCE_NOT_PUBLISHABLE',
      ],
    });
  });

  it('rejects evidence at or after its validity deadline', () => {
    expect(
      assessSourceEvidenceForPublication(
        {
          sourcePublicationState: 'APPROVED',
          purposeCompatibility: 'COMPATIBLE',
          reuseBasis: 'WRITTEN_AUTHORIZATION',
          evidencePublicationState: 'APPROVED',
          confidence: 'HUMAN_VERIFIED',
          sourceValidUntil: new Date('2026-08-27T12:00:00.000Z'),
          validUntil: new Date('2026-07-27T12:00:00.000Z'),
        },
        now,
      ),
    ).toEqual({
      allowed: false,
      reasons: ['EVIDENCE_EXPIRED'],
    });
  });

  it('rejects a source approval at or after its validity deadline', () => {
    expect(
      assessSourceEvidenceForPublication(
        {
          sourcePublicationState: 'APPROVED',
          purposeCompatibility: 'COMPATIBLE',
          reuseBasis: 'WRITTEN_AUTHORIZATION',
          evidencePublicationState: 'APPROVED',
          confidence: 'HUMAN_VERIFIED',
          sourceValidUntil: now,
        },
        now,
      ),
    ).toEqual({
      allowed: false,
      reasons: ['SOURCE_APPROVAL_EXPIRED'],
    });
  });

  it('accepts reviewed official publications and claimed data with current source approval', () => {
    for (const [reuseBasis, confidence] of [
      ['OFFICIAL_PUBLICATION_REVIEW', 'HUMAN_VERIFIED'],
      ['DATA_SUBJECT_CONSENT', 'DATA_SUBJECT_CLAIMED'],
    ] as const) {
      expect(
        assessSourceEvidenceForPublication(
          {
            sourcePublicationState: 'APPROVED',
            purposeCompatibility: 'COMPATIBLE',
            reuseBasis,
            evidencePublicationState: 'APPROVED',
            confidence,
            sourceValidUntil: new Date('2026-08-27T12:00:00.000Z'),
          },
          now,
        ).allowed,
      ).toBe(true);
    }
  });

  it('fails closed when an approved source has no approval expiry', () => {
    expect(
      assessSourceEvidenceForPublication(
        {
          sourcePublicationState: 'APPROVED',
          purposeCompatibility: 'COMPATIBLE',
          reuseBasis: 'OFFICIAL_PUBLICATION_REVIEW',
          evidencePublicationState: 'APPROVED',
          confidence: 'HUMAN_VERIFIED',
        },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reasons: ['SOURCE_APPROVAL_EXPIRY_MISSING'],
    });
  });
});
