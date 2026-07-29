import { z } from 'zod';

import { OwnerResearchDataIntegrityError } from '../errors/owner-research.error';

const nonEmptyString = z.string().min(1);
const nullableNonEmptyString = nonEmptyString.nullable();
const flexibilityIndex = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const nullableFlexibilityIndex = flexibilityIndex.nullable();

const researchNameMatchSchema = z.object({
  kind: z.enum([
    'EXACT_NORMALIZED_NAME',
    'EXACT_TOKEN_MULTISET',
    'PARTIAL_TOKEN_SUBSET',
    'INITIALS_TOKEN_SUBSEQUENCE',
  ]),
  flexibilityIndex,
  canonicalTokenCount: z.number().int().nonnegative(),
  observedTokenCount: z.number().int().nonnegative(),
  exactObservedTokenCount: z.number().int().nonnegative(),
  initialObservedTokenCount: z.number().int().nonnegative(),
  meaning: z.literal('LOOSENESS_NOT_IDENTITY_CONFIDENCE'),
});

const officialProfessionalSchema = z.object({
  fullName: nonEmptyString,
  enabledTitles: z.array(
    z.object({
      title: nonEmptyString,
      temporaryRegistration: nullableNonEmptyString,
    }),
  ),
  provenance: z.object({
    publisher: nonEmptyString,
    dataset: nonEmptyString,
    sourceCutoffDate: nonEmptyString,
  }),
});

const weeklyScheduleEntrySchema = z.object({
  dayOfWeek: nonEmptyString,
  sourceLabel: nonEmptyString,
  value: nonEmptyString,
});

const scheduleSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: nonEmptyString,
  source: z.object({
    id: nonEmptyString,
    institution: nonEmptyString,
    url: z.string().url(),
  }),
  observedAt: nonEmptyString,
  scheduleType: z.literal('published_consultation_roster'),
  appointmentAvailability: z.literal('not_observed'),
  sourceProfessionalId: nonEmptyString,
  sourceProfessionalLabel: nonEmptyString,
  professionalName: nonEmptyString,
  specialty: nonEmptyString,
  venue: z.object({
    name: nonEmptyString.optional(),
    address: nonEmptyString.optional(),
    phone: nonEmptyString.optional(),
    dependency: nonEmptyString.optional(),
  }),
  weeklySchedule: z.array(weeklyScheduleEntrySchema),
  frequency: nonEmptyString.optional(),
  notes: nonEmptyString.optional(),
});

const institutionalCandidateSchema = z.object({
  candidateId: nonEmptyString,
  institution: nonEmptyString,
  status: z.enum([
    'ambiguous_exact_name',
    'exact_name_and_title_consistent',
    'exact_name_only',
    'unmatched',
  ]),
  providerIdentity: z.object({
    institution: nonEmptyString,
    basis: z.enum(['institution_and_exact_name', 'source_professional_id']),
    sourceProfessionalId: nullableNonEmptyString,
    normalizedName: nonEmptyString,
  }),
  sourceDisplayNames: z.array(nonEmptyString),
  sourceSpecialties: z.array(nonEmptyString),
  identityEvidence: z.array(nonEmptyString),
  schedules: z.array(scheduleSchema),
  unresolvedSourceRecords: z.array(
    z.object({
      recordId: nonEmptyString,
    }),
  ),
  identityConfirmed: z.boolean(),
  linkageDecision: z.enum(['NOT_LINKED', 'LINKED']),
  publicationDecision: z.enum(['NOT_PUBLISHED', 'PUBLISHED']),
  requiresHumanReview: z.boolean(),
  alerts: z.array(nonEmptyString),
});

const webCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: nonEmptyString,
  state: z.literal('NEEDS_HUMAN_REVIEW'),
  quarantine: z.boolean(),
  subject: z.object({
    displayName: nonEmptyString,
  }),
  claim: z.object({
    category: z.enum([
      'ACADEMIC_MENTION',
      'INSTITUTIONAL_DIRECTORY_MENTION',
      'OFFICIAL_PUBLICATION_MENTION',
      'PROFESSIONAL_DIRECTORY_PROFILE',
    ]),
    sourceId: nonEmptyString,
    publisher: nonEmptyString,
  }),
  match: z.object({
    kind: z.enum(['EXACT_NORMALIZED_NAME', 'PARTIAL_TOKEN_SUBSET', 'INITIALS_TOKEN_SUBSEQUENCE']),
    flexibilityIndex,
    meaning: z.literal('LOOSENESS_NOT_IDENTITY_CONFIDENCE'),
    ambiguity: z.enum(['NONE', 'HOMONYM']),
    alerts: z.array(nonEmptyString),
  }),
  provenance: z.object({
    canonicalUrl: z.string().url(),
    retrievedAt: nonEmptyString,
    transport: z.enum(['CRAWL4AI', 'DIRECT_FETCH']),
  }),
  linkageDecision: z.object({
    decision: z.literal('NOT_LINKED'),
    identityConfirmed: z.boolean(),
  }),
  factDecision: z.object({
    factConfirmed: z.boolean(),
  }),
  publicationDecision: z.object({
    decision: z.literal('NOT_PUBLISHED'),
    destination: z.literal('INTERNAL_QUARANTINE_ONLY'),
    publicExportAllowed: z.boolean(),
  }),
  retention: z.object({
    expiresAt: nonEmptyString,
    disposition: z.literal('DELETE_OR_REVALIDATE'),
  }),
});

const publicReferenceSchema = z.object({
  schemaVersion: z.literal(1),
  referenceId: nonEmptyString,
  referenceKind: z.enum([
    'CRAWLED_SOURCE_METADATA',
    'PUBLIC_METADATA_REFERENCE',
    'MANUAL_REFERENCE_NO_AUTOMATED_FETCH',
    'CONTEXT_CORROBORATION_ONLY',
  ]),
  publisher: nonEmptyString,
  canonicalUrl: z.string().url(),
  title: nonEmptyString,
  sourceDate: nonEmptyString,
  sourceDatePrecision: z.enum(['DAY', 'MONTH', 'YEAR']),
  observedNames: z.array(nonEmptyString),
  claim: z.object({
    relationship: z.enum([
      'MEDICAL_STUDENT_PRESENTATION',
      'ACADEMIC_RESEARCH_COAUTHOR',
      'SPECIALTY_MONOGRAPH_POSTER_COAUTHOR',
      'RESEARCH_PROJECT_APPROVAL_CONTEXT',
    ]),
    factualSummary: nonEmptyString,
    institutionContext: z.array(nonEmptyString),
    doesNotEstablish: z.array(nonEmptyString),
  }),
  access: z.object({
    mode: z.enum([
      'ALLOWLISTED_PUBLIC_PAGE',
      'PUBLIC_METADATA_ONLY',
      'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH',
      'OFFICIAL_CONTEXT_DOCUMENT',
    ]),
    automatedFetchAllowed: z.boolean(),
    contentStored: z.boolean(),
    rightsNote: nonEmptyString,
  }),
  corroboratesReferenceIds: z.array(nonEmptyString),
  decision: z.object({
    identityConfirmed: z.boolean(),
    factConfirmed: z.boolean(),
    linkageDecision: z.enum(['NOT_LINKED', 'LINKED']),
    publicationDecision: z.enum(['NOT_PUBLISHED', 'PUBLISHED']),
    publicExportAllowed: z.boolean(),
    requiresHumanReview: z.boolean(),
  }),
});

const publicReferenceCandidateSchema = z.object({
  reference: publicReferenceSchema,
  nameMatch: researchNameMatchSchema.nullable(),
  connection: z.enum(['DIRECT_NAME_CANDIDATE', 'CORROBORATES_MATCHED_REFERENCE_CONTEXT_ONLY']),
  alerts: z.array(nonEmptyString),
});

const sourceCoverageSchema = z.object({
  sourceId: nonEmptyString,
  publisher: nonEmptyString,
  sourceUrl: z.string().url(),
  category: z.literal('PROFESSIONAL_ETHICS_RULINGS'),
  status: z.enum(['SOURCE_BLOCKED_ROBOTS', 'AUTHORIZED_FETCH_NOT_CONFIGURED', 'CHECKED']),
  policyReviewedAt: nonEmptyString,
  automatedFetchPerformed: z.boolean(),
  namedMatchStatus: z.enum([
    'NOT_CHECKED_DUE_TO_AUTOMATION_PROHIBITED',
    'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
    'CANDIDATE_REQUIRES_HUMAN_REVIEW',
  ]),
  noFindingProvesAbsence: z.boolean(),
  identityDecision: z.enum(['NOT_LINKED', 'LINKED']),
  publicationDecision: z.enum(['NOT_PUBLISHED', 'PUBLISHED']),
  warnings: z.array(nonEmptyString),
});

