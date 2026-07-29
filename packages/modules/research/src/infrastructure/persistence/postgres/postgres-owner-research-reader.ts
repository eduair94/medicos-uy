import type { PersistedOwnerResearchRecord } from '../../../application/models/owner-research-read-model';
import type {
  OwnerResearchLookup,
  OwnerResearchReader,
} from '../../../application/ports/owner-research-reader.port';
import type { Pool, QueryResultRow } from 'pg';

interface OwnerResearchDossierRow extends QueryResultRow {
  readonly professional_public_id: string;
  readonly route_slug: string;
  readonly analysis_version: string;
  readonly run_status: string;
  readonly report_id: string;
  readonly generated_at: Date | string;
  readonly query_ambiguity: string;
  readonly best_flexibility_index: 0 | 1 | 2 | null;
  readonly candidate_count: number;
  readonly official_registry_record_count: number;
  readonly institutional_candidate_count: number;
  readonly schedule_record_count: number;
  readonly web_candidate_count: number;
  readonly public_reference_candidate_count: number;
  readonly ethics_candidate_count: number;
  readonly research_view: unknown;
}

const SELECT_COLUMNS = `
  professional_public_id::text,
  route_slug,
  analysis_version,
  run_status,
  report_id,
  generated_at,
  query_ambiguity,
  best_flexibility_index,
  candidate_count,
  official_registry_record_count,
  institutional_candidate_count,
  schedule_record_count,
  web_candidate_count,
  public_reference_candidate_count,
  ethics_candidate_count,
  research_view
`;

const FIND_BY_PUBLIC_UUID = `
  SELECT ${SELECT_COLUMNS}
  FROM research_private.owner_professional_dossier
  WHERE professional_public_id = $1::uuid
  ORDER BY (route_kind = 'CURRENT') DESC, route_slug ASC
  LIMIT 1
`;

const FIND_BY_SLUG = `
  SELECT ${SELECT_COLUMNS}
  FROM research_private.owner_professional_dossier
  WHERE route_slug = $1
  ORDER BY (route_kind = 'CURRENT') DESC
  LIMIT 1
`;

function serializeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: OwnerResearchDossierRow): PersistedOwnerResearchRecord {
  return {
    professionalId: row.professional_public_id,
    slug: row.route_slug,
    analysisVersion: row.analysis_version,
    runStatus: row.run_status,
    reportId: row.report_id,
    generatedAt: serializeTimestamp(row.generated_at),
    queryAmbiguity: row.query_ambiguity,
    bestFlexibilityIndex: row.best_flexibility_index,
    counts: {
      candidates: row.candidate_count,
      officialRegistryRecords: row.official_registry_record_count,
      institutionalCandidates: row.institutional_candidate_count,
      schedules: row.schedule_record_count,
      webCandidates: row.web_candidate_count,
      publicReferenceCandidates: row.public_reference_candidate_count,
      ethicsCandidates: row.ethics_candidate_count,
    },
    researchView: row.research_view,
  };
}

export class PostgresOwnerResearchReader implements OwnerResearchReader {
  public constructor(private readonly pool: Pool) {}

  public async findLatestByProfessional(
    lookup: OwnerResearchLookup,
  ): Promise<PersistedOwnerResearchRecord | undefined> {
    const query = lookup.kind === 'PUBLIC_UUID' ? FIND_BY_PUBLIC_UUID : FIND_BY_SLUG;
    const result = await this.pool.query<OwnerResearchDossierRow>(query, [lookup.value]);
    const row = result.rows.at(0);

    return row === undefined ? undefined : mapRow(row);
  }
}
