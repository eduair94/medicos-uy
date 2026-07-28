import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  INFOTITULOS_DATASET,
  INFOTITULOS_HEADERS,
  INFOTITULOS_LINKAGE_VERSION,
  INFOTITULOS_PUBLISHER,
} from '../msp/ingest-infotitulos';

import type { LinkageCandidate, LinkageCandidateStatus } from '../linkage/build-linkage-candidates';

const MSP_DATASET_URL =
  'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos';
const MSP_LIVE_LOOKUP_URL =
  'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud';
const URUGUAY_OPEN_DATA_LICENSE_URL =
  'https://www.gub.uy/agencia-reguladora-compras-estatales/datos-y-estadisticas/datos/licencia-datos-abiertos';
const URCDP_URL = 'https://www.gub.uy/unidad-reguladora-control-datos-personales/';
const LAW_18331_URL = 'https://www.impo.com.uy/bases/leyes/18331-2008';

export const DIRECTORY_NOTICE_VERSION = 'uy-medical-directory-factual-v3' as const;

type UnknownRecord = Readonly<Record<string, unknown>>;

interface RequiredUnapprovedGate {
  readonly required: true;
  readonly approved: false;
}

interface SourcePublicationGates {
  readonly legalBasis: RequiredUnapprovedGate;
  readonly purposeCompatibility: RequiredUnapprovedGate;
  readonly reuseAuthorization: RequiredUnapprovedGate;
}

interface MspTitle {
  readonly recruiterCode: string;
  readonly temporaryRegistration: string | null;
  readonly title: string;
}

export interface MspDirectoryInput {
  readonly enabledTitles: readonly MspTitle[];
  readonly fullName: string;
  readonly linkageId: string;
  readonly provenance: {
    readonly dataset: string;
    readonly publisher: string;
    readonly sourceCutoffDate: string;
  };
}

export interface DirectoryControllerConfiguration {
  readonly address?: string;
  readonly controllerName?: string;
  readonly databaseName?: string;
  readonly internationalTransfersNotice?: string;
  readonly privacyNoticeUrl?: string;
  readonly processorsNotice?: string;
  readonly recipientsNotice?: string;
  readonly rightsEmail?: string;
  readonly urcdpRegistration?: string;
}

export interface DirectoryLegalNotice {
  readonly schemaVersion: 2;
  readonly noticeVersion: typeof DIRECTORY_NOTICE_VERSION;
  readonly language: 'es-UY';
  readonly status: 'template_not_approved_for_publication';
  readonly controller: {
    readonly name: string | null;
    readonly address: string | null;
    readonly rightsEmail: string | null;
    readonly privacyNoticeUrl: string | null;
    readonly urcdpRegistration: string | null;
  };
  readonly processing: {
    readonly processorsNotice: string | null;
    readonly recipientsNotice: string | null;
    readonly internationalTransfersNotice: string | null;
    readonly exclusivelyAutomatedDecisions: false;
    readonly professionalDataSold: false;
  };
  readonly article13: {
    readonly database: {
      readonly exists: true;
      readonly name: string | null;
    };
    readonly collection: {
      readonly directlyFromDataSubject: false;
      readonly questionnaireUsed: false;
      readonly responseRequirement: 'not_applicable_no_questionnaire';
      readonly consequencesOfProvidingData: 'not_applicable_no_questionnaire';
      readonly consequencesOfRefusal: 'no_service_or_right_is_conditioned_on_answering';
      readonly consequencesOfInaccuracy: 'record_is_marked_under_review_and_corrected_if_verified';
    };
    readonly informationOnRequestMaximumBusinessDays: 5;
    readonly automatedAssessment: {
      readonly used: false;
      readonly criteria: null;
      readonly processes: null;
      readonly technology: null;
    };
  };
  readonly purpose: string;
  readonly shortProfileNotice: string;
  readonly rights: {
    readonly available: readonly ['access', 'rectification', 'update', 'inclusion', 'suppression'];
    readonly maximumResponseTimeBusinessDays: 5;
    readonly disputedDataState: 'under_review';
    readonly access: {
      readonly identityVerificationRequired: true;
      readonly freeExerciseIntervalMonths: 6;
      readonly renewedLegitimateInterestException: true;
      readonly completeRecordRequired: true;
      readonly clearAccessibleFormatRequired: true;
      readonly thirdPartyDataDisclosureProhibited: true;
    };
    readonly rectification: {
      readonly freeOfCharge: true;
      readonly errorFalsityOrExclusionCovered: true;
      readonly markAsUnderReviewDuringVerification: true;
      readonly notifyRecipientsMaximumBusinessDays: 5;
    };
  };
  readonly sourcePolicy: {
    readonly msp: {
      readonly classification: 'provisional_official_source_pending_dataset_specific_review';
      readonly datasetUrl: string;
      readonly liveLookupUrl: string;
      readonly expectedRefreshFrequency: 'monthly';
      readonly attributionPlanned: true;
      readonly license: {
        readonly status: 'provisional_unverified_for_this_dataset';
        readonly candidateReference: string;
        readonly appliesToDatasetConfirmed: false;
      };
      readonly gates: SourcePublicationGates;
    };
    readonly institutions: {
      readonly classification: 'publicly_viewable_provider_directory_unverified_for_reuse';
      readonly internetAloneIsNotPublicSource: true;
      readonly assessmentUnit: 'each_source_url_and_field';
      readonly gates: SourcePublicationGates;
      readonly publicationState: 'withheld_pending_source_authorization_and_human_review';
    };
  };
  readonly publicationGate: {
    readonly state: 'blocked';
    readonly approval: RequiredUnapprovedGate;
    readonly missingConfiguration: readonly string[];
    readonly mandatoryApprovals: readonly [
      'legal_and_privacy_review',
      'database_registration',
      'rights_request_workflow',
      'source_by_source_reuse_assessment',
      'security_and_retention_controls',
      'impact_assessment_and_dpo_determination',
    ];
    readonly sourceApprovalRequired: true;
    readonly disclaimerAloneCreatesLegalBasis: false;
  };
  readonly legalReferences: readonly string[];
}

