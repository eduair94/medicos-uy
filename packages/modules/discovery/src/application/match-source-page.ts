import { createHash } from 'node:crypto';

import { classifySourceContent } from '../domain/source-content-policy';

import type {
  ProfessionalSeed,
  RestrictedContentReason,
  SourcePage,
  WebEnrichmentCandidate,
} from '../domain/discovery-contracts';

export function normalizeDiscoveryName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function matchSourcePage(options: {
  readonly professionals: readonly ProfessionalSeed[];
  readonly page: SourcePage;
  readonly professionalSnapshotSha256: string;
  readonly sourcePolicySha256: string;
  readonly observedAt: string;
  readonly retentionDays: number;
}): {
  readonly candidates: readonly WebEnrichmentCandidate[];
  readonly restrictedReason?: RestrictedContentReason;
} {
  const restrictedReason = classifySourceContent(options.page.text);
  if (restrictedReason !== undefined) {
    return { candidates: [], restrictedReason };
  }

  const normalizedText = ` ${normalizeDiscoveryName(options.page.text)} `;
  const matches: {
    readonly professional: ProfessionalSeed;
    readonly evidencePhrase: string;
    readonly kind: 'EXACT_NORMALIZED_NAME' | 'PARTIAL_TOKEN_SUBSET' | 'INITIALS_TOKEN_SUBSEQUENCE';
    readonly flexibilityIndex: 0 | 1 | 2;
  }[] = [];
  for (const professional of options.professionals) {
    const normalizedName = normalizeDiscoveryName(professional.displayName);
    const tokens = normalizedName.split(' ').filter((token) => token.length > 0);
    if (tokens.length < 2) {
      continue;
    }
    if (normalizedText.includes(` ${normalizedName} `)) {
      matches.push({
        professional,
        evidencePhrase: normalizedName,
        kind: 'EXACT_NORMALIZED_NAME',
        flexibilityIndex: 0,
      });
      continue;
    }
    let partialPhrase: string | undefined;
    if (tokens.length >= 4) {
      for (
        let length = tokens.length - 1;
        length >= 3 && partialPhrase === undefined;
        length -= 1
      ) {
        for (let start = 0; start + length <= tokens.length; start += 1) {
          const phrase = tokens.slice(start, start + length).join(' ');
          if (normalizedText.includes(` ${phrase} `)) {
            partialPhrase = phrase;
            break;
          }
        }
      }
    }
    if (partialPhrase !== undefined) {
      matches.push({
        professional,
        evidencePhrase: partialPhrase,
        kind: 'PARTIAL_TOKEN_SUBSET',
        flexibilityIndex: 1,
      });
      continue;
    }
    const initialPhrase = `${tokens[0]?.slice(0, 1) ?? ''} ${tokens.at(-1) ?? ''}`;
    if (
      tokens.length >= 2 &&
      (tokens.at(-1)?.length ?? 0) >= 4 &&
      normalizedText.includes(` ${initialPhrase} `)
    ) {
      matches.push({
        professional,
        evidencePhrase: initialPhrase,
        kind: 'INITIALS_TOKEN_SUBSEQUENCE',
        flexibilityIndex: 2,
      });
    }
  }

  const expiresAt = new Date(
    Date.parse(options.observedAt) + options.retentionDays * 86_400_000,
  ).toISOString();
  const candidates: WebEnrichmentCandidate[] = [];

  const matchesByPhrase = new Map<string, typeof matches>();
  for (const match of matches) {
    const bucket = matchesByPhrase.get(match.evidencePhrase) ?? [];
    bucket.push(match);
    matchesByPhrase.set(match.evidencePhrase, bucket);
  }

  for (const match of matches) {
    const matchingPhrase = matchesByPhrase.get(match.evidencePhrase) ?? [match];
    const competingIds = matchingPhrase.map(
      ({ professional }) => professional.opaqueProfessionalId,
    );
    const professional = match.professional;
    candidates.push({
      schemaVersion: 1,
      candidateId: `web_candidate_v1_${sha256(
        [professional.opaqueProfessionalId, options.page.sourceId, options.page.contentSha256].join(
          '\u001f',
        ),
      )}`,
      state: 'NEEDS_HUMAN_REVIEW',
      quarantine: true,
      subject: {
        opaqueProfessionalId: professional.opaqueProfessionalId,
        displayName: professional.displayName,
      },
      claim: {
        category: options.page.category,
        sourceId: options.page.sourceId,
        publisher: options.page.publisher,
      },
      match: {
        kind: match.kind,
        flexibilityIndex: match.flexibilityIndex,
        meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
        ambiguity: matchingPhrase.length > 1 ? 'HOMONYM' : 'NONE',
        competingOpaqueProfessionalIds: competingIds.filter(
          (id) => id !== professional.opaqueProfessionalId,
        ),
        alerts:
          match.flexibilityIndex === 0
            ? ['NAME_MATCH_DOES_NOT_CONFIRM_IDENTITY']
            : match.flexibilityIndex === 1
              ? ['PARTIAL_NAME_MATCH_MAY_REFER_TO_ANOTHER_PERSON', 'CONTEXT_CORROBORATION_REQUIRED']
              : [
                  'INITIALS_MATCH_HAS_CRITICAL_AMBIGUITY',
                  'PROFESSION_OR_INSTITUTION_CORROBORATION_REQUIRED',
                ],
      },
      provenance: {
        canonicalUrl: options.page.canonicalUrl,
        contentSha256: options.page.contentSha256,
        retrievedAt: options.page.retrievedAt,
        transport: options.page.transport,
        professionalSnapshotSha256: options.professionalSnapshotSha256,
        sourcePolicySha256: options.sourcePolicySha256,
      },
      linkageDecision: {
        decision: 'NOT_LINKED',
        identityConfirmed: false,
      },
      factDecision: {
        factConfirmed: false,
      },
      publicationDecision: {
        decision: 'NOT_PUBLISHED',
        destination: 'INTERNAL_QUARANTINE_ONLY',
        publicExportAllowed: false,
      },
      retention: {
        expiresAt,
        disposition: 'DELETE_OR_REVALIDATE',
      },
    });
  }

  return { candidates };
}
