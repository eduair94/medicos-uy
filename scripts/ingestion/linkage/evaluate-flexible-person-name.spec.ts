import { describe, expect, it } from 'vitest';

import { evaluateFlexiblePersonName } from './evaluate-flexible-person-name';

describe('evaluateFlexiblePersonName', () => {
  it('classifies an exact normalized name at flexibility index zero', () => {
    expect(
      evaluateFlexiblePersonName('Ada Prueba Médica Uno', 'Dra. Ada Prueba Medica Uno'),
    ).toMatchObject({
      kind: 'EXACT_NORMALIZED_NAME',
      flexibilityIndex: 0,
      exactObservedTokenCount: 4,
      initialObservedTokenCount: 0,
    });
  });

  it('classifies a conservative multi-token partial name at index one', () => {
    expect(evaluateFlexiblePersonName('Beatriz Elena Ejemplo Sur', 'Beatriz Ejemplo')).toEqual({
      kind: 'PARTIAL_TOKEN_SUBSET',
      flexibilityIndex: 1,
      canonicalTokenCount: 4,
      observedTokenCount: 2,
      exactObservedTokenCount: 2,
      initialObservedTokenCount: 0,
    });
  });

  it('classifies initials only when a full token also matches in order', () => {
    expect(evaluateFlexiblePersonName('Nicolás Andrés Nube', 'N. Nube')).toEqual({
      kind: 'INITIALS_TOKEN_SUBSEQUENCE',
      flexibilityIndex: 2,
      canonicalTokenCount: 3,
      observedTokenCount: 2,
      exactObservedTokenCount: 1,
      initialObservedTokenCount: 1,
    });
    expect(evaluateFlexiblePersonName('Nicolás Andrés Nube', 'N. A. N.')).toBeNull();
    expect(evaluateFlexiblePersonName('Nicolás Andrés Nube', 'Nube N.')).toBeNull();
  });

  it('rejects misspellings, single tokens, and unrelated names', () => {
    expect(evaluateFlexiblePersonName('Nicolás Nube', 'Nicolás Nve')).toBeNull();
    expect(evaluateFlexiblePersonName('Nicolás Nube', 'Nube')).toBeNull();
    expect(evaluateFlexiblePersonName('Nicolás Nube', 'Federico Ficticio')).toBeNull();
  });
});
