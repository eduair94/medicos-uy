export type ResearchPersonNameMatchKind =
  | 'EXACT_NORMALIZED_NAME'
  | 'EXACT_TOKEN_MULTISET'
  | 'PARTIAL_TOKEN_SUBSET'
  | 'INITIALS_TOKEN_SUBSEQUENCE';

export type ResearchPersonNameFlexibilityIndex = 0 | 1 | 2;

export interface ResearchPersonNameMatch {
  readonly kind: ResearchPersonNameMatchKind;
  /**
   * A deterministic looseness class. It is never a probability or an identity
   * confidence score.
   */
  readonly flexibilityIndex: ResearchPersonNameFlexibilityIndex;
  readonly canonicalTokenCount: number;
  readonly observedTokenCount: number;
  readonly exactObservedTokenCount: number;
  readonly initialObservedTokenCount: number;
  readonly meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE';
}

const LEADING_HONORIFIC =
  /^(?:(?:dr|dra|doctor|doctora|prof|profesora?|lic|licenciada?|tec|tecnica?|q\s*\.?\s*f)\.?\s+)+/iu;

function removeDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function reorderSurnameFirst(value: string): string {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length !== 2) {
    return value;
  }

  const [surname, givenNames] = parts;
  return surname === undefined || givenNames === undefined ? value : `${givenNames} ${surname}`;
}

function removeParentheticalNotes(value: string): string {
  let cursor = 0;
  let result = '';

  while (cursor < value.length) {
    const openingIndex = value.indexOf('(', cursor);
    if (openingIndex === -1) {
      return result + value.slice(cursor);
    }

    const closingIndex = value.indexOf(')', openingIndex + 1);
    if (closingIndex === -1) {
      return result + value.slice(cursor);
    }

    result += `${value.slice(cursor, openingIndex)} `;
    cursor = closingIndex + 1;
  }

  return result;
}

export function normalizeResearchPersonName(value: string): string {
  const withoutParentheticalNotes = removeParentheticalNotes(value);
  const withoutHonorific = removeDiacritics(
    withoutParentheticalNotes.replace(/\u00a0/gu, ' ').trim(),
  ).replace(LEADING_HONORIFIC, '');

  return reorderSurnameFirst(withoutHonorific)
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function tokens(value: string): readonly string[] {
  return normalizeResearchPersonName(value).split(' ').filter(Boolean);
}

function tokenMultisetKey(values: readonly string[]): string {
  return [...values].sort((left, right) => left.localeCompare(right, 'es')).join('\u001f');
}

function partialTokenSubset(
  canonicalTokens: readonly string[],
  observedTokens: readonly string[],
): boolean {
  const canonical = new Set(canonicalTokens);
  const observed = new Set(observedTokens);
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
): Pick<ResearchPersonNameMatch, 'exactObservedTokenCount' | 'initialObservedTokenCount'> | null {
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

  return initialObservedTokenCount > 0 && exactObservedTokenCount > 0
    ? { exactObservedTokenCount, initialObservedTokenCount }
    : null;
}

/**
 * Produces a review candidate only. Callers must not turn this relation into an
 * automatic identity decision.
 */
export function evaluateResearchPersonName(
  canonicalName: string,
  observedName: string,
): ResearchPersonNameMatch | null {
  const normalizedCanonical = normalizeResearchPersonName(canonicalName);
  const normalizedObserved = normalizeResearchPersonName(observedName);
  if (normalizedCanonical.length === 0 || normalizedObserved.length === 0) {
    return null;
  }

  const canonicalTokens = tokens(canonicalName);
  const observedTokens = tokens(observedName);
  const base = {
    canonicalTokenCount: canonicalTokens.length,
    observedTokenCount: observedTokens.length,
    initialObservedTokenCount: 0,
    meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE' as const,
  };
  if (normalizedCanonical === normalizedObserved) {
    return {
      ...base,
      kind: 'EXACT_NORMALIZED_NAME',
      flexibilityIndex: 0,
      exactObservedTokenCount: observedTokens.length,
    };
  }
  if (tokenMultisetKey(canonicalTokens) === tokenMultisetKey(observedTokens)) {
    return {
      ...base,
      kind: 'EXACT_TOKEN_MULTISET',
      flexibilityIndex: 0,
      exactObservedTokenCount: observedTokens.length,
    };
  }
  if (partialTokenSubset(canonicalTokens, observedTokens)) {
    return {
      ...base,
      kind: 'PARTIAL_TOKEN_SUBSET',
      flexibilityIndex: 1,
      exactObservedTokenCount: Math.min(canonicalTokens.length, observedTokens.length),
    };
  }

  const initials = initialsTokenSubsequence(canonicalTokens, observedTokens);
  return initials === null
    ? null
    : {
        ...base,
        ...initials,
        kind: 'INITIALS_TOKEN_SUBSEQUENCE',
        flexibilityIndex: 2,
      };
}
