import { describe, expect, it, vi } from 'vitest';

import { OwnerResearchDatabaseReadinessProbe } from '../../src/infrastructure/persistence/postgres/owner-research-database.module';

import type { Pool } from 'pg';

describe('OwnerResearchDatabaseReadinessProbe', () => {
  it('accepts only the dedicated read-only role with positive view and negative table privileges', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          isolation_ok: true,
        },
      ],
    });
    const probe = new OwnerResearchDatabaseReadinessProbe({ query } as unknown as Pool);

    await expect(probe.check()).resolves.toBeUndefined();

    const statement = query.mock.calls[0]?.[0] as string;
    expect(statement).toContain("current_user = 'medicos_owner_research_query'");
    expect(statement).toContain("current_setting('transaction_read_only') = 'on'");
    expect(statement).toContain("'research_private.owner_professional_dossier'");
    expect(statement).toContain(
      "'research_private.list_owner_professional_dossiers_page(text,uuid,integer)'",
    );
    expect(statement).toContain("'research_private.professional_dossier'");
    expect(statement).toContain("'research_private.candidate'");
    expect(statement).toContain("'ingestion_private'");
    expect(statement).toContain('NOT role.rolsuper');
    expect(statement).toContain('NOT role.rolbypassrls');
  });

  it.each([
    {
      rows: [
        {
          isolation_ok: false,
        },
      ],
    },
    {
      rows: [],
    },
  ])('fails readiness when the privilege contract is not satisfied', async (result) => {
    const query = vi.fn().mockResolvedValue(result);
    const probe = new OwnerResearchDatabaseReadinessProbe({ query } as unknown as Pool);

    await expect(probe.check()).rejects.toThrow('Owner research database isolation check failed.');
  });
});
