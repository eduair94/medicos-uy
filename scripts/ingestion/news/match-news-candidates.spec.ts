import { describe, expect, it } from 'vitest';

import {
  buildNewsCandidates,
  createNewsCandidateId,
  type FactualProfessionalInput,
  type NewsCandidateBuildOptions,
  type NormalizedNewsArticleInput,
} from './match-news-candidates';

const PROFESSIONAL_ARTIFACT = {
  relativePath: 'processed/msp/infotitulos/snapshot/professionals.ndjson',
  sha256: '1'.repeat(64),
} as const;

const ARTICLE_ARTIFACT = {
  relativePath: 'normalized/news/articles.ndjson',
  sha256: '2'.repeat(64),
} as const;

function professional(
  suffix: string,
  displayName: string,
  rowNumber = 1,
  context?: FactualProfessionalInput['context'],
): FactualProfessionalInput {
  return {
    opaqueProfessionalId: `msp_doc_v1_${suffix.repeat(64)}`,
    displayName,
    ...(context === undefined ? {} : { context }),
    source: {
      publisher: 'Ministerio de Salud Pública',
      dataset: 'Infotítulos',
      sourceCutoffDate: '2026-06-30',
    },
    input: {
      format: 'MSP_INFOTITULOS_NORMALIZED',
      rowNumber,
    },
  };
}

function article(
  articleId: string,
  extractedPersonNames: readonly string[],
): NormalizedNewsArticleInput {
  return {
    schemaVersion: 1,
    articleId,
    headline: 'Titular de prueba con contexto no confirmado',
    extractedPersonNames,
    source: {
      sourceId: 'fixture',
      publisher: 'Medio de prueba',
      canonicalUrl: `https://example.test/noticias/${articleId}`,
      publishedAt: '2026-07-01T12:00:00.000Z',
      retrievedAt: '2026-07-02T12:00:00.000Z',
      contentSha256: '3'.repeat(64),
    },
    extraction: {
      method: 'HUMAN_CURATED',
      extractedAt: '2026-07-02T13:00:00.000Z',
      extractorVersion: 'fixture-v1',
    },
    input: {
      rowNumber: 1,
    },
  };
}

function options(
  professionals: readonly FactualProfessionalInput[],
  articles: readonly NormalizedNewsArticleInput[],
): NewsCandidateBuildOptions {
  return {
    professionals,
    articles,
    professionalArtifact: PROFESSIONAL_ARTIFACT,
    articleArtifact: ARTICLE_ARTIFACT,
    generatedAt: '2026-07-27T12:00:00.000Z',
    expiresAt: '2026-10-25T12:00:00.000Z',
  };
}

