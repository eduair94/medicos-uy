import { createHash } from 'node:crypto';

import {
  evaluateFlexiblePersonName,
  type PersonNameMatch,
  type PersonNameMatchKind,
} from '../linkage/evaluate-flexible-person-name';
import { normalizePersonName } from '../linkage/normalize-person-name';

export const NEWS_MATCHER_ALGORITHM_VERSION = 'context-aware-flexible-name-candidates-v5' as const;
export const NEWS_CANDIDATE_RETENTION_DAYS = 90 as const;
export const NEWS_REVIEW_PRIORITY_CEILING = 49 as const;
export const NEWS_FLEXIBLE_MATCH_FANOUT_LIMIT = 25 as const;
/** @deprecated Use NEWS_REVIEW_PRIORITY_CEILING. */
export const NEWS_NAME_ONLY_REVIEW_SCORE_CEILING = NEWS_REVIEW_PRIORITY_CEILING;

export interface ArtifactReference {
  readonly relativePath: string;
  readonly sha256: string;
}

export interface FactualProfessionalInput {
  readonly opaqueProfessionalId: string;
  readonly displayName: string;
  /**
   * Optional factual context used only as a supporting review signal.
   * Missing context is never treated as contradictory evidence.
   */
  readonly context?: {
    readonly professions?: readonly string[];
    readonly institutions?: readonly string[];
  };
  readonly source: {
    readonly publisher: string;
    readonly dataset: string;
    readonly sourceCutoffDate: string;
    readonly datasetUrl?: string;
    readonly liveLookupUrl?: string;
  };
  readonly input: {
    readonly format: 'DIRECTORY_FACTUAL_V3' | 'MSP_INFOTITULOS_NORMALIZED';
    readonly rowNumber: number;
  };
}

/**
 * Input contract for a source-neutral, normalized article record.
 *
 * This matcher does not fetch pages or infer people from article prose. An upstream,
 * independently auditable extractor must provide the source metadata and the person
 * names it found. `articleId` must be a stable opaque source identifier: never a
 * person's name, document number, email address, URL, or other raw personal datum.
 */
export interface NormalizedNewsArticleInput {
  readonly schemaVersion: 1;
  readonly articleId: string;
  readonly headline: string;
  readonly extractedPersonNames: readonly string[];
  readonly source: {
    readonly sourceId: string;
    readonly publisher: string;
    readonly canonicalUrl: string;
    readonly publishedAt: string;
    readonly retrievedAt: string;
    readonly contentSha256: string;
  };
  readonly extraction: {
    readonly method: 'SOURCE_STRUCTURED_DATA' | 'DETERMINISTIC_PARSER' | 'HUMAN_CURATED';
    readonly extractedAt: string;
    readonly extractorVersion: string;
  };
  readonly input: {
    readonly rowNumber: number;
  };
}

export type NewsMatchReason =
  | 'EXACT_NORMALIZED_NAME'
  | 'PARTIAL_TOKEN_SUBSET'
  | 'INITIALS_TOKEN_SUBSEQUENCE'
  | 'HOMONYM_NORMALIZED_NAME'
  | 'MULTIPLE_PROFESSIONALS_MATCH_MENTION'
  | 'MEDICAL_CONTEXT_PRESENT'
  | 'NO_MEDICAL_CONTEXT'
  | 'NAME_ONLY_NO_IDENTITY_PROOF'
  | 'NO_CONTEXTUAL_CORROBORATION'
  | 'PROFESSION_CONTEXT_MATCH'
  | 'INSTITUTION_CONTEXT_MATCH'
  | 'CONTEXTUAL_SIGNAL_NOT_IDENTITY_PROOF'
  | 'FLEXIBLE_NAME_MATCH_REQUIRES_ENHANCED_REVIEW'
  | 'NO_SECONDARY_IDENTIFIER';

export type NewsMatchAlertCode =
  | 'POSSIBLE_IDENTITY_MATCH_NOT_CONFIRMED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'NAME_MATCH_IS_NOT_IDENTITY_PROOF'
  | 'FLEXIBLE_MATCH_HIGH_FALSE_POSITIVE_RISK'
  | 'INITIALS_MATCH_VERY_HIGH_FALSE_POSITIVE_RISK'
  | 'NO_CONTEXTUAL_CORROBORATION'
  | 'CONTEXTUAL_SIGNAL_IS_NOT_IDENTITY_PROOF'
  | 'MULTIPLE_POSSIBLE_IDENTITIES';

