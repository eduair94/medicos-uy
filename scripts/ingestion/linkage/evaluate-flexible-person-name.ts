import { normalizePersonName } from './normalize-person-name';

export type PersonNameMatchKind =
  'EXACT_NORMALIZED_NAME' | 'PARTIAL_TOKEN_SUBSET' | 'INITIALS_TOKEN_SUBSEQUENCE';

export type PersonNameFlexibilityIndex = 0 | 1 | 2;

export interface PersonNameMatch {
  readonly kind: PersonNameMatchKind;
  /**
   * This is a looseness index, not a probability or confidence score.
   *
   * 0 = exact normalized name
   * 1 = partial token subset
   * 2 = initials plus at least one full token, in name order
   */
  readonly flexibilityIndex: PersonNameFlexibilityIndex;
  readonly canonicalTokenCount: number;
  readonly observedTokenCount: number;
  readonly exactObservedTokenCount: number;
  readonly initialObservedTokenCount: number;
}

function tokens(value: string): readonly string[] {
  return normalizePersonName(value).split(' ').filter(Boolean);
}

function uniqueTokens(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

function partialTokenSubset(
  canonicalTokens: readonly string[],
  observedTokens: readonly string[],
): boolean {
  const canonical = uniqueTokens(canonicalTokens);
  const observed = uniqueTokens(observedTokens);
  if (canonical.size < 2 || observed.size < 2 || canonical.size === observed.size) {
    return false;
  }

  const [smaller, larger] =
    canonical.size < observed.size ? [canonical, observed] : [observed, canonical];
  return [...smaller].every((token) => token.length > 1 && larger.has(token));
}

function initialsTokenSubsequence(
  canonicalTokens: readonly string[],
  observedTokens: readonly string[],
): Pick<PersonNameMatch, 'exactObservedTokenCount' | 'initialObservedTokenCount'> | null {
  if (canonicalTokens.length < 2 || observedTokens.length < 2) {
    return null;
  }

  let canonicalIndex = 0;
  let exactObservedTokenCount = 0;
  let initialObservedTokenCount = 0;

  for (const observedToken of observedTokens) {
    let matched = false;
    while (canonicalIndex < canonicalTokens.length) {
      const canonicalToken = canonicalTokens[canonicalIndex];
      canonicalIndex += 1;
      if (canonicalToken === undefined) {
        continue;
      }

      if (observedToken === canonicalToken) {
        exactObservedTokenCount += 1;
        matched = true;
        break;
      }
      if (observedToken.length === 1 && canonicalToken.startsWith(observedToken)) {
        initialObservedTokenCount += 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return null;
    }
  }

  // Initials alone (for example "M R") are too weak even for candidate generation.
  if (initialObservedTokenCount === 0 || exactObservedTokenCount === 0) {
    return null;
  }

  return { exactObservedTokenCount, initialObservedTokenCount };
}

/**
 * Classifies a deterministic name relation for candidate generation.
 *
 * It deliberately does not use edit distance, phonetics, nicknames, demographics,
 * or inferred gender. A result is never identity proof and must not be treated as
 * an automatic linkage decision.
 */
export function evaluateFlexiblePersonName(
  canonicalName: string,
  observedName: string,
): PersonNameMatch | null {
  const normalizedCanonical = normalizePersonName(canonicalName);
  const normalizedObserved = normalizePersonName(observedName);
  if (normalizedCanonical.length === 0 || normalizedObserved.length === 0) {
    return null;
  }

  const canonicalTokens = tokens(canonicalName);
  const observedTokens = tokens(observedName);
  if (normalizedCanonical === normalizedObserved) {
    return {
      kind: 'EXACT_NORMALIZED_NAME',
      flexibilityIndex: 0,
      canonicalTokenCount: canonicalTokens.length,
      observedTokenCount: observedTokens.length,
      exactObservedTokenCount: observedTokens.length,
      initialObservedTokenCount: 0,
    };
  }

  if (partialTokenSubset(canonicalTokens, observedTokens)) {
    return {
      kind: 'PARTIAL_TOKEN_SUBSET',
      flexibilityIndex: 1,
      canonicalTokenCount: canonicalTokens.length,
      observedTokenCount: observedTokens.length,
      exactObservedTokenCount: Math.min(canonicalTokens.length, observedTokens.length),
      initialObservedTokenCount: 0,
    };
  }

  const initials = initialsTokenSubsequence(canonicalTokens, observedTokens);
  if (initials === null) {
    return null;
  }
  return {
    kind: 'INITIALS_TOKEN_SUBSEQUENCE',
    flexibilityIndex: 2,
    canonicalTokenCount: canonicalTokens.length,
    observedTokenCount: observedTokens.length,
    ...initials,
  };
}
