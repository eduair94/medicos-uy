import { config as loadEnvironment } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import {
  evidenceClaimTable,
  evidenceRefTable,
  professionalRouteTable,
  professionalTable,
  registeredTitleTable,
  sourceReleaseTable,
  sourceTable,
} from './schema';

loadEnvironment({
  quiet: true,
});

const ids = {
  source: '01985bb6-9fd8-75e3-84a7-b9f81fbe7001',
  release: '01985bb6-9fd8-75e3-84a7-b9f81fbe7002',
  evidence: '01985bb6-9fd8-75e3-84a7-b9f81fbe7003',
  evidencePublic: '11985bb6-9fd8-75e3-84a7-b9f81fbe7003',
  professional: '01985bb6-9fd8-75e3-84a7-b9f81fbe7004',
  professionalPublic: '11985bb6-9fd8-75e3-84a7-b9f81fbe7004',
  registeredTitle: '01985bb6-9fd8-75e3-84a7-b9f81fbe7005',
  registeredTitlePublic: '11985bb6-9fd8-75e3-84a7-b9f81fbe7005',
} as const;

async function seed(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' || process.env['ALLOW_SYNTHETIC_SEED'] !== 'true') {
    throw new Error(
      'Synthetic catalog seed refused. Set ALLOW_SYNTHETIC_SEED=true outside production.',
    );
  }

  const seedDatabaseUrl = process.env['CATALOG_SEED_DATABASE_URL'];

  if (seedDatabaseUrl === undefined || seedDatabaseUrl.trim().length === 0) {
    throw new Error('CATALOG_SEED_DATABASE_URL is required to seed the catalog.');
  }

  const pool = new Pool({
    connectionString: seedDatabaseUrl,
  });
  const database = drizzle(pool, {
    casing: 'snake_case',
  });
  const now = new Date();

  try {
    await database
      .insert(sourceTable)
      .values({
        id: ids.source,
        name: 'Synthetic MSP fixture',
        canonicalUrl: 'https://example.invalid/open-data/medicos.csv',
        sourceKind: 'GOVERNMENT_OPEN_DATA',
        publicationState: 'APPROVED',
        purposeCompatibility: 'COMPATIBLE',
        reuseBasis: 'OPEN_DATA_LICENSE',
        licenseUrl: 'https://example.invalid/license',
        publicationPolicyId: 'synthetic-development-policy-v1',
        publicationReviewedBy: 'Synthetic seed',
        publicationReviewedAt: now,
        publicationReviewReference: 'Synthetic development fixture only',
        publicationValidUntil: new Date('2099-01-01T00:00:00.000Z'),
      })
      .onConflictDoNothing();

    await database
      .insert(sourceReleaseTable)
      .values({
        id: ids.release,
        sourceId: ids.source,
        upstreamReleaseKey: 'synthetic-2026-07', // gitleaks:allow -- deterministic fixture identifier
        cutoffDate: '2026-07-01',
        retrievedAt: now,
        sha256: '0'.repeat(64),
      })
      .onConflictDoNothing();

    await database
      .insert(evidenceRefTable)
      .values({
        id: ids.evidence,
        publicId: ids.evidencePublic,
        sourceReleaseId: ids.release,
        canonicalUrl: 'https://example.invalid/open-data/medicos.csv',
        observedAt: now,
        checksum: '0'.repeat(64),
        attribution: 'Synthetic development fixture — not MSP data',
        publicationState: 'APPROVED',
        confidence: 'DETERMINISTIC',
        validUntil: new Date('2099-01-01T00:00:00.000Z'),
      })
      .onConflictDoNothing();

    await database
      .insert(professionalTable)
      .values({
        id: ids.professional,
        publicId: ids.professionalPublic,
        displayName: 'Ana Pérez',
        normalizedName: 'ana perez',
        visibility: 'PUBLIC',
        currentNameEvidenceId: ids.evidence,
      })
      .onConflictDoNothing();

    await database
      .insert(registeredTitleTable)
      .values({
        id: ids.registeredTitle,
        publicId: ids.registeredTitlePublic,
        professionalId: ids.professional,
        title: 'Doctor en Medicina',
        normalizedTitle: 'doctor en medicina',
        registrationState: 'ENABLED',
        temporaryRegistration: 'NONE',
        currentEvidenceId: ids.evidence,
      })
      .onConflictDoNothing();

    await database
      .insert(evidenceClaimTable)
      .values([
        {
          evidenceId: ids.evidence,
          subjectId: ids.professional,
          claimKind: 'PROFESSIONAL_NAME',
          normalizedValue: 'ana perez',
        },
        {
          evidenceId: ids.evidence,
          subjectId: ids.professional,
          claimKind: 'REGISTERED_TITLE',
          normalizedValue: 'doctor en medicina',
        },
      ])
      .onConflictDoNothing();

    await database
      .insert(professionalRouteTable)
      .values({
        slug: 'ana-perez',
        professionalId: ids.professional,
        routeKind: 'CURRENT',
      })
      .onConflictDoNothing();

    console.log('Synthetic catalog seed applied.');
  } finally {
    await pool.end();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
