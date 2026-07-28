import { describe, expect, it } from 'vitest';

import { normalizePersonName } from './normalize-person-name';

describe('normalizePersonName', () => {
  it.each([
    ['Dra. María Pérez Gómez', 'MARIA PEREZ GOMEZ'],
    ['PÉREZ GÓMEZ, MARÍA', 'MARIA PEREZ GOMEZ'],
    ['Dr.  Juan\u00a0José Núñez', 'JUAN JOSE NUNEZ'],
    ['Lic. Ana Silva (videoconsulta)', 'ANA SILVA'],
    ['Téc. Lucía Ramos', 'LUCIA RAMOS'],
    ['Q.F. Álvaro Méndez', 'ALVARO MENDEZ'],
  ])('normalizes harmless display differences in %s', (input, expected) => {
    expect(normalizePersonName(input)).toBe(expected);
  });

  it('keeps middle names and second surnames', () => {
    expect(normalizePersonName('Ana María Pérez Gómez')).not.toBe(normalizePersonName('Ana Pérez'));
  });

  it('does not reorder strings with multiple commas', () => {
    expect(normalizePersonName('Pérez, Ana, María')).toBe('PEREZ ANA MARIA');
  });
});
