import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLinkageCandidates,
  runLinkageCandidateBuild,
  type MspProfessional,
  type ProviderProfessionalObservation,
} from './build-linkage-candidates';

const mspProfessionals: readonly MspProfessional[] = [
  {
    linkageId: `msp_doc_v1_${'1'.repeat(64)}`,
    fullName: 'Ana María Pérez Gómez',
    enabledTitles: [
      {
        title: 'DOCTOR EN MEDICINA',
        recruiterCode: 'synthetic-1',
        temporaryRegistration: null,
      },
      {
        title: 'ESPECIALISTA EN CARDIOLOGÍA',
        recruiterCode: 'synthetic-2',
        temporaryRegistration: null,
      },
    ],
  },
  {
    linkageId: `msp_doc_v1_${'2'.repeat(64)}`,
    fullName: 'Juan Silva',
    enabledTitles: [
      {
        title: 'DOCTOR EN MEDICINA',
        recruiterCode: 'synthetic-3',
        temporaryRegistration: null,
      },
    ],
  },
  {
    linkageId: `msp_doc_v1_${'3'.repeat(64)}`,
    fullName: 'Juan Silva',
    enabledTitles: [
      {
        title: 'DOCTOR EN MEDICINA',
        recruiterCode: 'synthetic-4',
        temporaryRegistration: null,
      },
    ],
  },
];

const sourceRows: readonly ProviderProfessionalObservation[] = [
  {
    displayName: 'PÉREZ GÓMEZ, ANA MARÍA',
    institution: 'Prestador sintético',
    recordId: 'row-1',
    sourceFile: 'synthetic/schedules.ndjson',
    specialties: ['Cardiología'],
  },
  {
    displayName: 'Dr. Juan Silva',
    institution: 'Prestador sintético',
    recordId: 'row-2',
    sourceFile: 'synthetic/schedules.ndjson',
    specialties: ['Medicina general'],
  },
  {
    displayName: 'María Inexistente',
    institution: 'Prestador sintético',
    recordId: 'row-3',
    sourceFile: 'synthetic/schedules.ndjson',
    specialties: ['Pediatría'],
  },
  {
    displayName: 'GÓMEZ PÉREZ ANA MARÍA',
    institution: 'Segundo prestador sintético',
    recordId: 'row-4',
    sourceFile: 'synthetic/roster.ndjson',
    specialties: ['Cardiología'],
  },
];