export type DirectoryAbstentionReason =
  | 'HUMAN_REVIEW_REQUIRED'
  | 'MULTIPLE_MSP_CANDIDATES'
  | 'NO_MSP_CANDIDATE'
  | 'TITLE_NOT_CORROBORATED';

export interface DirectoryLinkageResolution {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly providerIdentity: LinkageCandidate['providerIdentity'];
  readonly candidateStatus: LinkageCandidateStatus;
  readonly outcome: 'ABSTAINED';
  readonly reasonCode: DirectoryAbstentionReason;
  readonly selectedMspLinkageId: null;
  readonly mspCandidateLinkageIds: readonly string[];
  readonly sourceRecords: LinkageCandidate['sourceRecords'];
  readonly publicationState: 'not_public';
}

export interface DirectoryProfile {
  readonly schemaVersion: 2;
  readonly internalLinkageId: string;
  readonly displayName: string;
  readonly enabledTitles: readonly string[];
  readonly registeredTitles: readonly {
    readonly title: string;
    readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';
  }[];
  readonly officialRegistry: {
    readonly publisher: string;
    readonly dataset: string;
    readonly sourceCutoffDate: string;
    readonly datasetUrl: string;
    readonly liveLookupUrl: string;
  };
  readonly linkageReview: {
    readonly resolutionIds: readonly string[];
    readonly linkedInstitutionalObservations: 0;
  };
  readonly notice: {
    readonly noticeVersion: typeof DIRECTORY_NOTICE_VERSION;
    readonly status: 'internal_research_only';
    readonly sourceCutoffDate: string;
    readonly expectedRefreshFrequency: 'monthly';
    readonly warningCodes: readonly (
      | 'INSTITUTIONAL_LINKS_NOT_VERIFIED'
      | 'NOT_MEDICAL_ADVICE'
      | 'NOT_REAL_TIME'
      | 'VERIFY_WITH_OFFICIAL_SOURCE'
    )[];
    readonly shortText: string;
  };
  readonly publication: {
    readonly profileFacts: 'pending_evidence_and_legal_approval';
    readonly institutionalLinks: 'not_public';
    readonly publicExportAllowed: false;
  };
}

export interface BuiltDirectorySnapshot {
  readonly profiles: readonly DirectoryProfile[];
  readonly linkageResolutions: readonly DirectoryLinkageResolution[];
  readonly aggregates: {
    readonly mspProfiles: number;
    readonly profilesWithCandidateResolutions: number;
    readonly linkageResolutions: number;
    readonly abstainedResolutions: number;
    readonly linkedInstitutionalObservations: 0;
    readonly candidateStatuses: Readonly<Record<LinkageCandidateStatus, number>>;
  };
}

interface DirectoryManifest {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly noticeVersion: typeof DIRECTORY_NOTICE_VERSION;
  readonly inputs: readonly {
    readonly relativePath: string;
    readonly records: number;
    readonly sha256: string;
  }[];
  readonly outputs: {
    readonly profiles: OutputMetadata;
    readonly linkageResolutions: OutputMetadata;
    readonly legalNotice: OutputMetadata;
  };
  readonly aggregates: BuiltDirectorySnapshot['aggregates'];
  readonly safeguards: {
    readonly adverseDataAttached: false;
    readonly automaticallyMerged: false;
    readonly exhaustiveResolutionLedger: true;
    readonly fuzzyMatchingUsed: false;
    readonly institutionalObservationsAttached: false;
    readonly institutionalLinksPublished: false;
    readonly internalLinkageIdsPresent: true;
    readonly publicExportAllowed: false;
    readonly rawGovernmentIdentifiersPublished: false;
    readonly reviewsAttached: false;
  };
  readonly publicationGate: DirectoryLegalNotice['publicationGate'];
}

interface OutputMetadata {
  readonly relativePath: string;
  readonly records: number;
  readonly sha256: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} is missing a non-empty ${key}`);
  }

  return value.trim();
}

function requiredIsoDate(record: UnknownRecord, key: string, context: string): string {
  const value = requiredString(record, key, context);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${context} has invalid ISO date ${key}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${context} has invalid ISO date ${key}`);
  }

  return value;
}

function optionalConfigurationValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

const CONFIGURATION_PLACEHOLDER_PATTERN =
  /(?:\[[^\]]+\]|<[^>]+>|\{\{?[^{}]+\}?\}|\b(?:todo|tbd|changeme|placeholder|dummy|fake|ejemplo|example|sint[eé]tic[oa]|por definir|pendiente)\b|\.invalid\b)/iu;

function validatedConfigurationText(field: string, value: string | undefined): string | undefined {
  const normalized = optionalConfigurationValue(value);
  if (normalized !== undefined && CONFIGURATION_PLACEHOLDER_PATTERN.test(normalized)) {
    throw new Error(`${field} must not contain placeholder content`);
  }
  return normalized;
}

function validatedConfigurationEmail(field: string, value: string | undefined): string | undefined {
  const normalized = validatedConfigurationText(field, value);
  if (normalized !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new Error(`${field} must be a valid email address`);
  }
  return normalized;
}

function validatedConfigurationUrl(field: string, value: string | undefined): string | undefined {
  const normalized = validatedConfigurationText(field, value);
  if (normalized === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${field} must be a valid absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    !parsed.hostname.includes('.') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(`${field} must be a valid absolute HTTPS URL`);
  }
  return parsed.toString();
}

function requiredUnapprovedGate(): RequiredUnapprovedGate {
  return {
    required: true,
    approved: false,
  };
}

function sourcePublicationGates(): SourcePublicationGates {
  return {
    legalBasis: requiredUnapprovedGate(),
    purposeCompatibility: requiredUnapprovedGate(),
    reuseAuthorization: requiredUnapprovedGate(),
  };
}

function shortProfileNotice(sourceCutoffDate: string): string {
  return (
    `Información de habilitación y títulos según Infotítulos del MSP, corte ${sourceCutoffDate}. ` +
    'Actualización prevista: mensual. Consulte la vigencia actual en la fuente oficial.'
  );
}

