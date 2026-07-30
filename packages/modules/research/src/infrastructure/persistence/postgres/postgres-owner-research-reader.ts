import { Buffer } from 'node:buffer';

import { InvalidOwnerResearchCursorError } from '../../../application/errors/owner-research.error';

import type { PersistedOwnerResearchPage } from '../../../application/models/owner-research-page';
import type { PersistedOwnerResearchRecord } from '../../../application/models/owner-research-read-model';
import type {
  OwnerResearchListCriteria,
  OwnerResearchListReader,
} from '../../../application/ports/owner-research-list-reader.port';
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

const LIST_CURRENT_FIRST_PAGE = `
  SELECT ${SELECT_COLUMNS}
  FROM research_private.owner_professional_dossier
  WHERE route_kind = 'CURRENT'
  ORDER BY route_slug ASC, professional_public_id ASC
  LIMIT $1
`;

const LIST_CURRENT_AFTER_CURSOR = `
  SELECT ${SELECT_COLUMNS}
  FROM research_private.owner_professional_dossier
  WHERE route_kind = 'CURRENT'
    AND (
      route_slug > $1
      OR (route_slug = $1 AND professional_public_id > $2::uuid)
    )
  ORDER BY route_slug ASC, professional_public_id ASC
  LIMIT $3
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface OwnerResearchCursor {
  readonly version: 1;
  readonly routeSlug: string;
  readonly professionalId: string;
}

function encodeCursor(cursor: OwnerResearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): OwnerResearchCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('routeSlug' in parsed) ||
      typeof parsed.routeSlug !== 'string' ||
      parsed.routeSlug.length === 0 ||
      parsed.routeSlug.length > 200 ||
      !SLUG_PATTERN.test(parsed.routeSlug) ||
      !('professionalId' in parsed) ||
      typeof parsed.professionalId !== 'string' ||
      !UUID_PATTERN.test(parsed.professionalId)
    ) {
      throw new InvalidOwnerResearchCursorError();
    }

    return {
      version: 1,
      routeSlug: parsed.routeSlug,
      professionalId: parsed.professionalId.toLowerCase(),
    };
  } catch (error) {
    if (error instanceof InvalidOwnerResearchCursorError) {
      throw error;
    }

    throw new InvalidOwnerResearchCursorError();
  }
}

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

export class PostgresOwnerResearchReader implements OwnerResearchReader, OwnerResearchListReader {
  public constructor(private readonly pool: Pool) {}

  public async findLatestByProfessional(
    lookup: OwnerResearchLookup,
  ): Promise<PersistedOwnerResearchRecord | undefined> {
    const query = lookup.kind === 'PUBLIC_UUID' ? FIND_BY_PUBLIC_UUID : FIND_BY_SLUG;
    const result = await this.pool.query<OwnerResearchDossierRow>(query, [lookup.value]);
    const row = result.rows.at(0);

    return row === undefined ? undefined : mapRow(row);
  }

  public async listLatest(
    criteria: OwnerResearchListCriteria,
  ): Promise<PersistedOwnerResearchPage> {
    const queryLimit = criteria.limit + 1;
    const result =
      criteria.cursor === undefined
        ? await this.pool.query<OwnerResearchDossierRow>(LIST_CURRENT_FIRST_PAGE, [queryLimit])
        : await this.listAfterCursor(criteria.cursor, queryLimit);
    const hasMore = result.rows.length > criteria.limit;
    const visibleRows = hasMore ? result.rows.slice(0, criteria.limit) : result.rows;
    const records = visibleRows.map(mapRow);

    if (!hasMore) {
      return {
        records,
      };
    }

    const lastRow = visibleRows.at(-1);

    if (lastRow === undefined) {
      return {
        records,
      };
    }

    return {
      records,
      nextCursor: encodeCursor({
        version: 1,
        routeSlug: lastRow.route_slug,
        professionalId: lastRow.professional_public_id,
      }),
    };
  }

  private async listAfterCursor(cursorValue: string, queryLimit: number) {
    const cursor = decodeCursor(cursorValue);

    return this.pool.query<OwnerResearchDossierRow>(LIST_CURRENT_AFTER_CURSOR, [
      cursor.routeSlug,
      cursor.professionalId,
      queryLimit,
    ]);
  }
}