export interface NewsLinkageCandidate {
  readonly schemaVersion: 2;
  readonly candidateId: string;
  readonly state: 'NEEDS_HUMAN_REVIEW';
  readonly quarantine: true;
  readonly professional: {
    readonly opaqueProfessionalId: string;
    readonly displayName: string;
  };
  readonly article: {
    readonly articleId: string;
    readonly headline: string;
    readonly matchedMention: string;
  };
  readonly match: {
    readonly kind: PersonNameMatchKind;
    readonly flexibility: {
      readonly index: PersonNameMatch['flexibilityIndex'];
      readonly meaning: 'HIGHER_INDEX_MEANS_LOOSER_NAME_MATCH_NOT_IDENTITY_CONFIDENCE';
    };
    readonly contextualCorroboration: {
      readonly profession: {
        readonly available: boolean;
        readonly matched: boolean;
      };
      readonly institution: {
        readonly available: boolean;
        readonly matched: boolean;
      };
      readonly matchedDimensions: readonly ('PROFESSION' | 'INSTITUTION')[];
      readonly meaning: 'SUPPORTING_REVIEW_SIGNAL_NOT_IDENTITY_PROOF';
    };
    readonly alert: {
      readonly severity: 'WARNING' | 'HIGH' | 'CRITICAL';
      readonly codes: readonly NewsMatchAlertCode[];
      readonly message: string;
    };
    readonly reviewPriority: {
      readonly points: number;
      readonly ceiling: typeof NEWS_REVIEW_PRIORITY_CEILING;
      readonly meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY';
    };
    readonly reasons: readonly NewsMatchReason[];
    readonly explanation: string;
    readonly ambiguity: {
      readonly kind: 'NONE' | 'HOMONYM' | 'MULTIPLE_POSSIBLE_PROFESSIONALS';
      readonly matchingProfessionalCount: number;
      readonly contextCorroboratedProfessionalCount: number;
      readonly competingOpaqueProfessionalIds: readonly string[];
    };
  };
  readonly provenance: {
    readonly professionalInput: ArtifactReference & {
      readonly format: FactualProfessionalInput['input']['format'];
      readonly rowNumber: number;
      readonly publisher: string;
      readonly dataset: string;
      readonly sourceCutoffDate: string;
      readonly datasetUrl: string | null;
      readonly liveLookupUrl: string | null;
    };
    readonly articleInput: ArtifactReference & {
      readonly rowNumber: number;
      readonly articleId: string;
      readonly publisher: string;
      readonly canonicalUrl: string;
      readonly publishedAt: string;
      readonly retrievedAt: string;
      readonly contentSha256: string;
      readonly extraction: NormalizedNewsArticleInput['extraction'];
    };
    readonly matcher: {
      readonly algorithmVersion: typeof NEWS_MATCHER_ALGORITHM_VERSION;
      readonly generatedAt: string;
      readonly matchedMentionSha256: string;
    };
  };
  readonly linkageDecision: {
    readonly decision: 'NOT_LINKED';
    readonly identityConfirmed: false;
  };
  readonly publicationDecision: {
    readonly decision: 'NOT_PUBLISHED';
    readonly destination: 'INTERNAL_QUARANTINE_ONLY';
    readonly publicExportAllowed: false;
  };
  readonly retention: {
    readonly ttlDays: typeof NEWS_CANDIDATE_RETENTION_DAYS;
    readonly expiresAt: string;
    readonly disposition: 'DELETE_OR_REVALIDATE';
  };
  readonly safeguards: {
    readonly adverseFactInferred: false;
    readonly articleClaimsAcceptedAsFact: false;
    readonly automaticallyLinked: false;
    readonly automaticallyPublished: false;
    readonly factConfirmed: false;
    readonly identityConfirmed: false;
    readonly contextualEvidenceIsIdentityProof: false;
    readonly missingContextTreatedAsContradiction: false;
    readonly nameOnlyEvidence: boolean;
    readonly requiresHumanReview: true;
  };
}

