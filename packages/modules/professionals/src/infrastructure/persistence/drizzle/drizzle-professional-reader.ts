import { Buffer } from 'node:buffer';

import { and, eq, gt, ilike, or, type SQL } from 'drizzle-orm';

import { InvalidProfessionalCursorError } from '../../../application/errors/professional-query.error';

import { publicProfessionalRouteView, publicProfessionalView } from './professional.schema';

import type {
  ProfessionalLookupRecord,
  ProfessionalSearchPage,
  ProfessionalSummary,
} from '../../../application/models/professional-read-model';
import type {
  ProfessionalFinder,
  ProfessionalSearch,
  ProfessionalSearchCriteria,
} from '../../../application/ports/professional-reader.port';
import type { CatalogDatabase } from '@medicos/database';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ProfessionalsCursor {
  readonly version: 1;
  readonly normalizedName: string;
  readonly id: string;
}

function normalizeSearchTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('es-UY');
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function encodeCursor(cursor: ProfessionalsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ProfessionalsCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('normalizedName' in parsed) ||
      typeof parsed.normalizedName !== 'string' ||
      parsed.normalizedName.length > 200 ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new InvalidProfessionalCursorError();
    }

    return {
      version: 1,
      normalizedName: parsed.normalizedName,
      id: parsed.id,
    };
  } catch (error) {
    if (error instanceof InvalidProfessionalCursorError) {
      throw error;
    }

    throw new InvalidProfessionalCursorError();
  }
}

export class DrizzleProfessionalReader implements ProfessionalSearch, ProfessionalFinder {
  public constructor(private readonly database: CatalogDatabase) {}

  public async searchPublic(criteria: ProfessionalSearchCriteria): Promise<ProfessionalSearchPage> {
    const conditions: SQL[] = [eq(publicProfessionalRouteView.routeKind, 'CURRENT')];

    if (criteria.query !== undefined) {
      const pattern = escapeLikePattern(normalizeSearchTerm(criteria.query));
      conditions.push(ilike(publicProfessionalView.normalizedName, `%${pattern}%`));
    }

    if (criteria.cursor !== undefined) {
      const cursor = decodeCursor(criteria.cursor);
      const afterCursor = or(
        gt(publicProfessionalView.normalizedName, cursor.normalizedName),
        and(
          eq(publicProfessionalView.normalizedName, cursor.normalizedName),
          gt(publicProfessionalView.id, cursor.id),
        ),
      );

      if (afterCursor !== undefined) {
        conditions.push(afterCursor);
      }
    }

    const rows = await this.database
      .select({
        id: publicProfessionalView.id,
        slug: publicProfessionalRouteView.slug,
        displayName: publicProfessionalView.displayName,
        normalizedName: publicProfessionalView.normalizedName,
      })
      .from(publicProfessionalView)
      .innerJoin(
        publicProfessionalRouteView,
        eq(publicProfessionalRouteView.professionalId, publicProfessionalView.id),
      )
      .where(and(...conditions))
      .orderBy(publicProfessionalView.normalizedName, publicProfessionalView.id)
      .limit(criteria.limit + 1);

    const hasNextPage = rows.length > criteria.limit;
    const visibleRows = hasNextPage ? rows.slice(0, criteria.limit) : rows;
    const items: ProfessionalSummary[] = visibleRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
    }));

    if (!hasNextPage) {
      return {
        items,
      };
    }

    const lastRow = visibleRows.at(-1);

    if (lastRow === undefined) {
      return {
        items,
      };
    }

    return {
      items,
      nextCursor: encodeCursor({
        version: 1,
        normalizedName: lastRow.normalizedName,
        id: lastRow.id,
      }),
    };
  }

  public async findPublicByIdOrSlug(
    idOrSlug: string,
  ): Promise<ProfessionalLookupRecord | undefined> {
    let professionalId = idOrSlug;

    if (!UUID_PATTERN.test(idOrSlug)) {
      const route = await this.database
        .select({
          professionalId: publicProfessionalRouteView.professionalId,
        })
        .from(publicProfessionalRouteView)
        .where(eq(publicProfessionalRouteView.slug, idOrSlug.toLocaleLowerCase('en-US')))
        .limit(1);

      const matchingRoute = route.at(0);

      if (matchingRoute === undefined) {
        return undefined;
      }

      professionalId = matchingRoute.professionalId;
    }

    const rows = await this.database
      .select({
        id: publicProfessionalView.id,
        slug: publicProfessionalRouteView.slug,
        displayName: publicProfessionalView.displayName,
        currentNameEvidenceId: publicProfessionalView.currentNameEvidenceId,
      })
      .from(publicProfessionalView)
      .innerJoin(
        publicProfessionalRouteView,
        and(
          eq(publicProfessionalRouteView.professionalId, publicProfessionalView.id),
          eq(publicProfessionalRouteView.routeKind, 'CURRENT'),
        ),
      )
      .where(eq(publicProfessionalView.id, professionalId))
      .limit(1);

    return rows.at(0);
  }
}