describe('buildNewsCandidates', () => {
  it('creates an explainable quarantined candidate for an exact normalized name', () => {
    const inputProfessional = professional('a', 'Ada Prueba Médica Uno');
    const inputArticle = article('article_exact_1', ['Dra. Ada Prueba Medica Uno']);

    const result = buildNewsCandidates(options([inputProfessional], [inputArticle]));

    expect(result.aggregates).toMatchObject({
      exactCandidates: 1,
      partialCandidates: 0,
      homonymCandidates: 0,
      ambiguousCandidates: 0,
      candidates: 1,
    });
    expect(result.candidates[0]).toMatchObject({
      state: 'NEEDS_HUMAN_REVIEW',
      quarantine: true,
      match: {
        kind: 'EXACT_NORMALIZED_NAME',
        flexibility: {
          index: 0,
          meaning: 'HIGHER_INDEX_MEANS_LOOSER_NAME_MATCH_NOT_IDENTITY_CONFIDENCE',
        },
        alert: {
          severity: 'WARNING',
        },
        reviewPriority: {
          points: 39,
          ceiling: 49,
          meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY',
        },
        ambiguity: {
          kind: 'NONE',
          matchingProfessionalCount: 1,
          contextCorroboratedProfessionalCount: 0,
        },
      },
      linkageDecision: {
        decision: 'NOT_LINKED',
        identityConfirmed: false,
      },
    });
    expect(result.candidates[0]?.match.reasons).toEqual([
      'EXACT_NORMALIZED_NAME',
      'NO_MEDICAL_CONTEXT',
      'NAME_ONLY_NO_IDENTITY_PROOF',
      'NO_CONTEXTUAL_CORROBORATION',
      'NO_SECONDARY_IDENTIFIER',
    ]);
    expect(result.candidates[0]?.candidateId).toBe(
      createNewsCandidateId(inputProfessional.opaqueProfessionalId, inputArticle.articleId),
    );
    expect(result.candidates[0]?.candidateId).not.toContain('Ada');
    expect(result.candidates[0]?.provenance.professionalInput.sha256).toBe(
      PROFESSIONAL_ARTIFACT.sha256,
    );
    expect(result.candidates[0]?.provenance.articleInput.contentSha256).toBe(
      inputArticle.source.contentSha256,
    );
  });

  it('emits one explicitly ambiguous candidate per homonym', () => {
    const first = professional('a', 'Nicolás Nube', 1);
    const second = professional('b', 'Nicolás Nube', 2);

    const result = buildNewsCandidates(
      options([first, second], [article('article_homonym_1', ['Nicolás Nube'])]),
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.aggregates).toMatchObject({
      exactCandidates: 2,
      homonymCandidates: 2,
      ambiguousCandidates: 2,
    });
    for (const candidate of result.candidates) {
      expect(candidate.match).toMatchObject({
        kind: 'EXACT_NORMALIZED_NAME',
        reviewPriority: {
          points: 20,
          ceiling: 49,
          meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY',
        },
        ambiguity: {
          kind: 'HOMONYM',
          matchingProfessionalCount: 2,
        },
      });
      expect(candidate.match.reasons).toContain('HOMONYM_NORMALIZED_NAME');
      expect(candidate.match.ambiguity.competingOpaqueProfessionalIds).toHaveLength(1);
    }
  });

  it('keeps a partial two-token subset as a lower-priority review candidate', () => {
    const inputProfessional = professional('c', 'Beatriz Elena Ejemplo Sur');

    const result = buildNewsCandidates(
      options([inputProfessional], [article('article_partial_1', ['Beatriz Ejemplo'])]),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.match).toMatchObject({
      kind: 'PARTIAL_TOKEN_SUBSET',
      reviewPriority: {
        points: 20,
        ceiling: 49,
        meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY',
      },
      flexibility: {
        index: 1,
      },
      alert: {
        severity: 'CRITICAL',
      },
      ambiguity: {
        kind: 'NONE',
        matchingProfessionalCount: 1,
      },
    });
    expect(result.candidates[0]?.match.reasons).toEqual([
      'PARTIAL_TOKEN_SUBSET',
      'NO_MEDICAL_CONTEXT',
      'NAME_ONLY_NO_IDENTITY_PROOF',
      'NO_CONTEXTUAL_CORROBORATION',
      'FLEXIBLE_NAME_MATCH_REQUIRES_ENHANCED_REVIEW',
      'NO_SECONDARY_IDENTIFIER',
    ]);
  });

  it('records profession corroboration without turning a partial name into identity proof', () => {
    const inputProfessional = professional('f', 'Beatriz Elena Ejemplo Sur', 1, {
      professions: ['ESPECIALISTA EN ANESTESIOLOGÍA'],
    });
    const inputArticle: NormalizedNewsArticleInput = {
      ...article('article_profession_context_1', ['Beatriz Ejemplo']),
      headline: 'La anestesista Beatriz Ejemplo presentó un trabajo académico',
    };

    const result = buildNewsCandidates(options([inputProfessional], [inputArticle]));
    const candidate = result.candidates[0];

    expect(result.aggregates).toMatchObject({
      partialCandidates: 1,
      initialsCandidates: 0,
      contextCorroboratedCandidates: 1,
    });
    expect(candidate?.match).toMatchObject({
      kind: 'PARTIAL_TOKEN_SUBSET',
      flexibility: {
        index: 1,
      },
      contextualCorroboration: {
        profession: {
          available: true,
          matched: true,
        },
        institution: {
          available: false,
          matched: false,
        },
        matchedDimensions: ['PROFESSION'],
      },
      alert: {
        severity: 'HIGH',
      },
    });
    expect(candidate?.match.reasons).toContain('PROFESSION_CONTEXT_MATCH');
    expect(candidate?.match.reasons).toContain('CONTEXTUAL_SIGNAL_NOT_IDENTITY_PROOF');
    expect(candidate?.match.alert.codes).toContain('CONTEXTUAL_SIGNAL_IS_NOT_IDENTITY_PROOF');
    expect(candidate?.linkageDecision.identityConfirmed).toBe(false);
    expect(candidate?.safeguards).toMatchObject({
      contextualEvidenceIsIdentityProof: false,
      missingContextTreatedAsContradiction: false,
      nameOnlyEvidence: false,
    });
  });

  it('allows initials plus a full token with a critical warning and institution context', () => {
    const inputProfessional = professional('b', 'Nicolás Andrés Nube', 1, {
      institutions: ['Asociación Española'],
    });
    const inputArticle: NormalizedNewsArticleInput = {
      ...article('article_initials_context_1', ['N. Nube']),
      headline: 'N. Nube participó en una actividad de la Española',
    };

    const result = buildNewsCandidates(options([inputProfessional], [inputArticle]));
    const candidate = result.candidates[0];

    expect(result.aggregates).toMatchObject({
      exactCandidates: 0,
      partialCandidates: 0,
      initialsCandidates: 1,
      contextCorroboratedCandidates: 1,
      criticalAlertCandidates: 1,
    });
    expect(candidate?.match).toMatchObject({
      kind: 'INITIALS_TOKEN_SUBSEQUENCE',
      flexibility: {
        index: 2,
        meaning: 'HIGHER_INDEX_MEANS_LOOSER_NAME_MATCH_NOT_IDENTITY_CONFIDENCE',
      },
      contextualCorroboration: {
        institution: {
          available: true,
          matched: true,
        },
        matchedDimensions: ['INSTITUTION'],
      },
      alert: {
        severity: 'CRITICAL',
      },
      reviewPriority: {
        points: 25,
        ceiling: 49,
      },
    });
    expect(candidate?.match.alert.codes).toContain('INITIALS_MATCH_VERY_HIGH_FALSE_POSITIVE_RISK');
    expect(candidate?.match.alert.message).toContain('identidad no está confirmada');
    expect(candidate?.publicationDecision.publicExportAllowed).toBe(false);
  });

  it('does not treat missing profession or institution data as contradictory evidence', () => {
    const inputProfessional = professional('c', 'Federico José Ficticio');
    const inputArticle = article('article_initials_no_context_1', ['F. Ficticio']);

    const result = buildNewsCandidates(options([inputProfessional], [inputArticle]));
    const candidate = result.candidates[0];

    expect(candidate?.match).toMatchObject({
      kind: 'INITIALS_TOKEN_SUBSEQUENCE',
      contextualCorroboration: {
        profession: { available: false, matched: false },
        institution: { available: false, matched: false },
        matchedDimensions: [],
      },
      alert: {
        severity: 'CRITICAL',
      },
    });
    expect(candidate?.match.alert.codes).toContain('NO_CONTEXTUAL_CORROBORATION');
    expect(candidate?.safeguards.missingContextTreatedAsContradiction).toBe(false);
    expect(candidate?.linkageDecision.identityConfirmed).toBe(false);
  });

  it('abstains from emitting a highly ambiguous flexible mention above the fan-out cap', () => {
    const professionals = Array.from({ length: 26 }, (_, index) => ({
      ...professional('d', `Nicolas${String(index)} Nube`, index + 1),
      opaqueProfessionalId: `msp_doc_v1_${index.toString(16).padStart(64, '0')}`,
    }));
    const inputArticle = article('article_initials_fanout_1', ['N. Nube']);

    const result = buildNewsCandidates(options(professionals, [inputArticle]));

    expect(result.candidates).toEqual([]);
    expect(result.aggregates).toMatchObject({
      articlesWithCandidates: 0,
      suppressedHighFanoutMentions: 1,
      candidates: 0,
    });
  });

  it('uses medical context only to prioritize review and never exceeds the name-only ceiling', () => {
    const inputProfessional = professional('f', 'Lucía Prueba');
    const inputArticle: NormalizedNewsArticleInput = {
      ...article('article_medical_context_1', ['Lucía Prueba']),
      headline: 'La doctora Lucía Prueba presentó una investigación médica',
    };

    const result = buildNewsCandidates(options([inputProfessional], [inputArticle]));
    const candidate = result.candidates[0];

    expect(candidate?.match.reviewPriority).toEqual({
      points: 49,
      ceiling: 49,
      meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY',
    });
    expect(candidate?.match.reasons).toContain('MEDICAL_CONTEXT_PRESENT');
    expect(candidate?.linkageDecision.identityConfirmed).toBe(false);
  });

  it('does not emit a candidate when names have no conservative match', () => {
    const result = buildNewsCandidates(
      options(
        [professional('d', 'Federico Ficticio')],
        [article('article_no_match_1', ['Persona Diferente'])],
      ),
    );

    expect(result.candidates).toEqual([]);
    expect(result.aggregates).toMatchObject({
      articlesWithCandidates: 0,
      articlesWithoutCandidates: 1,
      candidates: 0,
    });
  });

  it('never marks identity, facts, linkage, or publication as confirmed', () => {
    const result = buildNewsCandidates(
      options(
        [professional('e', 'Clara Prueba Dos')],
        [article('article_no_publication_1', ['Clara Prueba Dos'])],
      ),
    );
    const candidate = result.candidates[0];

    expect(candidate).toBeDefined();
    expect(candidate?.publicationDecision).toEqual({
      decision: 'NOT_PUBLISHED',
      destination: 'INTERNAL_QUARANTINE_ONLY',
      publicExportAllowed: false,
    });
    expect(candidate?.retention).toEqual({
      ttlDays: 90,
      expiresAt: '2026-10-25T12:00:00.000Z',
      disposition: 'DELETE_OR_REVALIDATE',
    });
    expect(candidate?.safeguards).toEqual({
      adverseFactInferred: false,
      articleClaimsAcceptedAsFact: false,
      automaticallyLinked: false,
      automaticallyPublished: false,
      factConfirmed: false,
      identityConfirmed: false,
      contextualEvidenceIsIdentityProof: false,
      missingContextTreatedAsContradiction: false,
      nameOnlyEvidence: true,
      requiresHumanReview: true,
    });
    expect(JSON.stringify(candidate)).not.toContain('"publicExportAllowed":true');
    expect(JSON.stringify(candidate)).not.toContain('"decision":"LINKED"');
    expect(JSON.stringify(candidate)).not.toContain('"decision":"PUBLISHED"');
  });

  it('honors an earlier source-bound expiration and rejects renewed TTLs', () => {
    const boundedOptions = {
      ...options(
        [professional('a', 'Nombre Profesional')],
        [article('article_retention_1', ['Nombre Profesional'])],
      ),
      expiresAt: '2026-08-01T12:00:00.000Z',
    };

    expect(buildNewsCandidates(boundedOptions).candidates[0]?.retention.expiresAt).toBe(
      '2026-08-01T12:00:00.000Z',
    );
    expect(() =>
      buildNewsCandidates({
        ...boundedOptions,
        expiresAt: '2026-10-25T12:00:00.001Z',
      }),
    ).toThrow('within the TTL cap');
  });
});