export interface NewsCandidateAggregates {
  readonly professionals: number;
  readonly articles: number;
  readonly articlePersonMentions: number;
  readonly articlesWithCandidates: number;
  readonly articlesWithoutCandidates: number;
  readonly exactCandidates: number;
  readonly partialCandidates: number;
  readonly initialsCandidates: number;
  readonly contextCorroboratedCandidates: number;
  readonly criticalAlertCandidates: number;
  readonly suppressedHighFanoutMentions: number;
  readonly homonymCandidates: number;
  readonly ambiguousCandidates: number;
  readonly candidates: number;
}

export interface NewsCandidateBuildResult {
  readonly candidates: readonly NewsLinkageCandidate[];
  readonly aggregates: NewsCandidateAggregates;
}

export interface NewsCandidateBuildOptions {
  readonly professionals: readonly FactualProfessionalInput[];
  readonly articles: readonly NormalizedNewsArticleInput[];
  readonly professionalArtifact: ArtifactReference;
  readonly articleArtifact: ArtifactReference;
  readonly generatedAt: string;
  readonly expiresAt: string;
}

interface CandidateMatch {
  readonly professional: FactualProfessionalInput;
  readonly article: NormalizedNewsArticleInput;
  readonly mention: string;
  readonly normalizedMention: string;
  readonly kind: NewsLinkageCandidate['match']['kind'];
  readonly nameMatch: PersonNameMatch;
  readonly contextualCorroboration: NewsLinkageCandidate['match']['contextualCorroboration'];
  readonly medicalContextPresent: boolean;
  readonly reviewPriorityPoints: number;
  readonly ambiguity: NewsLinkageCandidate['match']['ambiguity'];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function normalizedTokens(value: string): readonly string[] {
  return normalizePersonName(value).split(' ').filter(Boolean);
}

function uniqueTokens(tokens: readonly string[]): ReadonlySet<string> {
  return new Set(tokens);
}

const GENERIC_CONTEXT_TOKENS = new Set([
  'ASOCIACION',
  'CENTRO',
  'CLINICA',
  'DE',
  'DEL',
  'DOCTOR',
  'DOCTORA',
  'EN',
  'ESPECIALISTA',
  'GENERAL',
  'HOSPITAL',
  'INSTITUCION',
  'MEDICA',
  'MEDICO',
  'MEDICINA',
  'MUTUALISTA',
  'SANATORIO',
  'SERVICIO',
  'SOCIEDAD',
  'Y',
]);
const DISTINCTIVE_CONTEXT_STEMS = [
  'ANESTES',
  'CARDIOL',
  'CIRU',
  'DERMATOL',
  'ENDOCRINOL',
  'GASTROENTEROL',
  'GERIATR',
  'GINECOL',
  'HEMATOL',
  'INFECTOL',
  'NEFROL',
  'NEUMOL',
  'NEUROL',
  'OFTALMOL',
  'ONCOL',
  'OTORRINOLARINGOL',
  'PSIQUIATR',
  'REUMATOL',
  'TRAUMATOL',
  'UROL',
] as const;

function meaningfulContextTokens(value: string): readonly string[] {
  return normalizedTokens(value).filter(
    (token) => token.length >= 3 && !GENERIC_CONTEXT_TOKENS.has(token),
  );
}

function sharedPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function contextTokenMatches(left: string, right: string): boolean {
  return (
    left === right ||
    DISTINCTIVE_CONTEXT_STEMS.some((stem) => left.startsWith(stem) && right.startsWith(stem)) ||
    (left.length >= 6 && right.length >= 6 && sharedPrefixLength(left, right) >= 6)
  );
}

function evaluateContextDimension(
  values: readonly string[] | undefined,
  headlineTokens: readonly string[],
): { readonly available: boolean; readonly matched: boolean } {
  const terms = (values ?? []).map(meaningfulContextTokens).filter((tokens) => tokens.length > 0);
  return {
    available: terms.length > 0,
    matched: terms.some((termTokens) =>
      termTokens.some((termToken) =>
        headlineTokens.some((headlineToken) => contextTokenMatches(termToken, headlineToken)),
      ),
    ),
  };
}

function contextualCorroborationFor(
  professional: FactualProfessionalInput,
  headline: string,
): NewsLinkageCandidate['match']['contextualCorroboration'] {
  const headlineTokens = normalizedTokens(headline);
  const profession = evaluateContextDimension(professional.context?.professions, headlineTokens);
  const institution = evaluateContextDimension(professional.context?.institutions, headlineTokens);
  const matchedDimensions: ('PROFESSION' | 'INSTITUTION')[] = [];
  if (profession.matched) {
    matchedDimensions.push('PROFESSION');
  }
  if (institution.matched) {
    matchedDimensions.push('INSTITUTION');
  }
  return {
    profession,
    institution,
    matchedDimensions,
    meaning: 'SUPPORTING_REVIEW_SIGNAL_NOT_IDENTITY_PROOF',
  };
}

function hasMedicalContext(value: string): boolean {
  const tokens = normalizePersonName(value).toLowerCase().split(' ').filter(Boolean);
  if (tokens.some((token) => token === 'dr' || token === 'dra')) {
    return true;
  }
  return [
    'anestesi',
    'asse',
    'ciruj',
    'clinica',
    'doctor',
    'doctora',
    'hospital',
    'medic',
    'msp',
    'mutualista',
    'sanatorio',
    'salud',
  ].some((signal) => tokens.some((token) => token.startsWith(signal)));
}

function partialReviewPriorityPoints(
  professionalName: string,
  mention: string,
  matchingProfessionalCount: number,
  medicalContextPresent: boolean,
  contextualCorroborationPresent: boolean,
): number {
  const professionalTokenCount = uniqueTokens(normalizedTokens(professionalName)).size;
  const mentionTokenCount = uniqueTokens(normalizedTokens(mention)).size;
  const coverage =
    Math.min(professionalTokenCount, mentionTokenCount) /
    Math.max(professionalTokenCount, mentionTokenCount);
  const ambiguityPenalty = matchingProfessionalCount > 1 ? 10 : 0;
  const contextPenalty = medicalContextPresent ? 0 : 10;
  const corroborationBonus = contextualCorroborationPresent ? 10 : 0;
  return Math.max(
    1,
    Math.min(
      NEWS_REVIEW_PRIORITY_CEILING,
      Math.round(20 + coverage * 20 + corroborationBonus - ambiguityPenalty - contextPenalty),
    ),
  );
}

function exactReviewPriorityPoints(
  matchingProfessionalCount: number,
  medicalContextPresent: boolean,
  contextualCorroborationPresent: boolean,
): number {
  const base = matchingProfessionalCount > 1 ? 30 : NEWS_REVIEW_PRIORITY_CEILING;
  return Math.max(
    1,
    Math.min(
      NEWS_REVIEW_PRIORITY_CEILING,
      base - (medicalContextPresent ? 0 : 10) + (contextualCorroborationPresent ? 5 : 0),
    ),
  );
}

function initialsReviewPriorityPoints(
  matchingProfessionalCount: number,
  medicalContextPresent: boolean,
  contextualCorroborationPresent: boolean,
): number {
  return Math.max(
    1,
    Math.min(
      NEWS_REVIEW_PRIORITY_CEILING,
      10 +
        (medicalContextPresent ? 5 : 0) +
        (contextualCorroborationPresent ? 15 : 0) -
        (matchingProfessionalCount > 1 ? 10 : 0),
    ),
  );
}

export function newsCandidateExpiresAt(generatedAt: string): string {
  const generatedAtMilliseconds = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMilliseconds)) {
    throw new Error('News candidate generation time is invalid');
  }
  return new Date(
    generatedAtMilliseconds + NEWS_CANDIDATE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

/**
 * The ID deliberately uses only two pre-existing opaque identifiers. Names,
 * headlines and URLs never enter the identifier material.
 */
export function createNewsCandidateId(opaqueProfessionalId: string, articleId: string): string {
  return `news_candidate_v1_${sha256(
    ['news-candidate:v1', opaqueProfessionalId, articleId].join('\u0000'),
  )}`;
}

function reasonsFor(match: CandidateMatch): readonly NewsMatchReason[] {
  const contextPresent = match.contextualCorroboration.matchedDimensions.length > 0;
  const reasons: NewsMatchReason[] = [match.kind];
  if (match.ambiguity.kind === 'HOMONYM') {
    reasons.push('HOMONYM_NORMALIZED_NAME');
  } else if (match.ambiguity.kind === 'MULTIPLE_POSSIBLE_PROFESSIONALS') {
    reasons.push('MULTIPLE_PROFESSIONALS_MATCH_MENTION');
  }
  reasons.push(match.medicalContextPresent ? 'MEDICAL_CONTEXT_PRESENT' : 'NO_MEDICAL_CONTEXT');
  if (match.contextualCorroboration.profession.matched) {
    reasons.push('PROFESSION_CONTEXT_MATCH');
  }
  if (match.contextualCorroboration.institution.matched) {
    reasons.push('INSTITUTION_CONTEXT_MATCH');
  }
  if (contextPresent) {
    reasons.push('CONTEXTUAL_SIGNAL_NOT_IDENTITY_PROOF');
  } else {
    reasons.push('NAME_ONLY_NO_IDENTITY_PROOF', 'NO_CONTEXTUAL_CORROBORATION');
  }
  if (match.kind !== 'EXACT_NORMALIZED_NAME') {
    reasons.push('FLEXIBLE_NAME_MATCH_REQUIRES_ENHANCED_REVIEW');
  }
  reasons.push('NO_SECONDARY_IDENTIFIER');
  return reasons;
}

function explanationFor(match: CandidateMatch): string {
  const contextExplanation = match.medicalContextPresent
    ? 'El titular contiene una señal léxica de contexto médico, que no acredita identidad.'
    : 'El titular no contiene una señal léxica de contexto médico, por lo que la prioridad de revisión se reduce.';
  const corroborationExplanation =
    match.contextualCorroboration.matchedDimensions.length > 0
      ? `Hay coincidencia contextual de ${match.contextualCorroboration.matchedDimensions
          .map((dimension) => (dimension === 'PROFESSION' ? 'profesión' : 'institución'))
          .join(' e ')}, pero es sólo una señal de apoyo y tampoco acredita identidad.`
      : 'No se encontró corroboración contextual por profesión o institución; la ausencia de esos datos no se interpreta como contradicción.';
  if (match.ambiguity.kind === 'HOMONYM') {
    return `El nombre normalizado coincide exactamente con más de un profesional. Es una hipótesis ambigua y no acredita identidad. ${corroborationExplanation} ${contextExplanation}`;
  }
  if (match.ambiguity.kind === 'MULTIPLE_POSSIBLE_PROFESSIONALS') {
    return `La mención flexible es compatible con varios profesionales. Es una hipótesis ambigua y no acredita identidad. ${corroborationExplanation} ${contextExplanation}`;
  }
  if (match.kind === 'EXACT_NORMALIZED_NAME') {
    return `El nombre normalizado coincide exactamente, pero no acredita identidad ni confirma hechos del artículo. ${corroborationExplanation} ${contextExplanation}`;
  }
  if (match.kind === 'PARTIAL_TOKEN_SUBSET') {
    return `La mención contiene un subconjunto de al menos dos tokens del nombre. Tiene riesgo elevado de falso positivo y requiere identificadores secundarios y revisión humana. ${corroborationExplanation} ${contextExplanation}`;
  }
  return `La mención combina una o más iniciales con al menos un token completo del nombre, en el mismo orden. Tiene riesgo muy alto de falso positivo y requiere identificadores secundarios y revisión humana reforzada. ${corroborationExplanation} ${contextExplanation}`;
}

function alertFor(match: CandidateMatch): NewsLinkageCandidate['match']['alert'] {
  const contextPresent = match.contextualCorroboration.matchedDimensions.length > 0;
  const codes: NewsMatchAlertCode[] = [
    'POSSIBLE_IDENTITY_MATCH_NOT_CONFIRMED',
    'HUMAN_REVIEW_REQUIRED',
    'NAME_MATCH_IS_NOT_IDENTITY_PROOF',
  ];
  if (match.kind !== 'EXACT_NORMALIZED_NAME') {
    codes.push('FLEXIBLE_MATCH_HIGH_FALSE_POSITIVE_RISK');
  }
  if (match.kind === 'INITIALS_TOKEN_SUBSEQUENCE') {
    codes.push('INITIALS_MATCH_VERY_HIGH_FALSE_POSITIVE_RISK');
  }
  if (contextPresent) {
    codes.push('CONTEXTUAL_SIGNAL_IS_NOT_IDENTITY_PROOF');
  } else {
    codes.push('NO_CONTEXTUAL_CORROBORATION');
  }
  if (match.ambiguity.kind !== 'NONE') {
    codes.push('MULTIPLE_POSSIBLE_IDENTITIES');
  }

  const severity =
    match.kind === 'INITIALS_TOKEN_SUBSEQUENCE' ||
    match.ambiguity.kind !== 'NONE' ||
    (match.kind === 'PARTIAL_TOKEN_SUBSET' && !contextPresent)
      ? 'CRITICAL'
      : match.kind === 'PARTIAL_TOKEN_SUBSET'
        ? 'HIGH'
        : 'WARNING';
  const matchDescription =
    match.kind === 'EXACT_NORMALIZED_NAME'
      ? 'nombre completo normalizado'
      : match.kind === 'PARTIAL_TOKEN_SUBSET'
        ? 'nombre parcial'
        : 'iniciales y nombre parcial';
  return {
    severity,
    codes,
    message: `Posible coincidencia por ${matchDescription}. La identidad no está confirmada; no atribuir el artículo, sus hechos ni conclusiones al profesional sin revisión humana y evidencia secundaria verificable.`,
  };
}

function createCandidate(
  match: CandidateMatch,
  options: NewsCandidateBuildOptions,
): NewsLinkageCandidate {
  const professionalSource = match.professional.source;
  const articleSource = match.article.source;
  const contextualCorroborationPresent = match.contextualCorroboration.matchedDimensions.length > 0;
  return {
    schemaVersion: 2,
    candidateId: createNewsCandidateId(
      match.professional.opaqueProfessionalId,
      match.article.articleId,
    ),
    state: 'NEEDS_HUMAN_REVIEW',
    quarantine: true,
    professional: {
      opaqueProfessionalId: match.professional.opaqueProfessionalId,
      displayName: match.professional.displayName,
    },
    article: {
      articleId: match.article.articleId,
      headline: match.article.headline,
      matchedMention: match.mention,
    },
    match: {
      kind: match.kind,
      flexibility: {
        index: match.nameMatch.flexibilityIndex,
        meaning: 'HIGHER_INDEX_MEANS_LOOSER_NAME_MATCH_NOT_IDENTITY_CONFIDENCE',
      },
      contextualCorroboration: match.contextualCorroboration,
      alert: alertFor(match),
      reviewPriority: {
        points: match.reviewPriorityPoints,
        ceiling: NEWS_REVIEW_PRIORITY_CEILING,
        meaning: 'REVIEW_TRIAGE_HEURISTIC_NOT_IDENTITY_PROBABILITY',
      },
      reasons: reasonsFor(match),
      explanation: explanationFor(match),
      ambiguity: match.ambiguity,
    },
    provenance: {
      professionalInput: {
        ...options.professionalArtifact,
        format: match.professional.input.format,
        rowNumber: match.professional.input.rowNumber,
        publisher: professionalSource.publisher,
        dataset: professionalSource.dataset,
        sourceCutoffDate: professionalSource.sourceCutoffDate,
        datasetUrl: professionalSource.datasetUrl ?? null,
        liveLookupUrl: professionalSource.liveLookupUrl ?? null,
      },
      articleInput: {
        ...options.articleArtifact,
        rowNumber: match.article.input.rowNumber,
        articleId: match.article.articleId,
        publisher: articleSource.publisher,
        canonicalUrl: articleSource.canonicalUrl,
        publishedAt: articleSource.publishedAt,
        retrievedAt: articleSource.retrievedAt,
        contentSha256: articleSource.contentSha256,
        extraction: match.article.extraction,
      },
      matcher: {
        algorithmVersion: NEWS_MATCHER_ALGORITHM_VERSION,
        generatedAt: options.generatedAt,
        matchedMentionSha256: sha256(match.normalizedMention),
      },
    },
    linkageDecision: {
      decision: 'NOT_LINKED',
      identityConfirmed: false,
    },
    publicationDecision: {
      decision: 'NOT_PUBLISHED',
      destination: 'INTERNAL_QUARANTINE_ONLY',
      publicExportAllowed: false,
    },
    retention: {
      ttlDays: NEWS_CANDIDATE_RETENTION_DAYS,
      expiresAt: options.expiresAt,
      disposition: 'DELETE_OR_REVALIDATE',
    },
    safeguards: {
      adverseFactInferred: false,
      articleClaimsAcceptedAsFact: false,
      automaticallyLinked: false,
      automaticallyPublished: false,
      factConfirmed: false,
      identityConfirmed: false,
      contextualEvidenceIsIdentityProof: false,
      missingContextTreatedAsContradiction: false,
      nameOnlyEvidence: !contextualCorroborationPresent,
      requiresHumanReview: true,
    },
  };
}

function strongerMatch(left: CandidateMatch, right: CandidateMatch): CandidateMatch {
  if (left.nameMatch.flexibilityIndex !== right.nameMatch.flexibilityIndex) {
    return left.nameMatch.flexibilityIndex < right.nameMatch.flexibilityIndex ? left : right;
  }
  const leftContextCount = left.contextualCorroboration.matchedDimensions.length;
  const rightContextCount = right.contextualCorroboration.matchedDimensions.length;
  if (leftContextCount !== rightContextCount) {
    return leftContextCount > rightContextCount ? left : right;
  }
  if (left.reviewPriorityPoints !== right.reviewPriorityPoints) {
    return left.reviewPriorityPoints > right.reviewPriorityPoints ? left : right;
  }
  return compareText(left.normalizedMention, right.normalizedMention) <= 0 ? left : right;
}

function assertUniqueInputs(options: NewsCandidateBuildOptions): void {
  const professionalIds = new Set<string>();
  for (const professional of options.professionals) {
    if (professionalIds.has(professional.opaqueProfessionalId)) {
      throw new Error(`Duplicate opaque professional id: ${professional.opaqueProfessionalId}`);
    }
    professionalIds.add(professional.opaqueProfessionalId);
  }

  const articleIds = new Set<string>();
  for (const article of options.articles) {
    if (articleIds.has(article.articleId)) {
      throw new Error(`Duplicate article id: ${article.articleId}`);
    }
    articleIds.add(article.articleId);
  }
}

export function buildNewsCandidates(options: NewsCandidateBuildOptions): NewsCandidateBuildResult {
  const generatedAtMilliseconds = Date.parse(options.generatedAt);
  const expiresAtMilliseconds = Date.parse(options.expiresAt);
  const maximumExpiresAtMilliseconds = Date.parse(newsCandidateExpiresAt(options.generatedAt));
  if (
    !Number.isFinite(expiresAtMilliseconds) ||
    new Date(expiresAtMilliseconds).toISOString() !== options.expiresAt ||
    expiresAtMilliseconds <= generatedAtMilliseconds ||
    expiresAtMilliseconds > maximumExpiresAtMilliseconds
  ) {
    throw new Error('News candidate expiration must be canonical, future, and within the TTL cap');
  }
  assertUniqueInputs(options);
  const professionals = [...options.professionals].sort((left, right) =>
    compareText(left.opaqueProfessionalId, right.opaqueProfessionalId),
  );
  const exactByNormalizedName = new Map<string, FactualProfessionalInput[]>();
  for (const professional of professionals) {
    const normalizedName = normalizePersonName(professional.displayName);
    const current = exactByNormalizedName.get(normalizedName) ?? [];
    current.push(professional);
    exactByNormalizedName.set(normalizedName, current);
  }

  const selectedByPair = new Map<string, CandidateMatch>();
  const articlesWithCandidates = new Set<string>();
  let suppressedHighFanoutMentions = 0;
  for (const article of options.articles) {
    for (const mention of article.extractedPersonNames) {
      const normalizedMention = normalizePersonName(mention);
      const exactProfessionals = exactByNormalizedName.get(normalizedMention) ?? [];
      const matchingProfessionals: {
        readonly professional: FactualProfessionalInput;
        readonly nameMatch: PersonNameMatch;
        readonly contextualCorroboration: NewsLinkageCandidate['match']['contextualCorroboration'];
      }[] = [];
      for (const professional of exactProfessionals.length > 0
        ? exactProfessionals
        : professionals) {
        const nameMatch = evaluateFlexiblePersonName(professional.displayName, mention);
        if (nameMatch === null) {
          continue;
        }
        matchingProfessionals.push({
          professional,
          nameMatch,
          contextualCorroboration: contextualCorroborationFor(professional, article.headline),
        });
      }
      if (matchingProfessionals.length === 0) {
        continue;
      }
      if (
        exactProfessionals.length === 0 &&
        matchingProfessionals.length > NEWS_FLEXIBLE_MATCH_FANOUT_LIMIT
      ) {
        suppressedHighFanoutMentions += 1;
        continue;
      }

      const ambiguityKind =
        matchingProfessionals.length === 1
          ? 'NONE'
          : exactProfessionals.length > 0
            ? 'HOMONYM'
            : 'MULTIPLE_POSSIBLE_PROFESSIONALS';
      const matchingIds = matchingProfessionals
        .map(({ professional }) => professional.opaqueProfessionalId)
        .sort(compareText);
      const contextCorroboratedProfessionalCount = matchingProfessionals.filter(
        ({ contextualCorroboration }) => contextualCorroboration.matchedDimensions.length > 0,
      ).length;
      const medicalContextPresent = hasMedicalContext(article.headline);

      for (const { professional, nameMatch, contextualCorroboration } of matchingProfessionals) {
        const kind = nameMatch.kind;
        const contextualCorroborationPresent = contextualCorroboration.matchedDimensions.length > 0;
        const reviewPriorityPoints =
          kind === 'EXACT_NORMALIZED_NAME'
            ? exactReviewPriorityPoints(
                matchingProfessionals.length,
                medicalContextPresent,
                contextualCorroborationPresent,
              )
            : kind === 'PARTIAL_TOKEN_SUBSET'
              ? partialReviewPriorityPoints(
                  professional.displayName,
                  mention,
                  matchingProfessionals.length,
                  medicalContextPresent,
                  contextualCorroborationPresent,
                )
              : initialsReviewPriorityPoints(
                  matchingProfessionals.length,
                  medicalContextPresent,
                  contextualCorroborationPresent,
                );
        const match: CandidateMatch = {
          professional,
          article,
          mention,
          normalizedMention,
          kind,
          nameMatch,
          contextualCorroboration,
          medicalContextPresent,
          reviewPriorityPoints,
          ambiguity: {
            kind: ambiguityKind,
            matchingProfessionalCount: matchingProfessionals.length,
            contextCorroboratedProfessionalCount,
            competingOpaqueProfessionalIds: matchingIds.filter(
              (id) => id !== professional.opaqueProfessionalId,
            ),
          },
        };
        const pairKey = `${professional.opaqueProfessionalId}\u0000${article.articleId}`;
        const existing = selectedByPair.get(pairKey);
        selectedByPair.set(
          pairKey,
          existing === undefined ? match : strongerMatch(existing, match),
        );
        articlesWithCandidates.add(article.articleId);
      }
    }
  }

  const matches = [...selectedByPair.values()].sort(
    (left, right) =>
      compareText(
        left.professional.opaqueProfessionalId,
        right.professional.opaqueProfessionalId,
      ) || compareText(left.article.articleId, right.article.articleId),
  );
  const candidates = matches.map((match) => createCandidate(match, options));
  const exactCandidates = candidates.filter(
    ({ match }) => match.kind === 'EXACT_NORMALIZED_NAME',
  ).length;
  const partialCandidates = candidates.filter(
    ({ match }) => match.kind === 'PARTIAL_TOKEN_SUBSET',
  ).length;
  const initialsCandidates = candidates.filter(
    ({ match }) => match.kind === 'INITIALS_TOKEN_SUBSEQUENCE',
  ).length;
  const contextCorroboratedCandidates = candidates.filter(
    ({ match }) => match.contextualCorroboration.matchedDimensions.length > 0,
  ).length;
  const criticalAlertCandidates = candidates.filter(
    ({ match }) => match.alert.severity === 'CRITICAL',
  ).length;
  const homonymCandidates = candidates.filter(
    ({ match }) => match.ambiguity.kind === 'HOMONYM',
  ).length;
  const ambiguousCandidates = candidates.filter(
    ({ match }) => match.ambiguity.kind !== 'NONE',
  ).length;

  return {
    candidates,
    aggregates: {
      professionals: professionals.length,
      articles: options.articles.length,
      articlePersonMentions: options.articles.reduce(
        (total, { extractedPersonNames }) => total + extractedPersonNames.length,
        0,
      ),
      articlesWithCandidates: articlesWithCandidates.size,
      articlesWithoutCandidates: options.articles.length - articlesWithCandidates.size,
      exactCandidates,
      partialCandidates,
      initialsCandidates,
      contextCorroboratedCandidates,
      criticalAlertCandidates,
      suppressedHighFanoutMentions,
      homonymCandidates,
      ambiguousCandidates,
      candidates: candidates.length,
    },
  };
}