export function buildDirectoryLegalNotice(
  configuration: DirectoryControllerConfiguration = {},
): DirectoryLegalNotice {
  const controller = {
    name: validatedConfigurationText('controller.name', configuration.controllerName) ?? null,
    address: validatedConfigurationText('controller.address', configuration.address) ?? null,
    rightsEmail:
      validatedConfigurationEmail('controller.rightsEmail', configuration.rightsEmail) ?? null,
    privacyNoticeUrl:
      validatedConfigurationUrl('controller.privacyNoticeUrl', configuration.privacyNoticeUrl) ??
      null,
    urcdpRegistration:
      validatedConfigurationText('controller.urcdpRegistration', configuration.urcdpRegistration) ??
      null,
  };
  const article13 = {
    database: {
      exists: true as const,
      name:
        validatedConfigurationText('article13.database.name', configuration.databaseName) ?? null,
    },
    collection: {
      directlyFromDataSubject: false as const,
      questionnaireUsed: false as const,
      responseRequirement: 'not_applicable_no_questionnaire' as const,
      consequencesOfProvidingData: 'not_applicable_no_questionnaire' as const,
      consequencesOfRefusal: 'no_service_or_right_is_conditioned_on_answering' as const,
      consequencesOfInaccuracy: 'record_is_marked_under_review_and_corrected_if_verified' as const,
    },
    informationOnRequestMaximumBusinessDays: 5 as const,
    automatedAssessment: {
      used: false as const,
      criteria: null,
      processes: null,
      technology: null,
    },
  };
  const processing = {
    processorsNotice:
      validatedConfigurationText('processing.processorsNotice', configuration.processorsNotice) ??
      null,
    recipientsNotice:
      validatedConfigurationText('processing.recipientsNotice', configuration.recipientsNotice) ??
      null,
    internationalTransfersNotice:
      validatedConfigurationText(
        'processing.internationalTransfersNotice',
        configuration.internationalTransfersNotice,
      ) ?? null,
    exclusivelyAutomatedDecisions: false as const,
    professionalDataSold: false as const,
  };
  const missingConfiguration = [
    ...Object.entries(controller),
    ['databaseName', article13.database.name] as const,
    ...Object.entries(processing).filter(([, value]) => typeof value !== 'boolean'),
  ]
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  return {
    schemaVersion: 2,
    noticeVersion: DIRECTORY_NOTICE_VERSION,
    language: 'es-UY',
    status: 'template_not_approved_for_publication',
    controller,
    processing,
    article13,
    purpose:
      'Informar hechos profesionales verificables: habilitación y títulos publicados por el MSP, ' +
      'y, sólo después de su aprobación, instituciones y horarios declarados por cada prestador.',
    shortProfileNotice:
      'Información de habilitación y títulos según Infotítulos del MSP. Cada perfil identifica ' +
      'su fecha de corte; la actualización prevista es mensual y la vigencia actual puede ' +
      'consultarse en la fuente oficial.',
    rights: {
      available: ['access', 'rectification', 'update', 'inclusion', 'suppression'],
      maximumResponseTimeBusinessDays: 5,
      disputedDataState: 'under_review',
      access: {
        identityVerificationRequired: true,
        freeExerciseIntervalMonths: 6,
        renewedLegitimateInterestException: true,
        completeRecordRequired: true,
        clearAccessibleFormatRequired: true,
        thirdPartyDataDisclosureProhibited: true,
      },
      rectification: {
        freeOfCharge: true,
        errorFalsityOrExclusionCovered: true,
        markAsUnderReviewDuringVerification: true,
        notifyRecipientsMaximumBusinessDays: 5,
      },
    },
    sourcePolicy: {
      msp: {
        classification: 'provisional_official_source_pending_dataset_specific_review',
        datasetUrl: MSP_DATASET_URL,
        liveLookupUrl: MSP_LIVE_LOOKUP_URL,
        expectedRefreshFrequency: 'monthly',
        attributionPlanned: true,
        license: {
          status: 'provisional_unverified_for_this_dataset',
          candidateReference: URUGUAY_OPEN_DATA_LICENSE_URL,
          appliesToDatasetConfirmed: false,
        },
        gates: sourcePublicationGates(),
      },
      institutions: {
        classification: 'publicly_viewable_provider_directory_unverified_for_reuse',
        internetAloneIsNotPublicSource: true,
        assessmentUnit: 'each_source_url_and_field',
        gates: sourcePublicationGates(),
        publicationState: 'withheld_pending_source_authorization_and_human_review',
      },
    },
    publicationGate: {
      state: 'blocked',
      approval: requiredUnapprovedGate(),
      missingConfiguration,
      mandatoryApprovals: [
        'legal_and_privacy_review',
        'database_registration',
        'rights_request_workflow',
        'source_by_source_reuse_assessment',
        'security_and_retention_controls',
        'impact_assessment_and_dpo_determination',
      ],
      sourceApprovalRequired: true,
      disclaimerAloneCreatesLegalBasis: false,
    },
    legalReferences: [
      LAW_18331_URL,
      `${LAW_18331_URL}/7`,
      `${LAW_18331_URL}/9_BIS`,
      `${LAW_18331_URL}/13`,
      `${LAW_18331_URL}/14`,
      `${LAW_18331_URL}/15`,
      URCDP_URL,
      'https://www.gub.uy/unidad-reguladora-control-datos-personales/institucional/normativa/dictamen-n-10020',
    ],
  };
}

function abstentionReason(status: LinkageCandidateStatus): DirectoryAbstentionReason {
  switch (status) {
    case 'ambiguous_exact_name':
      return 'MULTIPLE_MSP_CANDIDATES';
    case 'exact_name_and_title_consistent':
      return 'HUMAN_REVIEW_REQUIRED';
    case 'exact_name_only':
      return 'TITLE_NOT_CORROBORATED';
    case 'unmatched':
      return 'NO_MSP_CANDIDATE';
  }
}

function toAbstainedResolution(candidate: LinkageCandidate): DirectoryLinkageResolution {
  return {
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    providerIdentity: candidate.providerIdentity,
    candidateStatus: candidate.status,
    outcome: 'ABSTAINED',
    reasonCode: abstentionReason(candidate.status),
    selectedMspLinkageId: null,
    mspCandidateLinkageIds: candidate.mspCandidates.map(({ linkageId }) => linkageId).sort(),
    sourceRecords: candidate.sourceRecords,
    publicationState: 'not_public',
  };
}