describe('buildLinkageCandidates', () => {
  it('builds review candidates without making an automatic merge', () => {
    const candidates = buildLinkageCandidates(mspProfessionals, sourceRows);

    expect(candidates).toHaveLength(4);
    expect(
      candidates.find(
        ({ providerIdentity }) => providerIdentity.normalizedName === 'ANA MARIA PEREZ GOMEZ',
      ),
    ).toMatchObject({
      schemaVersion: 2,
      status: 'exact_name_and_title_consistent',
      publicationDecision: 'not_merged',
      requiresHumanReview: true,
      identityEvidence: [
        'exact_normalized_full_name',
        'specialty_consistent_with_registered_title',
      ],
    });
    expect(
      candidates.find(({ providerIdentity }) => providerIdentity.normalizedName === 'JUAN SILVA'),
    ).toMatchObject({
      status: 'ambiguous_exact_name',
      publicationDecision: 'not_merged',
      mspCandidates: [{ fullName: 'Juan Silva' }, { fullName: 'Juan Silva' }],
    });
    expect(
      candidates.find(
        ({ providerIdentity }) => providerIdentity.normalizedName === 'MARIA INEXISTENTE',
      ),
    ).toMatchObject({
      status: 'unmatched',
      mspCandidates: [],
      identityEvidence: [],
    });
    expect(
      candidates.find(
        ({ providerIdentity }) => providerIdentity.institution === 'Segundo prestador sintético',
      ),
    ).toMatchObject({
      status: 'exact_name_and_title_consistent',
      identityEvidence: [
        'exact_full_name_token_multiset',
        'specialty_consistent_with_registered_title',
      ],
      publicationDecision: 'not_merged',
    });
    expect(candidates[0]).toMatchObject({
      providerIdentity: {
        basis: 'institution_and_exact_name',
        sourceProfessionalId: null,
      },
      sourceRecords: [{ sourceFile: expect.any(String), recordId: expect.any(String) }],
    });
  });

  it('keeps distinct institutional IDs separate and preserves record provenance pairs', () => {
    const rows: readonly ProviderProfessionalObservation[] = [
      {
        displayName: 'PÉREZ GÓMEZ, ANA MARÍA',
        institution: 'Prestador sintético',
        recordId: 'schedule-a',
        sourceFile: 'run-a/schedules.ndjson',
        sourceProfessionalId: 'provider-id-a',
        specialties: ['Cardiología'],
      },
      {
        displayName: 'PÉREZ GÓMEZ, ANA MARÍA',
        institution: 'Prestador sintético',
        recordId: 'schedule-b',
        sourceFile: 'run-a/schedules.ndjson',
        sourceProfessionalId: 'provider-id-b',
        specialties: ['Cardiología'],
      },
      {
        displayName: 'PÉREZ GÓMEZ, ANA MARÍA',
        institution: 'Prestador sintético',
        recordId: 'schedule-c',
        sourceFile: 'run-b/schedules.ndjson',
        sourceProfessionalId: 'provider-id-a',
        specialties: ['Cardiología'],
      },
    ];

    const candidates = buildLinkageCandidates(mspProfessionals, rows);

    expect(candidates).toHaveLength(2);
    expect(
      candidates.map(({ providerIdentity }) => providerIdentity.sourceProfessionalId).sort(),
    ).toEqual(['provider-id-a', 'provider-id-b']);
    expect(
      candidates.find(
        ({ providerIdentity }) => providerIdentity.sourceProfessionalId === 'provider-id-a',
      )?.sourceRecords,
    ).toEqual([
      {
        sourceFile: 'run-a/schedules.ndjson',
        recordId: 'schedule-a',
      },
      {
        sourceFile: 'run-b/schedules.ndjson',
        recordId: 'schedule-c',
      },
    ]);
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'medicos-linkage-'));
  temporaryDirectories.push(root);
  const dataDirectory = join(root, 'data');
  await mkdir(dataDirectory, { recursive: true });
  return dataDirectory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeNdjson(path: string, values: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

async function writeSyntheticMsp(dataDirectory: string): Promise<string> {
  const path = join(
    dataDirectory,
    'processed',
    'msp',
    'infotitulos',
    'synthetic',
    'professionals.ndjson',
  );
  await writeNdjson(path, [mspProfessionals[0]]);
  return path;
}

function modernProviderManifest(
  runId: string,
  recordsWritten: number,
  artifact: unknown = 'schedules.ndjson',
): unknown {
  return {
    schemaVersion: 1,
    runId,
    source: {
      id: 'synthetic-public-medical-schedule',
      institution: 'Prestador sintético',
    },
    status: 'complete',
    scope: 'full_filter_enumeration',
    completedAt: '2026-07-27T05:00:00.000Z',
    counts: {
      doctorRequestsFailed: 0,
      doctorResponsesAtPossibleSourceLimit: 0,
      sourceRowsParsed: recordsWritten,
      recordsWritten,
      duplicateRowsSkipped: 0,
    },
    artifacts: {
      schedulesNdjson: artifact,
    },
  };
}

function validProviderRow(recordId: string): unknown {
  return {
    schemaVersion: 1,
    recordId,
    source: {
      id: 'synthetic-public-medical-schedule',
      institution: 'Prestador sintético',
    },
    sourceProfessionalId: 'provider-professional-1',
    professionalName: 'PÉREZ GÓMEZ, ANA MARÍA',
    specialty: 'Cardiología',
  };
}

describe('linkage input integrity', () => {
  it('aborts with reconciled quarantine reasons instead of silently dropping physical rows', async () => {
    const dataDirectory = await temporaryDataDirectory();
    const mspPath = await writeSyntheticMsp(dataDirectory);
    const runId = 'run-quarantine';
    const runDirectory = join(dataDirectory, 'raw', 'mutualistas', 'synthetic', runId);
    const schedulesPath = join(runDirectory, 'schedules.ndjson');
    await writeNdjson(schedulesPath, [validProviderRow('row-1'), { unexpected: true }]);
    await writeJson(join(runDirectory, 'manifest.json'), modernProviderManifest(runId, 2));

    await expect(
      runLinkageCandidateBuild({
        DATA_INGESTION_DIR: dataDirectory,
        LINKAGE_PROVIDER_INPUT_PATHS: schedulesPath,
        MSP_PROFESSIONALS_PATH: mspPath,
      }),
    ).rejects.toThrow(/physical=2, parsed=1, quarantined=1.*MISSING_DISPLAY_NAME/u);
  });

  it('rejects a provider artifact whose physical count differs from its manifest', async () => {
    const dataDirectory = await temporaryDataDirectory();
    const mspPath = await writeSyntheticMsp(dataDirectory);
    const runId = 'run-count-mismatch';
    const runDirectory = join(dataDirectory, 'raw', 'mutualistas', 'synthetic', runId);
    const schedulesPath = join(runDirectory, 'schedules.ndjson');
    await writeNdjson(schedulesPath, [validProviderRow('row-1')]);
    await writeJson(join(runDirectory, 'manifest.json'), modernProviderManifest(runId, 2));

    await expect(
      runLinkageCandidateBuild({
        DATA_INGESTION_DIR: dataDirectory,
        LINKAGE_PROVIDER_INPUT_PATHS: schedulesPath,
        MSP_PROFESSIONALS_PATH: mspPath,
      }),
    ).rejects.toThrow(/declares 2 records but contains 1 physical NDJSON records/u);
  });

  it('verifies artifact hashes when a manifest publishes them', async () => {
    const dataDirectory = await temporaryDataDirectory();
    const mspPath = await writeSyntheticMsp(dataDirectory);
    const runId = 'run-hash-mismatch';
    const runDirectory = join(dataDirectory, 'raw', 'mutualistas', 'synthetic', runId);
    const schedulesPath = join(runDirectory, 'schedules.ndjson');
    await writeNdjson(schedulesPath, [validProviderRow('row-1')]);
    await writeJson(
      join(runDirectory, 'manifest.json'),
      modernProviderManifest(runId, 1, {
        relativePath: 'schedules.ndjson',
        records: 1,
        sha256: '0'.repeat(64),
      }),
    );

    await expect(
      runLinkageCandidateBuild({
        DATA_INGESTION_DIR: dataDirectory,
        LINKAGE_PROVIDER_INPUT_PATHS: schedulesPath,
        MSP_PROFESSIONALS_PATH: mspPath,
      }),
    ).rejects.toThrow(/does not match its manifest SHA-256/u);
  });

  it('selects all artifacts from one complete legacy run and never mixes basenames', async () => {
    const dataDirectory = await temporaryDataDirectory();
    const mspPath = await writeSyntheticMsp(dataDirectory);
    const completeRunId = '20260727T050000000Z';
    const completeRun = join(dataDirectory, 'processed', 'casmu', completeRunId);
    const physiciansPath = join(completeRun, 'physicians.ndjson');
    const schedulesPath = join(completeRun, 'schedules.ndjson');
    await writeNdjson(physiciansPath, [
      {
        physicianName: 'PÉREZ GÓMEZ, ANA MARÍA',
        provider: 'CASMU',
        recordId: 'physician-1',
        specialty: 'Cardiología',
      },
    ]);
    await writeNdjson(schedulesPath, [
      {
        physicianName: 'PÉREZ GÓMEZ, ANA MARÍA',
        provider: 'CASMU',
        recordId: 'schedule-1',
        specialty: 'Cardiología',
      },
    ]);
    await writeJson(join(completeRun, 'manifest.json'), {
      schemaVersion: '1.0.0',
      provider: 'CASMU',
      runId: completeRunId,
      generatedAt: '2026-07-27T05:00:00.000Z',
      extraction: {
        directorySourceRows: 1,
        directoryUniqueRecords: 1,
        directoryDuplicateRowsDiscarded: 0,
        directoryInvalidRows: 0,
        scheduleRecords: 1,
      },
      artifacts: {
        physiciansNdjson: 'physicians.ndjson',
        schedulesNdjson: 'schedules.ndjson',
      },
    });

    const incompleteRunId = '20260727T060000000Z';
    const incompleteRun = join(dataDirectory, 'processed', 'casmu', incompleteRunId);
    await writeNdjson(join(incompleteRun, 'schedules.ndjson'), [
      {
        physicianName: 'Persona de un run incompleto',
        provider: 'CASMU',
        recordId: 'schedule-newer',
        specialty: 'Cardiología',
      },
    ]);
    await writeJson(join(incompleteRun, 'manifest.json'), {
      schemaVersion: '1.0.0',
      provider: 'CASMU',
      runId: incompleteRunId,
      generatedAt: '2026-07-27T06:00:00.000Z',
      extraction: {
        directorySourceRows: 1,
        directoryUniqueRecords: 1,
        directoryDuplicateRowsDiscarded: 0,
        directoryInvalidRows: 0,
        scheduleRecords: 1,
      },
      artifacts: {
        schedulesNdjson: 'schedules.ndjson',
      },
    });

    const result = await runLinkageCandidateBuild({
      DATA_INGESTION_DIR: dataDirectory,
      MSP_PROFESSIONALS_PATH: mspPath,
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      inputs: readonly { relativePath: string }[];
      providerBundles: readonly {
        runId: string;
        compatibilityMode: string;
        artifacts: readonly { artifactKey: string; relativePath: string }[];
      }[];
    };

    expect(manifest.providerBundles).toEqual([
      expect.objectContaining({
        runId: completeRunId,
        compatibilityMode: 'legacy_casmu_v1',
        artifacts: [
          expect.objectContaining({ artifactKey: 'physiciansNdjson' }),
          expect.objectContaining({ artifactKey: 'schedulesNdjson' }),
        ],
      }),
    ]);
    expect(manifest.inputs.filter(({ relativePath }) => relativePath.includes('/casmu/'))).toEqual([
      expect.objectContaining({ relativePath: expect.stringContaining(`/${completeRunId}/`) }),
      expect.objectContaining({ relativePath: expect.stringContaining(`/${completeRunId}/`) }),
    ]);

    await expect(
      runLinkageCandidateBuild({
        DATA_INGESTION_DIR: dataDirectory,
        LINKAGE_PROVIDER_INPUT_PATHS: schedulesPath,
        MSP_PROFESSIONALS_PATH: mspPath,
      }),
    ).rejects.toThrow(/bundle .* is incomplete; missing physiciansNdjson/u);
  });
});
