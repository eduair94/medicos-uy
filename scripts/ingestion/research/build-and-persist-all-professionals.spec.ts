import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPersistableDossier,
  loadProfessionalAnalysisConfiguration,
} from './build-and-persist-all-professionals';
import { CMU_ETHICS_SOURCE_URL } from './restricted-source-coverage';

import type { ResearchMspProfessional } from '../../../packages/modules/discovery/src';

const ANALYSIS_APPROVAL = 'STORE_PRIVATE_RESEARCH_DOSSIERS';
const SNAPSHOT_ID = 'factual-v3-0123456789abcdef';
const DATABASE_URL =
  'postgresql://medicos_private_ingestor:secret@postgres.internal:5432/medicos_catalog';
const temporaryDirectories: string[] = [];

async function configurationEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), 'medicos-professional-analysis-'));
  temporaryDirectories.push(root);
  const caPath = join(root, 'postgres-ca.pem');
  await writeFile(
    caPath,
    '-----BEGIN CERTIFICATE-----\nsynthetic-test-ca\n-----END CERTIFICATE-----\n',
    'utf8',
  );
  return {
    PROFESSIONAL_ANALYSIS_APPROVAL: ANALYSIS_APPROVAL,
    PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: SNAPSHOT_ID,
    PROFESSIONAL_ANALYSIS_DATABASE_URL: DATABASE_URL,
    PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
    PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'postgres.internal',
    DATA_INGESTION_DIR: root,
  };
}

const professional: ResearchMspProfessional = {
  linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
  fullName: 'TAMARA DIAZ SANZ FERNANDEZ',
  enabledTitles: [
    {
      title: 'DOCTOR EN MEDICINA',
      recruiterCode: '310000',
      temporaryRegistration: null,
    },
  ],
  provenance: {
    publisher: 'Ministerio de Salud Publica',
    dataset: 'Infotitulos',
    sourceCutoffDate: '2026-06-30',
  },
};

function dossierInputs(): Parameters<typeof buildPersistableDossier>[0] {
  return {
    professionals: [professional],
    professionalById: new Map([[professional.linkageId, professional]]),
    linkageByProfessionalId: new Map(),
    webByProfessionalId: new Map(),
    schedules: new Map(),
    scheduleDescriptors: [],
    references: [],
    checkedScheduleArtifacts: 0,
    webEnrichmentSnapshotChecked: false,
    curatedReferenceLedgerChecked: false,
    inputFingerprint: 'b'.repeat(64),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }),
  );
});

describe('all-professional analysis configuration', () => {
  it('rejects CMU automated collection before accepting any other setting', async () => {
    await expect(
      loadProfessionalAnalysisConfiguration({
        PROFESSIONAL_ANALYSIS_APPROVAL: ANALYSIS_APPROVAL,
        CMU_ETHICS_FETCH_ENABLED: ' TRUE ',
      }),
    ).rejects.toThrow('CMU_ETHICS_FETCH_ENABLED=true is prohibited');
  });

  it('requires a pinned TLS server name and the least-privilege database role', async () => {
    const environment = await configurationEnvironment();

    const withoutServername = { ...environment };
    delete withoutServername['PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME'];
    await expect(loadProfessionalAnalysisConfiguration(withoutServername)).rejects.toThrow(
      'PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME is required',
    );

    await expect(
      loadProfessionalAnalysisConfiguration({
        ...environment,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_public_query:secret@postgres.internal:5432/medicos_catalog',
      }),
    ).rejects.toThrow('requires the medicos_private_ingestor role');

    await expect(
      loadProfessionalAnalysisConfiguration({
        ...environment,
        PROFESSIONAL_ANALYSIS_DATABASE_URL: `${DATABASE_URL}?sslmode=disable`,
      }),
    ).rejects.toThrow('must not contain query parameters');
  });

  it('loads the private database contract without opening a connection', async () => {
    const environment = await configurationEnvironment();

    await expect(loadProfessionalAnalysisConfiguration(environment)).resolves.toMatchObject({
      approval: ANALYSIS_APPROVAL,
      dataDirectory: resolve(environment['DATA_INGESTION_DIR']!),
      snapshotId: SNAPSHOT_ID,
      databaseUrl: DATABASE_URL,
      databaseSslServername: 'postgres.internal',
      batchSize: 100,
      maxAttempts: 3,
      leaseMinutes: 15,
      maxItemsPerInvocation: null,
    });
  });
});

describe('all-professional dossier boundary', () => {
  it('builds a deterministic private dossier with blocked CMU coverage and no ethics linkage', () => {
    const generatedAt = '2026-07-28T23:00:00.000Z';
    const first = buildPersistableDossier(dossierInputs(), professional, generatedAt);
    const second = buildPersistableDossier(dossierInputs(), professional, generatedAt);
    const researchCandidate = first.dossier.research_view.candidates[0];

    expect(second).toEqual(first);
    expect(first.dossier.ethics_candidate_count).toBe(0);
    expect(first.candidates.map(({ candidate_kind }) => candidate_kind)).not.toContain(
      'ETHICS_RULING',
    );
    expect(researchCandidate?.sourceCoverage).toEqual([
      expect.objectContaining({
        sourceUrl: CMU_ETHICS_SOURCE_URL,
        status: 'SOURCE_BLOCKED_ROBOTS',
        automatedFetchPerformed: false,
        identityDecision: 'NOT_LINKED',
        publicationDecision: 'NOT_PUBLISHED',
      }),
    ]);
    expect(first.dossier.research_view.publication).toEqual(
      expect.objectContaining({
        decision: 'NOT_PUBLISHED',
        publicExportAllowed: false,
        automaticIdentityConfirmation: false,
      }),
    );
    expect(first.dossier.research_view.delivery).toEqual(
      expect.objectContaining({
        intendedSurface: 'AUTHENTICATED_PRIVATE_API',
        publicApiDeliveryAllowed: false,
      }),
    );
  });
});