function emptyCandidateStatusCounts(): Record<LinkageCandidateStatus, number> {
  return {
    ambiguous_exact_name: 0,
    exact_name_and_title_consistent: 0,
    exact_name_only: 0,
    unmatched: 0,
  };
}

function temporaryRegistrationKind(
  value: string | null,
): DirectoryProfile['registeredTitles'][number]['temporaryRegistration'] {
  if (value === null) {
    return 'NONE';
  }

  if (value === 'Registro Temporario con Contrato') {
    return 'WITH_CONTRACT';
  }

  if (value === 'Registro Temporario sin Contrato') {
    return 'WITHOUT_CONTRACT';
  }

  throw new Error(`Unknown MSP temporary registration value: ${value}`);
}

export function buildDirectorySnapshot(
  mspProfessionals: readonly MspDirectoryInput[],
  linkageCandidates: readonly LinkageCandidate[],
): BuiltDirectorySnapshot {
  const professionalsById = new Map<string, MspDirectoryInput>();
  for (const professional of mspProfessionals) {
    if (professionalsById.has(professional.linkageId)) {
      throw new Error(`Duplicate MSP linkage ID: ${professional.linkageId}`);
    }
    professionalsById.set(professional.linkageId, professional);
  }

  const resolutionIdsByProfessional = new Map<string, string[]>();
  const seenCandidateIds = new Set<string>();
  const linkageResolutions: DirectoryLinkageResolution[] = [];
  const candidateStatuses = emptyCandidateStatusCounts();

  for (const candidate of linkageCandidates) {
    if (seenCandidateIds.has(candidate.candidateId)) {
      throw new Error(`Duplicate linkage candidate ID: ${candidate.candidateId}`);
    }
    seenCandidateIds.add(candidate.candidateId);
    candidateStatuses[candidate.status] += 1;
    for (const { linkageId } of candidate.mspCandidates) {
      if (!professionalsById.has(linkageId)) {
        throw new Error(
          `Linkage candidate ${candidate.candidateId} references an unknown MSP professional`,
        );
      }
      const current = resolutionIdsByProfessional.get(linkageId) ?? [];
      current.push(candidate.candidateId);
      resolutionIdsByProfessional.set(linkageId, current);
    }
    linkageResolutions.push(toAbstainedResolution(candidate));
  }

  const profiles = mspProfessionals
    .map((professional): DirectoryProfile => {
      const resolutionIds = (resolutionIdsByProfessional.get(professional.linkageId) ?? []).sort();
      const warningCodes: DirectoryProfile['notice']['warningCodes'] =
        resolutionIds.length > 0
          ? [
              'NOT_MEDICAL_ADVICE',
              'NOT_REAL_TIME',
              'VERIFY_WITH_OFFICIAL_SOURCE',
              'INSTITUTIONAL_LINKS_NOT_VERIFIED',
            ]
          : ['NOT_MEDICAL_ADVICE', 'NOT_REAL_TIME', 'VERIFY_WITH_OFFICIAL_SOURCE'];

      return {
        schemaVersion: 2,
        internalLinkageId: professional.linkageId,
        displayName: professional.fullName,
        enabledTitles: [...new Set(professional.enabledTitles.map(({ title }) => title))].sort(
          (left, right) => left.localeCompare(right, 'es-UY'),
        ),
        registeredTitles: [
          ...new Map(
            professional.enabledTitles.map(({ temporaryRegistration, title }) => {
              const registrationKind = temporaryRegistrationKind(temporaryRegistration);
              return [
                `${title}\u0000${registrationKind}`,
                {
                  title,
                  temporaryRegistration: registrationKind,
                },
              ];
            }),
          ).values(),
        ].sort(
          (left, right) =>
            left.title.localeCompare(right.title, 'es-UY') ||
            left.temporaryRegistration.localeCompare(right.temporaryRegistration),
        ),
        officialRegistry: {
          publisher: professional.provenance.publisher,
          dataset: professional.provenance.dataset,
          sourceCutoffDate: professional.provenance.sourceCutoffDate,
          datasetUrl: MSP_DATASET_URL,
          liveLookupUrl: MSP_LIVE_LOOKUP_URL,
        },
        linkageReview: {
          resolutionIds,
          linkedInstitutionalObservations: 0,
        },
        notice: {
          noticeVersion: DIRECTORY_NOTICE_VERSION,
          status: 'internal_research_only',
          sourceCutoffDate: professional.provenance.sourceCutoffDate,
          expectedRefreshFrequency: 'monthly',
          warningCodes,
          shortText: shortProfileNotice(professional.provenance.sourceCutoffDate),
        },
        publication: {
          profileFacts: 'pending_evidence_and_legal_approval',
          institutionalLinks: 'not_public',
          publicExportAllowed: false,
        },
      };
    })
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, 'es-UY') ||
        left.internalLinkageId.localeCompare(right.internalLinkageId),
    );

  linkageResolutions.sort((left, right) => left.candidateId.localeCompare(right.candidateId));

  return {
    profiles,
    linkageResolutions,
    aggregates: {
      mspProfiles: profiles.length,
      profilesWithCandidateResolutions: profiles.filter(
        ({ linkageReview }) => linkageReview.resolutionIds.length > 0,
      ).length,
      linkageResolutions: linkageResolutions.length,
      abstainedResolutions: linkageResolutions.length,
      linkedInstitutionalObservations: 0,
      candidateStatuses,
    },
  };
}