const researchCandidateSchema = z.object({
  professional: officialProfessionalSchema,
  queryMatch: researchNameMatchSchema,
  institutionalCandidates: z.array(institutionalCandidateSchema),
  webCandidates: z.array(webCandidateSchema),
  publicReferenceCandidates: z.array(publicReferenceCandidateSchema),
  sourceCoverage: z.array(sourceCoverageSchema).default([]),
  signalSummary: z.object({
    officialRegistryRecords: z.number().int().nonnegative(),
    institutionalCandidates: z.number().int().nonnegative(),
    scheduleRecords: z.number().int().nonnegative(),
    webCandidates: z.number().int().nonnegative(),
    publicReferenceCandidates: z.number().int().nonnegative(),
    publishers: z.array(nonEmptyString),
    institutionContexts: z.array(nonEmptyString),
  }),
});

const ownerResearchDossierSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: nonEmptyString,
  generatedAt: nonEmptyString,
  purpose: z.literal('INTERNAL_PROFESSIONAL_RESEARCH'),
  query: z.object({
    mode: z.enum(['NAME', 'OPAQUE_MSP_ID']),
    selectionRule: z.literal('ALL_BEST_LOOSENESS_MATCHES'),
    bestFlexibilityIndex: nullableFlexibilityIndex,
    ambiguity: z.enum(['NONE', 'MULTIPLE_CANDIDATES', 'NO_CANDIDATE']),
  }),
  candidates: z.array(researchCandidateSchema),
  coverage: z.object({
    mspSnapshotChecked: z.boolean(),
    linkageSnapshotChecked: z.boolean(),
    scheduleArtifactsChecked: z.number().int().nonnegative(),
    webEnrichmentSnapshotChecked: z.boolean(),
    curatedReferenceLedgerChecked: z.boolean(),
    noFindingsProvesAbsence: z.boolean(),
  }),
  warnings: z.array(nonEmptyString),
  delivery: z.object({
    intendedSurface: z.literal('AUTHENTICATED_PRIVATE_API'),
    intendedAudience: z.literal('OWNER_ONLY'),
    canonicalUrlsIncluded: z.boolean(),
    privateApiDeliveryAllowed: z.boolean(),
    publicApiDeliveryAllowed: z.boolean(),
    authenticationEnforcedBy: z.literal('CALLING_API'),
  }),
  publication: z.object({
    decision: z.literal('NOT_PUBLISHED'),
    destination: z.literal('INTERNAL_RESEARCH_ONLY'),
    publicExportAllowed: z.boolean(),
    automaticIdentityConfirmation: z.boolean(),
    automaticFactConfirmation: z.boolean(),
  }),
});

export type OwnerResearchDossier = z.output<typeof ownerResearchDossierSchema>;
export type OwnerResearchCandidate = OwnerResearchDossier['candidates'][number];
export type OwnerResearchInstitutionalCandidate =
  OwnerResearchCandidate['institutionalCandidates'][number];
export type OwnerResearchSchedule = OwnerResearchInstitutionalCandidate['schedules'][number];

export interface PersistedOwnerResearchRecord {
  readonly professionalId: string;
  readonly slug: string;
  readonly analysisVersion: string;
  readonly runStatus: string;
  readonly reportId: string;
  readonly generatedAt: string;
  readonly queryAmbiguity: string;
  readonly bestFlexibilityIndex: 0 | 1 | 2 | null;
  readonly counts: {
    readonly candidates: number;
    readonly officialRegistryRecords: number;
    readonly institutionalCandidates: number;
    readonly schedules: number;
    readonly webCandidates: number;
    readonly publicReferenceCandidates: number;
    readonly ethicsCandidates: number;
  };
  readonly researchView: unknown;
}

export interface OwnerProfessionalResearch extends Omit<
  PersistedOwnerResearchRecord,
  'researchView'
> {
  readonly notice: {
    readonly associationsAreUnconfirmedCandidates: true;
    readonly sourceDeclaredSpecialtyIsNotMspCredential: true;
    readonly publishedScheduleIsNotRealtimeAvailability: true;
    readonly absenceOfFindingsDoesNotProveAbsence: true;
    readonly verifyWithOriginalSource: true;
    readonly text: string;
  };
  readonly dossier: OwnerResearchDossier;
}

export function sanitizeOwnerResearchDossier(value: unknown): OwnerResearchDossier {
  const result = ownerResearchDossierSchema.safeParse(value);

  if (!result.success) {
    throw new OwnerResearchDataIntegrityError();
  }

  return result.data;
}
