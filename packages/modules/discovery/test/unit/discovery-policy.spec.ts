import { describe, expect, it, vi } from 'vitest';

import {
  buildCoverage,
  classifySourceContent,
  Crawl4AiPageFetcher,
  createSourceUrlPolicy,
  DirectHttpPageFetcher,
  DuckDuckGoSearchAdapter,
  matchSourcePage,
  SearchProviderBlockedError,
  type ProfessionalSeed,
  type SourcePage,
} from '../../src';

const professionals: readonly ProfessionalSeed[] = [
  { opaqueProfessionalId: 'msp_doc_v1_a', displayName: 'TAMARA - DÍAZ SANZ' },
  { opaqueProfessionalId: 'msp_doc_v1_b', displayName: 'JUAN PÉREZ' },
];

function page(text: string): SourcePage {
  return {
    pageId: 'page_1',
    sourceId: 'academic_source',
    publisher: 'Universidad de prueba',
    category: 'ACADEMIC_MENTION',
    canonicalUrl: 'https://example.org/event',
    text,
    contentSha256: 'a'.repeat(64),
    retrievedAt: '2026-07-28T00:00:00.000Z',
    transport: 'CRAWL4AI',
  };
}

describe('discovery policy', () => {
  it('matches exact normalized names but never confirms or publishes them', () => {
    const result = matchSourcePage({
      professionals,
      page: page('Participan Tamara Díaz Sanz y otros profesionales.'),
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
      retentionDays: 30,
    });

    expect(result.restrictedReason).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        state: 'NEEDS_HUMAN_REVIEW',
        quarantine: true,
        linkageDecision: { decision: 'NOT_LINKED', identityConfirmed: false },
        publicationDecision: expect.objectContaining({
          decision: 'NOT_PUBLISHED',
          publicExportAllowed: false,
        }),
      }),
    );
  });

  it('keeps partial and initials matches at progressively looser review indices', () => {
    const partial = matchSourcePage({
      professionals: [
        {
          opaqueProfessionalId: 'msp_doc_v1_partial',
          displayName: 'TAMARA DIAZ SANZ FERNANDEZ',
        },
      ],
      page: page('Estudiante de Medicina Tamara Díaz Sanz.'),
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
      retentionDays: 30,
    }).candidates[0];
    const initials = matchSourcePage({
      professionals: [
        { opaqueProfessionalId: 'msp_doc_v1_initial', displayName: 'GABRIEL GIANNINI' },
      ],
      page: page('Participó G. Giannini en una actividad académica.'),
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
      retentionDays: 30,
    }).candidates[0];

    expect(partial?.match).toEqual(
      expect.objectContaining({ kind: 'PARTIAL_TOKEN_SUBSET', flexibilityIndex: 1 }),
    );
    expect(initials?.match).toEqual(
      expect.objectContaining({ kind: 'INITIALS_TOKEN_SUBSEQUENCE', flexibilityIndex: 2 }),
    );
    expect(initials?.linkageDecision.identityConfirmed).toBe(false);
  });

  it('discards adverse content before performing nominal matching', () => {
    const result = matchSourcePage({
      professionals,
      page: page('Sentencia por mala praxis atribuida a Tamara Díaz Sanz.'),
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
      retentionDays: 30,
    });

    expect(result).toEqual({
      candidates: [],
      restrictedReason: 'ADVERSE_OR_JUDICIAL',
    });
    expect(classifySourceContent('captcha anomaly-modal')).toBe('AUTOMATION_CHALLENGE');
    expect(classifySourceContent('historia clinica del paciente')).toBe('MINOR_OR_PRIVATE_HEALTH');
  });

  it('creates exhaustive coverage whose absence is explicitly non-probative', () => {
    const candidates = matchSourcePage({
      professionals,
      page: page('Tamara Diaz Sanz'),
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
      retentionDays: 30,
    }).candidates;
    const coverage = buildCoverage({
      professionals,
      candidates,
      sourceFailures: 0,
      restrictedPageCount: 0,
      plannedSourcePages: 1,
      completedSourcePages: 1,
      professionalSnapshotSha256: 'b'.repeat(64),
      sourcePolicySha256: 'c'.repeat(64),
      observedAt: '2026-07-28T00:00:00.000Z',
    });

    expect(coverage).toHaveLength(professionals.length);
    expect(coverage.map(({ status }) => status)).toEqual([
      'COMPLETE_CONFIGURED_SCOPE',
      'NO_CANDIDATE_WITHIN_CONFIGURED_SCOPE',
    ]);
    expect(coverage.every(({ noFindingsProvesAbsence }) => !noFindingsProvesAbsence)).toBe(true);
    expect(
      buildCoverage({
        professionals,
        candidates: [],
        sourceFailures: 1,
        restrictedPageCount: 0,
        plannedSourcePages: 1,
        completedSourcePages: 0,
        professionalSnapshotSha256: 'b'.repeat(64),
        sourcePolicySha256: 'c'.repeat(64),
        observedAt: '2026-07-28T00:00:00.000Z',
      })[0]?.status,
    ).toBe('PARTIAL_SOURCE_FAILURE');
    expect(
      buildCoverage({
        professionals,
        candidates: [],
        sourceFailures: 0,
        restrictedPageCount: 1,
        plannedSourcePages: 1,
        completedSourcePages: 1,
        professionalSnapshotSha256: 'b'.repeat(64),
        sourcePolicySha256: 'c'.repeat(64),
        observedAt: '2026-07-28T00:00:00.000Z',
      })[0]?.status,
    ).toBe('BLOCKED_BY_SOURCE_POLICY');
  });

  it.each([
    '0.1.2.3',
    '10.1.2.3',
    '127.0.0.1',
    '224.0.0.1',
    '169.254.1.2',
    '172.16.1.2',
    '192.168.1.2',
    '100.64.1.2',
    '::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'fe90::1',
    'fea0::1',
    'feb0::1',
    'service.localhost',
    'service.local',
    'service.internal',
  ])('rejects reserved source hostname %s', (hostname) => {
    expect(() => createSourceUrlPolicy({ allowedHostnames: [hostname] })).toThrow(
      'public hostname',
    );
  });

  it('rejects credentials, private networks and off-allowlist redirects', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    expect(policy.isAllowed('https://example.org/page')).toBe(true);
    expect(policy.isAllowed('http://example.org/page')).toBe(false);
    expect(policy.isAllowed('https://user:secret@example.org/page')).toBe(false);
    expect(() => createSourceUrlPolicy({ allowedHostnames: ['127.0.0.1'] })).toThrow(
      'public hostname',
    );

    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          results: [
            {
              success: true,
              url: 'https://example.org/page',
              redirected_url: 'https://evil.example/page',
              status_code: 200,
              html: '<p>ok</p>',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const fetcher = new Crawl4AiPageFetcher({
      baseUrl: 'https://crawler.example',
      fetchImplementation,
      maximumAttempts: 1,
    });
    await expect(fetcher.fetch('https://example.org/page', policy)).rejects.toThrow('allowlist');
  });

  it('retries only a bounded Crawl4AI throttle and honors the source URL', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            results: [
              {
                success: true,
                url: 'https://example.org/page',
                status_code: 200,
                html: '<p>Tamara Diaz Sanz</p>',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const fetcher = new Crawl4AiPageFetcher({
      baseUrl: 'https://crawler.example',
      fetchImplementation,
      wait: () => Promise.resolve(),
    });

    await expect(fetcher.fetch('https://example.org/page', policy)).resolves.toEqual(
      expect.objectContaining({
        finalUrl: 'https://example.org/page',
        statusCode: 200,
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('uses the constrained simple HTML endpoint when the modified crawl endpoint rejects a page', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('modified service rejected crawl', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            url: 'https://example.org/page',
            html: '<p>Tamara Diaz Sanz</p>',
          }),
          { status: 200 },
        ),
      );
    const fetcher = new Crawl4AiPageFetcher({
      baseUrl: 'https://crawler.example',
      fetchImplementation,
      maximumAttempts: 1,
    });

    await expect(fetcher.fetch('https://example.org/page', policy)).resolves.toEqual(
      expect.objectContaining({ finalUrl: 'https://example.org/page' }),
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe('https://crawler.example/html');
  });

  it('blocks direct-fetch DNS rebinding and redirects outside the source allowlist', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    const networkFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/private' },
      }),
    );
    const rebindingFetcher = new DirectHttpPageFetcher({
      fetchImplementation: networkFetch,
      resolveAddresses: () => Promise.resolve(['127.0.0.1']),
    });
    await expect(rebindingFetcher.fetch('https://example.org/page', policy)).rejects.toThrow(
      'private or reserved',
    );
    expect(networkFetch).not.toHaveBeenCalled();

    const redirectingFetcher = new DirectHttpPageFetcher({
      fetchImplementation: networkFetch,
      resolveAddresses: () => Promise.resolve(['93.184.216.34']),
    });
    await expect(redirectingFetcher.fetch('https://example.org/page', policy)).rejects.toThrow(
      'allowlist',
    );
  });

  it('opens the DuckDuckGo circuit on an anti-automation challenge without bypassing it', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<div class="anomaly-modal">captcha</div>', { status: 202 }));
    const adapter = new DuckDuckGoSearchAdapter({
      resultUrlPolicy: policy,
      fetchImplementation,
      now: () => 1_000,
    });

    await expect(adapter.discover('consulta de prueba', 1)).rejects.toBeInstanceOf(
      SearchProviderBlockedError,
    );
    await expect(adapter.discover('otra consulta', 1)).rejects.toThrow('circuit is open');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('decodes each DuckDuckGo HTML entity only once', async () => {
    const policy = createSourceUrlPolicy({ allowedHostnames: ['example.org'] });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '<a class="result__a" href="https://example.org/?label=&amp;quot;">resultado</a>',
          { status: 200 },
        ),
      );
    const adapter = new DuckDuckGoSearchAdapter({
      resultUrlPolicy: policy,
      fetchImplementation,
    });

    const results = await adapter.discover('consulta de prueba', 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://example.org/?label=&quot;');
  });
});