function parseMspDirectoryInput(value: unknown, rowNumber: number): MspDirectoryInput {
  if (!isObject(value)) {
    throw new Error(`MSP row ${String(rowNumber)} is not an object`);
  }
  const enabledTitlesValue = value['enabledTitles'];
  const provenanceValue = value['provenance'];
  if (
    !Array.isArray(enabledTitlesValue) ||
    enabledTitlesValue.length === 0 ||
    !isObject(provenanceValue)
  ) {
    throw new Error(`MSP row ${String(rowNumber)} does not match the expected schema`);
  }

  const enabledTitles = enabledTitlesValue.map((titleValue, titleIndex): MspTitle => {
    if (!isObject(titleValue)) {
      throw new Error(
        `MSP row ${String(rowNumber)} title ${String(titleIndex + 1)} is not an object`,
      );
    }
    const temporaryRegistration = titleValue['temporaryRegistration'];
    if (!(temporaryRegistration === null || typeof temporaryRegistration === 'string')) {
      throw new Error(
        `MSP row ${String(rowNumber)} title ${String(titleIndex + 1)} has invalid registration`,
      );
    }

    return {
      recruiterCode: requiredString(titleValue, 'recruiterCode', 'MSP title'),
      temporaryRegistration,
      title: requiredString(titleValue, 'title', 'MSP title'),
    };
  });

  const linkageId = requiredString(value, 'linkageId', `MSP row ${String(rowNumber)}`);
  if (!/^msp_doc_v1_[0-9a-f]{64}$/u.test(linkageId)) {
    throw new Error(`MSP row ${String(rowNumber)} has an invalid opaque linkage id`);
  }

  const publisher = requiredString(provenanceValue, 'publisher', 'MSP provenance');
  const dataset = requiredString(provenanceValue, 'dataset', 'MSP provenance');
  if (publisher !== INFOTITULOS_PUBLISHER || dataset !== INFOTITULOS_DATASET) {
    throw new Error(`MSP row ${String(rowNumber)} has unexpected source provenance`);
  }

  return {
    linkageId,
    fullName: requiredString(value, 'fullName', `MSP row ${String(rowNumber)}`),
    enabledTitles,
    provenance: {
      dataset,
      publisher,
      sourceCutoffDate: requiredIsoDate(provenanceValue, 'sourceCutoffDate', 'MSP provenance'),
    },
  };
}

function parseStringArray(record: UnknownRecord, key: string, context: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value;
}

function parseLinkageCandidate(value: unknown, rowNumber: number): LinkageCandidate {
  if (!isObject(value)) {
    throw new Error(`Linkage row ${String(rowNumber)} is not an object`);
  }
  const context = `Linkage row ${String(rowNumber)}`;
  if (value['schemaVersion'] !== 2) {
    throw new Error(`${context} is not a schema version 2 candidate`);
  }
  if (value['publicationDecision'] !== 'not_merged' || value['requiresHumanReview'] !== true) {
    throw new Error(`${context} violates the fail-closed linkage contract`);
  }
  const status = requiredString(value, 'status', context);
  if (
    status !== 'ambiguous_exact_name' &&
    status !== 'exact_name_and_title_consistent' &&
    status !== 'exact_name_only' &&
    status !== 'unmatched'
  ) {
    throw new Error(`${context} has unsupported status ${status}`);
  }
  const mspCandidatesValue = value['mspCandidates'];
  const identityEvidenceValue = value['identityEvidence'];
  const providerIdentityValue = value['providerIdentity'];
  const sourceRecordsValue = value['sourceRecords'];
  if (
    !Array.isArray(mspCandidatesValue) ||
    !Array.isArray(identityEvidenceValue) ||
    !isObject(providerIdentityValue) ||
    !Array.isArray(sourceRecordsValue)
  ) {
    throw new Error(`${context} has invalid candidate arrays`);
  }
  const providerIdentityBasis = requiredString(providerIdentityValue, 'basis', context);
  if (
    providerIdentityBasis !== 'institution_and_exact_name' &&
    providerIdentityBasis !== 'source_professional_id'
  ) {
    throw new Error(`${context} has unsupported provider identity basis`);
  }
  const sourceProfessionalId = providerIdentityValue['sourceProfessionalId'];
  if (!(sourceProfessionalId === null || typeof sourceProfessionalId === 'string')) {
    throw new Error(`${context} has invalid sourceProfessionalId`);
  }
  if (
    (providerIdentityBasis === 'source_professional_id' &&
      (sourceProfessionalId === null || sourceProfessionalId.trim().length === 0)) ||
    (providerIdentityBasis === 'institution_and_exact_name' && sourceProfessionalId !== null)
  ) {
    throw new Error(`${context} has inconsistent provider identity`);
  }
  const providerIdentity: LinkageCandidate['providerIdentity'] = {
    institution: requiredString(providerIdentityValue, 'institution', context),
    basis: providerIdentityBasis,
    sourceProfessionalId,
    normalizedName: requiredString(providerIdentityValue, 'normalizedName', context),
  };
  const sourceRecords = sourceRecordsValue.map((sourceRecordValue) => {
    if (!isObject(sourceRecordValue)) {
      throw new Error(`${context} has a non-object source record`);
    }
    return {
      sourceFile: requiredString(sourceRecordValue, 'sourceFile', context),
      recordId: requiredString(sourceRecordValue, 'recordId', context),
    };
  });
  const mspCandidates = mspCandidatesValue.map((candidateValue) => {
    if (!isObject(candidateValue)) {
      throw new Error(`${context} has a non-object MSP candidate`);
    }
    return {
      linkageId: requiredString(candidateValue, 'linkageId', context),
      fullName: requiredString(candidateValue, 'fullName', context),
      enabledTitles: parseStringArray(candidateValue, 'enabledTitles', context),
    };
  });
  const allowedEvidence = new Set<LinkageCandidate['identityEvidence'][number]>([
    'exact_full_name_token_multiset',
    'exact_normalized_full_name',
    'specialty_consistent_with_registered_title',
  ]);
  if (
    !identityEvidenceValue.every(
      (item): item is LinkageCandidate['identityEvidence'][number] =>
        typeof item === 'string' &&
        allowedEvidence.has(item as LinkageCandidate['identityEvidence'][number]),
    )
  ) {
    throw new Error(`${context} has unsupported identity evidence`);
  }

  return {
    schemaVersion: 2,
    candidateId: requiredString(value, 'candidateId', context),
    status,
    publicationDecision: 'not_merged',
    providerIdentity,
    sourceDisplayNames: parseStringArray(value, 'sourceDisplayNames', context),
    sourceRecords,
    sourceSpecialties: parseStringArray(value, 'sourceSpecialties', context),
    mspCandidates,
    identityEvidence: identityEvidenceValue,
    requiresHumanReview: true,
  };
}

