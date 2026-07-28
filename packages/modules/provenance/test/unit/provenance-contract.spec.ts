import { describe, expect, it } from 'vitest';

import { APPROVED_EVIDENCE_FINDER } from '../../src';

describe('provenance public contract', () => {
  it('exposes a stable dependency-injection token', () => {
    expect(APPROVED_EVIDENCE_FINDER).toBeTypeOf('symbol');
  });
});
