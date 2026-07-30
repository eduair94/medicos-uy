import { describe, expect, it, vi } from 'vitest';

import { InvalidOwnerResearchCursorError } from '../../src/application/errors/owner-research.error';
import { PostgresOwnerResearchReader } from '../../src/infrastructure/persistence/postgres/postgres-owner-research-reader';

import type { Pool } from 'pg';

describe('PostgresOwnerResearchReader', () => {
  it('queries only the owner read model and prefers the current route for UUID lookups', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          professional_public_id: '1a8c34f4-9097-4d86-b670-e609c22e9683',
          route_slug: 'tamara-diaz-sanz-fernandez-1a8c34f49097',
          analysis_version: 'professional-research-v1',
          run_status: 'COMPLETED',
          report_id: 'professional_research_v1_example',
          generated_at: new Date('2026-07-29T12:00:00.000Z'),
          query_ambiguity: 'NONE',
          best_flexibility_index: 0,
          candidate_count: 1,
          official_registry_record_count: 1,
          institutional_candidate_count: 2,
          schedule_record_count: 3,
          web_candidate_count: 1,
          public_reference_candidate_count: 3,
          ethics_candidate_count: 0,
          research_view: {
            schemaVersion: 1,
          },
        },
      ],
    });
    const reader = new PostgresOwnerResearchReader({ query } as unknown as Pool);

    await expect(
      reader.findLatestByProfessional({
        kind: 'PUBLIC_UUID',
        value: '1a8c34f4-9097-4d86-b670-e609c22e9683',
      }),
    ).resolves.toMatchObject({
      generatedAt: '2026-07-29T12:00:00.000Z',
      counts: {
        schedules: 3,
      },
      researchView: {
        schemaVersion: 1,
      },
    });

    const [statement, parameters] = query.mock.calls[0] as [string, readonly string[]];
    expect(statement).toContain('research_private.owner_professional_dossier');
    expect(statement).toContain("ORDER BY (route_kind = 'CURRENT') DESC");
    expect(statement).not.toContain('professional_dossier AS');
    expect(parameters).toEqual(['1a8c34f4-9097-4d86-b670-e609c22e9683']);
  });

  it('uses the slug predicate without interpolating the requested slug', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [],
    });
    const reader = new PostgresOwnerResearchReader({ query } as unknown as Pool);

    await expect(
      reader.findLatestByProfessional({
        kind: 'SLUG',
        value: 'tamara-diaz-sanz-fernandez-1a8c34f49097',
      }),
    ).resolves.toBeUndefined();

    const [statement, parameters] = query.mock.calls[0] as [string, readonly string[]];
    expect(statement).toContain('WHERE route_slug = $1');
    expect(statement).not.toContain('tamara-diaz');
    expect(parameters).toEqual(['tamara-diaz-sanz-fernandez-1a8c34f49097']);
  });

  it('keyset-paginates only current owner dossiers and returns an opaque cursor', async () => {
    const firstId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7201';
    const secondId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7202';
    const thirdId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7203';
    const row = (id: string, slug: string) => ({
      professional_public_id: id,
      route_slug: slug,
      analysis_version: 'professional-research-v1-test',
      run_status: 'COMPLETED',
      report_id: `synthetic-report-${id}`,
      generated_at: new Date('2026-07-30T12:00:00.000Z'),
      query_ambiguity: 'NONE',
      best_flexibility_index: 0,
      candidate_count: 1,
      official_registry_record_count: 1,
      institutional_candidate_count: 0,
      schedule_record_count: 0,
      web_candidate_count: 0,
      public_reference_candidate_count: 0,
      ethics_candidate_count: 0,
      research_view: {
        schemaVersion: 1,
      },
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          row(firstId, 'ana-prueba'),
          row(secondId, 'beatriz-prueba'),
          row(thirdId, 'carla-prueba'),
        ],
      })
      .mockResolvedValueOnce({
        rows: [],
      });
    const reader = new PostgresOwnerResearchReader({ query } as unknown as Pool);

    const firstPage = await reader.listLatest({
      limit: 2,
    });

    expect(firstPage.records.map((record) => record.professionalId)).toEqual([firstId, secondId]);
    expect(firstPage.nextCursor).toBeTypeOf('string');

    const [firstStatement, firstParameters] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(firstStatement).toContain("WHERE route_kind = 'CURRENT'");
    expect(firstStatement).toContain('ORDER BY route_slug ASC, professional_public_id ASC');
    expect(firstStatement).not.toContain('professional_dossier AS');
    expect(firstParameters).toEqual([3]);

    if (firstPage.nextCursor === undefined) {
      throw new Error('Expected an opaque cursor for the next synthetic page.');
    }

    await expect(
      reader.listLatest({
        cursor: firstPage.nextCursor,
        limit: 2,
      }),
    ).resolves.toEqual({
      records: [],
    });

    const [secondStatement, secondParameters] = query.mock.calls[1] as [string, readonly unknown[]];
    expect(secondStatement).toContain('route_slug > $1');
    expect(secondStatement).toContain('professional_public_id > $2::uuid');
    expect(secondParameters).toEqual(['beatriz-prueba', secondId, 3]);
  });

  it('rejects malformed owner list cursors before issuing SQL', async () => {
    const query = vi.fn();
    const reader = new PostgresOwnerResearchReader({ query } as unknown as Pool);

    await expect(
      reader.listLatest({
        cursor: 'not-an-opaque-cursor',
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(InvalidOwnerResearchCursorError);
    expect(query).not.toHaveBeenCalled();
  });
});