function parseNdjsonContent<T>(
  content: Buffer,
  parser: (value: unknown, rowNumber: number) => T,
): readonly T[] {
  const lines = content
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  return lines.map((line, index) => parser(JSON.parse(line) as unknown, index + 1));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function serializeNdjson(values: readonly unknown[]): string {
  return values.length === 0 ? '' : `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function newestFile(paths: readonly string[]): Promise<string | undefined> {
  const existing = await Promise.all(
    paths.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })),
  );
  return existing.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.path;
}

async function childFiles(root: string, fileName: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    const code = isObject(error) ? error['code'] : undefined;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, fileName));
}

async function resolveLatestInput(
  explicitPath: string | undefined,
  root: string,
  fileName: string,
  label: string,
): Promise<string> {
  if (explicitPath !== undefined) {
    return resolve(explicitPath);
  }
  const candidates = await childFiles(root, fileName);
  const existingCandidates: string[] = [];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      existingCandidates.push(candidate);
    } catch (error: unknown) {
      const code = isObject(error) ? error['code'] : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const latest = await newestFile(existingCandidates);
  if (latest === undefined) {
    throw new Error(`No ${label} input found under ${root}`);
  }
  return latest;
}

export async function installDirectorySnapshotAtomically(
  options: {
    readonly outputDirectory: string;
    readonly profilesContent: string;
    readonly linkageResolutionsContent: string;
    readonly noticeContent: string;
    readonly manifestContent: string;
  },
  commitDirectory: (stagingDirectory: string, outputDirectory: string) => Promise<void> = rename,
): Promise<void> {
  const outputParent = dirname(options.outputDirectory);
  await mkdir(outputParent, { recursive: true });

  try {
    await stat(options.outputDirectory);
    throw new Error(
      `Directory snapshot already exists and will not be overwritten: ${options.outputDirectory}`,
    );
  } catch (error: unknown) {
    const code = isObject(error) ? error['code'] : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const stagingDirectory = await mkdtemp(join(outputParent, '.directory-snapshot-stage-'));
  try {
    await Promise.all([
      writeFile(join(stagingDirectory, 'profiles.ndjson'), options.profilesContent, {
        encoding: 'utf8',
        flag: 'wx',
      }),
      writeFile(
        join(stagingDirectory, 'linkage-resolutions.ndjson'),
        options.linkageResolutionsContent,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      ),
      writeFile(
        join(stagingDirectory, 'privacy-and-publication-notice.json'),
        options.noticeContent,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      ),
      writeFile(join(stagingDirectory, 'manifest.json'), options.manifestContent, {
        encoding: 'utf8',
        flag: 'wx',
      }),
    ]);
    await commitDirectory(stagingDirectory, options.outputDirectory);
  } finally {
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
    });
  }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent.length === 0 || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

async function resolveExistingPathInside(
  dataDirectory: string,
  candidate: string,
  label: string,
): Promise<string> {
  const [realDataDirectory, realCandidate] = await Promise.all([
    realpath(dataDirectory),
    realpath(candidate),
  ]);

  if (!isPathInside(realDataDirectory, realCandidate)) {
    throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
  }

  return realCandidate;
}

async function resolveFuturePathInside(
  dataDirectory: string,
  candidate: string,
  label: string,
): Promise<string> {
  const absoluteCandidate = resolve(candidate);
  const realDataDirectory = await realpath(dataDirectory);
  let existingAncestor = absoluteCandidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const realAncestor = await realpath(existingAncestor);
      const projectedPath = resolve(realAncestor, ...missingSegments);

      if (!isPathInside(realDataDirectory, projectedPath)) {
        throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
      }

      return projectedPath;
    } catch (error) {
      const code = isObject(error) ? error['code'] : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error(`${label} has no existing ancestor inside DATA_INGESTION_DIR`, {
          cause: error,
        });
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function requiredObject(record: UnknownRecord, key: string, context: string): UnknownRecord {
  const value = record[key];
  if (!isObject(value)) {
    throw new Error(`${context} is missing object ${key}`);
  }
  return value;
}

function requiredNumber(record: UnknownRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} is missing non-negative integer ${key}`);
  }
  return value;
}

async function validateInputManifests(options: {
  readonly dataDirectory: string;
  readonly linkageContent: Buffer;
  readonly linkagePath: string;
  readonly linkageRecords: number;
  readonly mspContent: Buffer;
  readonly mspPath: string;
  readonly mspRecords: number;
}): Promise<{
  readonly linkageManifestContent: Buffer;
  readonly linkageManifestPath: string;
  readonly mspManifestContent: Buffer;
  readonly mspManifestPath: string;
  readonly mspSourceCutoffDate: string;
}> {
  const mspManifestPath = join(dirname(options.mspPath), 'manifest.json');
  const linkageManifestPath = join(dirname(options.linkagePath), 'manifest.json');
  const [mspManifestContent, linkageManifestContent] = await Promise.all([
    readFile(mspManifestPath),
    readFile(linkageManifestPath),
  ]);
  const mspManifestValue = JSON.parse(mspManifestContent.toString('utf8')) as unknown;
  const linkageManifestValue = JSON.parse(linkageManifestContent.toString('utf8')) as unknown;
  if (!isObject(mspManifestValue) || !isObject(linkageManifestValue)) {
    throw new Error('MSP and linkage manifests must be JSON objects');
  }

  if (mspManifestValue['schemaVersion'] !== 1) {
    throw new Error('MSP manifest is not the required schema version 1');
  }
  const mspSource = requiredObject(mspManifestValue, 'source', 'MSP manifest');
  const mspSourceCutoffDate = requiredIsoDate(mspSource, 'sourceCutoffDate', 'MSP source');
  if (
    requiredString(mspSource, 'publisher', 'MSP source') !== INFOTITULOS_PUBLISHER ||
    requiredString(mspSource, 'dataset', 'MSP source') !== INFOTITULOS_DATASET
  ) {
    throw new Error('MSP manifest has unexpected publisher or dataset');
  }
  const mspLinkage = requiredObject(mspManifestValue, 'linkage', 'MSP manifest');
  if (
    mspLinkage['algorithm'] !== 'HMAC-SHA256' ||
    mspLinkage['version'] !== INFOTITULOS_LINKAGE_VERSION ||
    mspLinkage['rawIdentifiersPublished'] !== false
  ) {
    throw new Error('MSP manifest violates the opaque linkage contract');
  }
  const mspQuality = requiredObject(mspManifestValue, 'quality', 'MSP manifest');
  const exactHeaders = mspQuality['exactHeaders'];
  if (
    !Array.isArray(exactHeaders) ||
    exactHeaders.length !== INFOTITULOS_HEADERS.length ||
    exactHeaders.some((header, index) => header !== INFOTITULOS_HEADERS[index])
  ) {
    throw new Error('MSP manifest does not contain the exact Infotítulos header contract');
  }

  const mspOutputs = requiredObject(mspManifestValue, 'outputs', 'MSP manifest');
  const mspProfessionals = requiredObject(mspOutputs, 'professionals', 'MSP manifest outputs');
  const mspQuarantine = requiredObject(mspOutputs, 'quarantine', 'MSP manifest outputs');
  const actualIdentityConflicts = requiredNumber(
    mspQuality,
    'actualIdentityConflicts',
    'MSP quality',
  );
  const expectedIdentityConflicts = requiredNumber(
    mspQuality,
    'expectedIdentityConflicts',
    'MSP quality',
  );
  const mspAggregates = requiredObject(mspManifestValue, 'aggregates', 'MSP manifest');
  if (
    requiredString(mspProfessionals, 'relativePath', 'MSP professionals output') !==
      portableRelative(options.dataDirectory, options.mspPath) ||
    requiredString(mspProfessionals, 'sha256', 'MSP professionals output') !==
      sha256(options.mspContent) ||
    requiredNumber(mspProfessionals, 'records', 'MSP professionals output') !== options.mspRecords
  ) {
    throw new Error('MSP professionals do not match their manifest hash and record count');
  }
  if (
    actualIdentityConflicts !== expectedIdentityConflicts ||
    requiredNumber(mspQuarantine, 'records', 'MSP quarantine output') !== actualIdentityConflicts ||
    requiredNumber(mspAggregates, 'publishedProfessionals', 'MSP aggregates') !==
      options.mspRecords ||
    requiredNumber(mspAggregates, 'quarantinedIdentityConflicts', 'MSP aggregates') !==
      actualIdentityConflicts
  ) {
    throw new Error('MSP manifest quarantine and aggregate invariants do not reconcile');
  }

  if (
    linkageManifestValue['schemaVersion'] !== 2 ||
    linkageManifestValue['algorithmVersion'] !== 'exact-full-name-candidates-v3'
  ) {
    throw new Error('Linkage manifest is not the required schema 2 / algorithm v3');
  }
  const linkageOutput = requiredObject(linkageManifestValue, 'output', 'Linkage manifest');
  if (
    requiredString(linkageOutput, 'relativePath', 'Linkage output') !==
      portableRelative(options.dataDirectory, options.linkagePath) ||
    requiredString(linkageOutput, 'sha256', 'Linkage output') !== sha256(options.linkageContent) ||
    requiredNumber(linkageOutput, 'records', 'Linkage output') !== options.linkageRecords
  ) {
    throw new Error('Linkage candidates do not match their manifest hash and record count');
  }
  const linkageSafeguards = requiredObject(linkageManifestValue, 'safeguards', 'Linkage manifest');
  if (
    linkageSafeguards['fuzzyMatchingUsed'] !== false ||
    linkageSafeguards['automaticallyMerged'] !== false ||
    linkageSafeguards['rawGovernmentIdentifiersPublished'] !== false
  ) {
    throw new Error('Linkage manifest violates the fail-closed safeguards');
  }
  const linkageInputs = linkageManifestValue['inputs'];
  if (!Array.isArray(linkageInputs)) {
    throw new Error('Linkage manifest inputs must be an array');
  }
  const selectedMspRelativePath = portableRelative(options.dataDirectory, options.mspPath);
  const linkageMspInput = linkageInputs.find(
    (input): input is UnknownRecord =>
      isObject(input) && input['relativePath'] === selectedMspRelativePath,
  );
  if (
    linkageMspInput === undefined ||
    requiredString(linkageMspInput, 'sha256', 'Linkage MSP input') !== sha256(options.mspContent) ||
    requiredNumber(linkageMspInput, 'records', 'Linkage MSP input') !== options.mspRecords
  ) {
    throw new Error('Linkage was not built from the selected MSP snapshot');
  }

  return {
    linkageManifestContent,
    linkageManifestPath,
    mspManifestContent,
    mspManifestPath,
    mspSourceCutoffDate,
  };
}

function controllerConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DirectoryControllerConfiguration {
  const controllerName = optionalConfigurationValue(environment['DIRECTORY_DATA_CONTROLLER_NAME']);
  const address = optionalConfigurationValue(environment['DIRECTORY_DATA_CONTROLLER_ADDRESS']);
  const databaseName = optionalConfigurationValue(environment['DIRECTORY_DATABASE_NAME']);
  const rightsEmail = optionalConfigurationValue(environment['DIRECTORY_DATA_RIGHTS_EMAIL']);
  const privacyNoticeUrl = optionalConfigurationValue(environment['DIRECTORY_PRIVACY_NOTICE_URL']);
  const urcdpRegistration = optionalConfigurationValue(environment['DIRECTORY_URCDP_REGISTRATION']);
  const processorsNotice = optionalConfigurationValue(environment['DIRECTORY_PROCESSORS_NOTICE']);
  const recipientsNotice = optionalConfigurationValue(environment['DIRECTORY_RECIPIENTS_NOTICE']);
  const internationalTransfersNotice = optionalConfigurationValue(
    environment['DIRECTORY_INTERNATIONAL_TRANSFERS_NOTICE'],
  );

  return {
    ...(controllerName === undefined ? {} : { controllerName }),
    ...(address === undefined ? {} : { address }),
    ...(databaseName === undefined ? {} : { databaseName }),
    ...(rightsEmail === undefined ? {} : { rightsEmail }),
    ...(privacyNoticeUrl === undefined ? {} : { privacyNoticeUrl }),
    ...(urcdpRegistration === undefined ? {} : { urcdpRegistration }),
    ...(processorsNotice === undefined ? {} : { processorsNotice }),
    ...(recipientsNotice === undefined ? {} : { recipientsNotice }),
    ...(internationalTransfersNotice === undefined ? {} : { internationalTransfersNotice }),
  };
}

export async function runDirectorySnapshotBuild(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly manifestPath: string; readonly profilesPath: string }> {
  const dataDirectory = await realpath(resolve(environment['DATA_INGESTION_DIR'] ?? 'data'));
  const mspPath = await resolveExistingPathInside(
    dataDirectory,
    await resolveLatestInput(
      environment['DIRECTORY_MSP_INPUT_PATH'],
      join(dataDirectory, 'processed', 'msp', 'infotitulos'),
      'professionals.ndjson',
      'MSP professionals',
    ),
    'MSP input',
  );
  const linkagePath = await resolveExistingPathInside(
    dataDirectory,
    await resolveLatestInput(
      environment['DIRECTORY_LINKAGE_INPUT_PATH'],
      join(dataDirectory, 'processed', 'linkage'),
      'candidates.ndjson',
      'linkage candidates',
    ),
    'Linkage input',
  );
  const [mspContent, linkageContent] = await Promise.all([
    readFile(mspPath),
    readFile(linkagePath),
  ]);
  const mspProfessionals = parseNdjsonContent(mspContent, parseMspDirectoryInput);
  const linkageCandidates = parseNdjsonContent(linkageContent, parseLinkageCandidate);
  const inputManifests = await validateInputManifests({
    dataDirectory,
    linkageContent,
    linkagePath,
    linkageRecords: linkageCandidates.length,
    mspContent,
    mspPath,
    mspRecords: mspProfessionals.length,
  });
  if (
    mspProfessionals.some(
      (professional) =>
        professional.provenance.publisher !== INFOTITULOS_PUBLISHER ||
        professional.provenance.dataset !== INFOTITULOS_DATASET ||
        professional.provenance.sourceCutoffDate !== inputManifests.mspSourceCutoffDate,
    )
  ) {
    throw new Error('MSP profile provenance does not match the selected MSP manifest');
  }
  const built = buildDirectorySnapshot(mspProfessionals, linkageCandidates);
  const generatedAt = new Date().toISOString();
  const notice = buildDirectoryLegalNotice(controllerConfigurationFromEnvironment(environment));
  const noticeContent = `${JSON.stringify(notice, null, 2)}\n`;
  const snapshotId = `factual-v3-${sha256(
    [
      sha256(mspContent),
      sha256(linkageContent),
      sha256(inputManifests.mspManifestContent),
      sha256(inputManifests.linkageManifestContent),
      sha256(noticeContent),
      DIRECTORY_NOTICE_VERSION,
    ].join('\u0000'),
  ).slice(0, 16)}`;
  const outputDirectory = await resolveFuturePathInside(
    dataDirectory,
    environment['DIRECTORY_OUTPUT_DIR'] ??
      join(dataDirectory, 'processed', 'directory', snapshotId),
    'Directory output',
  );
  const profilesPath = join(outputDirectory, 'profiles.ndjson');
  const linkageResolutionsPath = join(outputDirectory, 'linkage-resolutions.ndjson');
  const noticePath = join(outputDirectory, 'privacy-and-publication-notice.json');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const profilesContent = serializeNdjson(built.profiles);
  const linkageResolutionsContent = serializeNdjson(built.linkageResolutions);

  const manifest: DirectoryManifest = {
    schemaVersion: 2,
    snapshotId,
    generatedAt,
    noticeVersion: DIRECTORY_NOTICE_VERSION,
    inputs: [
      {
        relativePath: portableRelative(dataDirectory, mspPath),
        records: mspProfessionals.length,
        sha256: sha256(mspContent),
      },
      {
        relativePath: portableRelative(dataDirectory, linkagePath),
        records: linkageCandidates.length,
        sha256: sha256(linkageContent),
      },
      {
        relativePath: portableRelative(dataDirectory, inputManifests.mspManifestPath),
        records: 1,
        sha256: sha256(inputManifests.mspManifestContent),
      },
      {
        relativePath: portableRelative(dataDirectory, inputManifests.linkageManifestPath),
        records: 1,
        sha256: sha256(inputManifests.linkageManifestContent),
      },
    ],
    outputs: {
      profiles: {
        relativePath: portableRelative(dataDirectory, profilesPath),
        records: built.profiles.length,
        sha256: sha256(profilesContent),
      },
      linkageResolutions: {
        relativePath: portableRelative(dataDirectory, linkageResolutionsPath),
        records: built.linkageResolutions.length,
        sha256: sha256(linkageResolutionsContent),
      },
      legalNotice: {
        relativePath: portableRelative(dataDirectory, noticePath),
        records: 1,
        sha256: sha256(noticeContent),
      },
    },
    aggregates: built.aggregates,
    safeguards: {
      adverseDataAttached: false,
      automaticallyMerged: false,
      exhaustiveResolutionLedger: true,
      fuzzyMatchingUsed: false,
      institutionalObservationsAttached: false,
      institutionalLinksPublished: false,
      internalLinkageIdsPresent: true,
      publicExportAllowed: false,
      rawGovernmentIdentifiersPublished: false,
      reviewsAttached: false,
    },
    publicationGate: notice.publicationGate,
  };
  await installDirectorySnapshotAtomically({
    outputDirectory,
    profilesContent,
    linkageResolutionsContent,
    noticeContent,
    manifestContent: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  return { manifestPath, profilesPath };
}

async function main(): Promise<void> {
  const result = await runDirectorySnapshotBuild();
  console.log(JSON.stringify({ event: 'directory_snapshot_completed', ...result }));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
