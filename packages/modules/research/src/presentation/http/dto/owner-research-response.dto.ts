import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { OwnerProfessionalResearch } from '../../../application/models/owner-research-read-model';

class ResearchNameMatchResponseDto {
  @ApiProperty({
    enum: [
      'EXACT_NORMALIZED_NAME',
      'EXACT_TOKEN_MULTISET',
      'PARTIAL_TOKEN_SUBSET',
      'INITIALS_TOKEN_SUBSEQUENCE',
    ],
  })
  public readonly kind!: string;

  @ApiProperty({
    description:
      'Índice de flexibilidad del algoritmo: 0 exacto, 1 nombre parcial, 2 iniciales/abreviación. No es una probabilidad.',
    enum: [0, 1, 2],
  })
  public readonly flexibilityIndex!: number;

  @ApiProperty()
  public readonly canonicalTokenCount!: number;

  @ApiProperty()
  public readonly observedTokenCount!: number;

  @ApiProperty()
  public readonly exactObservedTokenCount!: number;

  @ApiProperty()
  public readonly initialObservedTokenCount!: number;

  @ApiProperty({
    enum: ['LOOSENESS_NOT_IDENTITY_CONFIDENCE'],
  })
  public readonly meaning!: string;
}

class OfficialTitleResponseDto {
  @ApiProperty()
  public readonly title!: string;

  @ApiProperty({
    nullable: true,
  })
  public readonly temporaryRegistration!: string | null;
}

class OfficialProvenanceResponseDto {
  @ApiProperty()
  public readonly publisher!: string;

  @ApiProperty()
  public readonly dataset!: string;

  @ApiProperty()
  public readonly sourceCutoffDate!: string;
}

class OfficialProfessionalResponseDto {
  @ApiProperty()
  public readonly fullName!: string;

  @ApiProperty({
    type: [OfficialTitleResponseDto],
  })
  public readonly enabledTitles!: readonly OfficialTitleResponseDto[];

  @ApiProperty({
    type: OfficialProvenanceResponseDto,
  })
  public readonly provenance!: OfficialProvenanceResponseDto;
}

class ResearchScheduleSourceResponseDto {
  @ApiProperty()
  public readonly id!: string;

  @ApiProperty()
  public readonly institution!: string;

  @ApiProperty({
    format: 'uri',
  })
  public readonly url!: string;
}

class ResearchScheduleVenueResponseDto {
  @ApiPropertyOptional()
  public readonly name?: string | undefined;

  @ApiPropertyOptional()
  public readonly address?: string | undefined;

  @ApiPropertyOptional()
  public readonly phone?: string | undefined;

  @ApiPropertyOptional()
  public readonly dependency?: string | undefined;
}

class WeeklyScheduleEntryResponseDto {
  @ApiProperty()
  public readonly dayOfWeek!: string;

  @ApiProperty()
  public readonly sourceLabel!: string;

  @ApiProperty()
  public readonly value!: string;
}

class ResearchScheduleResponseDto {
  @ApiProperty({
    enum: [1],
  })
  public readonly schemaVersion!: 1;

  @ApiProperty()
  public readonly recordId!: string;

  @ApiProperty({
    type: ResearchScheduleSourceResponseDto,
  })
  public readonly source!: ResearchScheduleSourceResponseDto;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly observedAt!: string;

  @ApiProperty({
    enum: ['published_consultation_roster'],
  })
  public readonly scheduleType!: string;

  @ApiProperty({
    description: 'El crawler no observa cupos ni disponibilidad de agenda en tiempo real.',
    enum: ['not_observed'],
  })
  public readonly appointmentAvailability!: string;

  @ApiProperty()
  public readonly sourceProfessionalId!: string;

  @ApiProperty()
  public readonly sourceProfessionalLabel!: string;

  @ApiProperty()
  public readonly professionalName!: string;

  @ApiProperty()
  public readonly specialty!: string;

  @ApiProperty({
    type: ResearchScheduleVenueResponseDto,
  })
  public readonly venue!: ResearchScheduleVenueResponseDto;

  @ApiProperty({
    type: [WeeklyScheduleEntryResponseDto],
  })
  public readonly weeklySchedule!: readonly WeeklyScheduleEntryResponseDto[];

  @ApiPropertyOptional()
  public readonly frequency?: string | undefined;

  @ApiPropertyOptional()
  public readonly notes?: string | undefined;
}

class InstitutionalProviderIdentityResponseDto {
  @ApiProperty()
  public readonly institution!: string;

  @ApiProperty({
    enum: ['institution_and_exact_name', 'source_professional_id'],
  })
  public readonly basis!: string;

  @ApiProperty({
    nullable: true,
  })
  public readonly sourceProfessionalId!: string | null;

  @ApiProperty()
  public readonly normalizedName!: string;
}

class UnresolvedSourceRecordResponseDto {
  @ApiProperty()
  public readonly recordId!: string;
}

class InstitutionalCandidateResponseDto {
  @ApiProperty()
  public readonly candidateId!: string;

  @ApiProperty()
  public readonly institution!: string;

  @ApiProperty({
    enum: [
      'ambiguous_exact_name',
      'exact_name_and_title_consistent',
      'exact_name_only',
      'unmatched',
    ],
  })
  public readonly status!: string;

  @ApiProperty({
    type: InstitutionalProviderIdentityResponseDto,
  })
  public readonly providerIdentity!: InstitutionalProviderIdentityResponseDto;

  @ApiProperty({
    type: [String],
  })
  public readonly sourceDisplayNames!: readonly string[];

  @ApiProperty({
    type: [String],
  })
  public readonly sourceSpecialties!: readonly string[];

  @ApiProperty({
    type: [String],
  })
  public readonly identityEvidence!: readonly string[];

  @ApiProperty({
    type: [ResearchScheduleResponseDto],
  })
  public readonly schedules!: readonly ResearchScheduleResponseDto[];

  @ApiProperty({
    type: [UnresolvedSourceRecordResponseDto],
  })
  public readonly unresolvedSourceRecords!: readonly UnresolvedSourceRecordResponseDto[];

  @ApiProperty()
  public readonly identityConfirmed!: boolean;

  @ApiProperty({
    enum: ['NOT_LINKED', 'LINKED'],
  })
  public readonly linkageDecision!: string;

  @ApiProperty({
    enum: ['NOT_PUBLISHED', 'PUBLISHED'],
  })
  public readonly publicationDecision!: string;

  @ApiProperty()
  public readonly requiresHumanReview!: boolean;

  @ApiProperty({
    type: [String],
  })
  public readonly alerts!: readonly string[];
}

class WebCandidateSubjectResponseDto {
  @ApiProperty()
  public readonly displayName!: string;
}

class WebCandidateClaimResponseDto {
  @ApiProperty({
    enum: [
      'ACADEMIC_MENTION',
      'INSTITUTIONAL_DIRECTORY_MENTION',
      'OFFICIAL_PUBLICATION_MENTION',
      'PROFESSIONAL_DIRECTORY_PROFILE',
    ],
  })
  public readonly category!: string;

  @ApiProperty()
  public readonly sourceId!: string;

  @ApiProperty()
  public readonly publisher!: string;
}

class WebCandidateMatchResponseDto {
  @ApiProperty({
    enum: ['EXACT_NORMALIZED_NAME', 'PARTIAL_TOKEN_SUBSET', 'INITIALS_TOKEN_SUBSEQUENCE'],
  })
  public readonly kind!: string;

  @ApiProperty({
    enum: [0, 1, 2],
  })
  public readonly flexibilityIndex!: number;

  @ApiProperty({
    enum: ['LOOSENESS_NOT_IDENTITY_CONFIDENCE'],
  })
  public readonly meaning!: string;

  @ApiProperty({
    enum: ['NONE', 'HOMONYM'],
  })
  public readonly ambiguity!: string;

  @ApiProperty({
    type: [String],
  })
  public readonly alerts!: readonly string[];
}

class WebCandidateProvenanceResponseDto {
  @ApiProperty({
    format: 'uri',
  })
  public readonly canonicalUrl!: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly retrievedAt!: string;

  @ApiProperty({
    enum: ['CRAWL4AI', 'DIRECT_FETCH'],
  })
  public readonly transport!: string;
}

class WebLinkageDecisionResponseDto {
  @ApiProperty({
    enum: ['NOT_LINKED'],
  })
  public readonly decision!: 'NOT_LINKED';

  @ApiProperty()
  public readonly identityConfirmed!: boolean;
}

class WebFactDecisionResponseDto {
  @ApiProperty()
  public readonly factConfirmed!: boolean;
}

class WebPublicationDecisionResponseDto {
  @ApiProperty({
    enum: ['NOT_PUBLISHED'],
  })
  public readonly decision!: 'NOT_PUBLISHED';

  @ApiProperty({
    enum: ['INTERNAL_QUARANTINE_ONLY'],
  })
  public readonly destination!: 'INTERNAL_QUARANTINE_ONLY';

  @ApiProperty()
  public readonly publicExportAllowed!: boolean;
}

class WebCandidateRetentionResponseDto {
  @ApiProperty({
    format: 'date-time',
  })
  public readonly expiresAt!: string;

  @ApiProperty({
    enum: ['DELETE_OR_REVALIDATE'],
  })
  public readonly disposition!: 'DELETE_OR_REVALIDATE';
}

class WebCandidateResponseDto {
  @ApiProperty({
    enum: [1],
  })
  public readonly schemaVersion!: 1;

  @ApiProperty()
  public readonly candidateId!: string;

  @ApiProperty({
    enum: ['NEEDS_HUMAN_REVIEW'],
  })
  public readonly state!: 'NEEDS_HUMAN_REVIEW';

  @ApiProperty()
  public readonly quarantine!: boolean;

  @ApiProperty({
    type: WebCandidateSubjectResponseDto,
  })
  public readonly subject!: WebCandidateSubjectResponseDto;

  @ApiProperty({
    type: WebCandidateClaimResponseDto,
  })
  public readonly claim!: WebCandidateClaimResponseDto;

  @ApiProperty({
    type: WebCandidateMatchResponseDto,
  })
  public readonly match!: WebCandidateMatchResponseDto;

  @ApiProperty({
    type: WebCandidateProvenanceResponseDto,
  })
  public readonly provenance!: WebCandidateProvenanceResponseDto;

  @ApiProperty({
    type: WebLinkageDecisionResponseDto,
  })
  public readonly linkageDecision!: WebLinkageDecisionResponseDto;

  @ApiProperty({
    type: WebFactDecisionResponseDto,
  })
  public readonly factDecision!: WebFactDecisionResponseDto;

  @ApiProperty({
    type: WebPublicationDecisionResponseDto,
  })
  public readonly publicationDecision!: WebPublicationDecisionResponseDto;

  @ApiProperty({
    type: WebCandidateRetentionResponseDto,
  })
  public readonly retention!: WebCandidateRetentionResponseDto;
}

class PublicReferenceClaimResponseDto {
  @ApiProperty({
    enum: [
      'MEDICAL_STUDENT_PRESENTATION',
      'ACADEMIC_RESEARCH_COAUTHOR',
      'SPECIALTY_MONOGRAPH_POSTER_COAUTHOR',
      'RESEARCH_PROJECT_APPROVAL_CONTEXT',
    ],
  })
  public readonly relationship!: string;

  @ApiProperty()
  public readonly factualSummary!: string;

  @ApiProperty({
    type: [String],
  })
  public readonly institutionContext!: readonly string[];

  @ApiProperty({
    type: [String],
  })
  public readonly doesNotEstablish!: readonly string[];
}

class PublicReferenceAccessResponseDto {
  @ApiProperty({
    enum: [
      'ALLOWLISTED_PUBLIC_PAGE',
      'PUBLIC_METADATA_ONLY',
      'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH',
      'OFFICIAL_CONTEXT_DOCUMENT',
    ],
  })
  public readonly mode!: string;

  @ApiProperty()
  public readonly automatedFetchAllowed!: boolean;

  @ApiProperty()
  public readonly contentStored!: boolean;

  @ApiProperty()
  public readonly rightsNote!: string;
}

class PublicReferenceDecisionResponseDto {
  @ApiProperty()
  public readonly identityConfirmed!: boolean;

  @ApiProperty()
  public readonly factConfirmed!: boolean;

  @ApiProperty({
    enum: ['NOT_LINKED', 'LINKED'],
  })
  public readonly linkageDecision!: string;

  @ApiProperty({
    enum: ['NOT_PUBLISHED', 'PUBLISHED'],
  })
  public readonly publicationDecision!: string;

  @ApiProperty()
  public readonly publicExportAllowed!: boolean;

  @ApiProperty()
  public readonly requiresHumanReview!: boolean;
}

class PublicReferenceResponseDto {
  @ApiProperty({
    enum: [1],
  })
  public readonly schemaVersion!: 1;

  @ApiProperty()
  public readonly referenceId!: string;

  @ApiProperty({
    enum: [
      'CRAWLED_SOURCE_METADATA',
      'PUBLIC_METADATA_REFERENCE',
      'MANUAL_REFERENCE_NO_AUTOMATED_FETCH',
      'CONTEXT_CORROBORATION_ONLY',
    ],
  })
  public readonly referenceKind!: string;

  @ApiProperty()
  public readonly publisher!: string;

  @ApiProperty({
    format: 'uri',
  })
  public readonly canonicalUrl!: string;

  @ApiProperty()
  public readonly title!: string;

  @ApiProperty()
  public readonly sourceDate!: string;

  @ApiProperty({
    enum: ['DAY', 'MONTH', 'YEAR'],
  })
  public readonly sourceDatePrecision!: string;

  @ApiProperty({
    type: [String],
  })
  public readonly observedNames!: readonly string[];

  @ApiProperty({
    type: PublicReferenceClaimResponseDto,
  })
  public readonly claim!: PublicReferenceClaimResponseDto;

  @ApiProperty({
    type: PublicReferenceAccessResponseDto,
  })
  public readonly access!: PublicReferenceAccessResponseDto;

  @ApiProperty({
    type: [String],
  })
  public readonly corroboratesReferenceIds!: readonly string[];

  @ApiProperty({
    type: PublicReferenceDecisionResponseDto,
  })
  public readonly decision!: PublicReferenceDecisionResponseDto;
}

class PublicReferenceCandidateResponseDto {
  @ApiProperty({
    type: PublicReferenceResponseDto,
  })
  public readonly reference!: PublicReferenceResponseDto;

  @ApiProperty({
    nullable: true,
    type: ResearchNameMatchResponseDto,
  })
  public readonly nameMatch!: ResearchNameMatchResponseDto | null;

  @ApiProperty({
    enum: ['DIRECT_NAME_CANDIDATE', 'CORROBORATES_MATCHED_REFERENCE_CONTEXT_ONLY'],
  })
  public readonly connection!: string;

  @ApiProperty({
    type: [String],
  })
  public readonly alerts!: readonly string[];
}

class EthicsCaseDocumentResponseDto {
  @ApiProperty()
  public readonly label!: string;

  @ApiProperty({
    nullable: true,
  })
  public readonly sourceDate!: string | null;

  @ApiProperty({
    enum: ['DAY'],
    nullable: true,
  })
  public readonly sourceDatePrecision!: 'DAY' | null;

  @ApiProperty({
    enum: [false],
  })
  public readonly contentFetched!: false;
}

class EthicsCaseSourceResponseDto {
  @ApiProperty({
    format: 'uri',
  })
  public readonly sitemapUrl!: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
  })
  public readonly sitemapLastModified!: string | null;

  @ApiProperty({
    format: 'uri',
  })
  public readonly robotsUrl!: string;

  @ApiProperty({
    enum: [true],
  })
  public readonly pageMetadataOnly!: true;
}

class EthicsCaseResponseDto {
  @ApiProperty({
    enum: [1],
  })
  public readonly schemaVersion!: 1;

  @ApiProperty()
  public readonly ethicsCaseId!: string;

  @ApiProperty()
  public readonly sourceCaseKey!: string;

  @ApiProperty()
  public readonly publisher!: string;

  @ApiProperty()
  public readonly tribunal!: string;

  @ApiProperty()
  public readonly title!: string;

  @ApiProperty({
    format: 'uri',
  })
  public readonly canonicalUrl!: string;

  @ApiProperty({
    enum: ['AUTOMATED_PUBLIC_METADATA_SNAPSHOT'],
  })
  public readonly collectionMode!: string;

  @ApiProperty({
    enum: ['ORIGINAL', 'ANONYMIZED', 'MIXED', 'UNKNOWN'],
  })
  public readonly visibility!: string;

  @ApiProperty({
    enum: ['UNKNOWN'],
  })
  public readonly outcome!: 'UNKNOWN';

  @ApiProperty({
    enum: ['UNKNOWN'],
  })
  public readonly finalityStatus!: 'UNKNOWN';

  @ApiProperty({
    enum: [false],
  })
  public readonly currentnessVerified!: false;

  @ApiProperty({
    nullable: true,
  })
  public readonly sourceDate!: string | null;

  @ApiProperty({
    enum: ['DAY'],
    nullable: true,
  })
  public readonly sourceDatePrecision!: 'DAY' | null;

  @ApiProperty({
    type: [String],
  })
  public readonly observedRespondentNames!: readonly string[];

  @ApiProperty({
    type: [EthicsCaseDocumentResponseDto],
  })
  public readonly documents!: readonly EthicsCaseDocumentResponseDto[];

  @ApiProperty({
    format: 'date-time',
  })
  public readonly firstObservedAt!: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly lastObservedAt!: string;

  @ApiProperty({
    enum: [false],
  })
  public readonly contentStored!: false;

  @ApiProperty({
    type: EthicsCaseSourceResponseDto,
  })
  public readonly source!: EthicsCaseSourceResponseDto;
}

class EthicsCaseDecisionResponseDto {
  @ApiProperty({
    enum: [false],
  })
  public readonly identityConfirmed!: false;

  @ApiProperty({
    enum: [false],
  })
  public readonly factConfirmed!: false;

  @ApiProperty({
    enum: ['NOT_LINKED'],
  })
  public readonly linkageDecision!: 'NOT_LINKED';

  @ApiProperty({
    enum: ['NOT_PUBLISHED'],
  })
  public readonly publicationDecision!: 'NOT_PUBLISHED';

  @ApiProperty({
    enum: [false],
  })
  public readonly publicExportAllowed!: false;

  @ApiProperty({
    enum: [true],
  })
  public readonly requiresHumanReview!: true;
}

class EthicsCaseCandidateResponseDto {
  @ApiProperty({
    type: EthicsCaseResponseDto,
  })
  public readonly ethicsCase!: EthicsCaseResponseDto;

  @ApiProperty()
  public readonly observedName!: string;

  @ApiProperty({
    type: ResearchNameMatchResponseDto,
  })
  public readonly nameMatch!: ResearchNameMatchResponseDto;

  @ApiProperty({
    type: EthicsCaseDecisionResponseDto,
  })
  public readonly decision!: EthicsCaseDecisionResponseDto;

  @ApiProperty({
    type: [String],
  })
  public readonly alerts!: readonly string[];
}

class SourceCoverageResponseDto {
  @ApiProperty()
  public readonly sourceId!: string;

  @ApiProperty()
  public readonly publisher!: string;

  @ApiProperty({
    format: 'uri',
  })
  public readonly sourceUrl!: string;

  @ApiProperty({
    enum: ['PROFESSIONAL_ETHICS_RULINGS'],
  })
  public readonly category!: string;

  @ApiProperty({
    enum: ['SOURCE_BLOCKED_ROBOTS', 'AUTHORIZED_FETCH_NOT_CONFIGURED', 'CHECKED'],
  })
  public readonly status!: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly policyReviewedAt!: string;

  @ApiProperty()
  public readonly automatedFetchPerformed!: boolean;

  @ApiProperty({
    enum: [
      'NOT_CHECKED_DUE_TO_AUTOMATION_PROHIBITED',
      'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
      'CANDIDATE_REQUIRES_HUMAN_REVIEW',
    ],
  })
  public readonly namedMatchStatus!: string;

  @ApiProperty()
  public readonly noFindingProvesAbsence!: boolean;

  @ApiProperty({
    enum: ['NOT_LINKED', 'LINKED'],
  })
  public readonly identityDecision!: string;

  @ApiProperty({
    enum: ['NOT_PUBLISHED', 'PUBLISHED'],
  })
  public readonly publicationDecision!: string;

  @ApiProperty({
    type: [String],
  })
  public readonly warnings!: readonly string[];
}

class ResearchSignalSummaryResponseDto {
  @ApiProperty()
  public readonly officialRegistryRecords!: number;

  @ApiProperty()
  public readonly institutionalCandidates!: number;

  @ApiProperty()
  public readonly scheduleRecords!: number;

  @ApiProperty()
  public readonly webCandidates!: number;

  @ApiProperty()
  public readonly publicReferenceCandidates!: number;

  @ApiProperty()
  public readonly ethicsCandidates!: number;

  @ApiProperty({
    type: [String],
  })
  public readonly publishers!: readonly string[];

  @ApiProperty({
    type: [String],
  })
  public readonly institutionContexts!: readonly string[];
}

class OwnerResearchCandidateResponseDto {
  @ApiProperty({
    type: OfficialProfessionalResponseDto,
  })
  public readonly professional!: OfficialProfessionalResponseDto;

  @ApiProperty({
    type: ResearchNameMatchResponseDto,
  })
  public readonly queryMatch!: ResearchNameMatchResponseDto;

  @ApiProperty({
    type: [InstitutionalCandidateResponseDto],
  })
  public readonly institutionalCandidates!: readonly InstitutionalCandidateResponseDto[];

  @ApiProperty({
    type: [WebCandidateResponseDto],
  })
  public readonly webCandidates!: readonly WebCandidateResponseDto[];

  @ApiProperty({
    type: [PublicReferenceCandidateResponseDto],
  })
  public readonly publicReferenceCandidates!: readonly PublicReferenceCandidateResponseDto[];

  @ApiProperty({
    type: [EthicsCaseCandidateResponseDto],
  })
  public readonly ethicsCaseCandidates!: readonly EthicsCaseCandidateResponseDto[];

  @ApiProperty({
    type: [SourceCoverageResponseDto],
  })
  public readonly sourceCoverage!: readonly SourceCoverageResponseDto[];

  @ApiProperty({
    type: ResearchSignalSummaryResponseDto,
  })
  public readonly signalSummary!: ResearchSignalSummaryResponseDto;
}

class OwnerResearchQueryResponseDto {
  @ApiProperty({
    enum: ['NAME', 'OPAQUE_MSP_ID'],
  })
  public readonly mode!: string;

  @ApiProperty({
    enum: ['ALL_BEST_LOOSENESS_MATCHES'],
  })
  public readonly selectionRule!: string;

  @ApiProperty({
    enum: [0, 1, 2],
    nullable: true,
  })
  public readonly bestFlexibilityIndex!: number | null;

  @ApiProperty({
    enum: ['NONE', 'MULTIPLE_CANDIDATES', 'NO_CANDIDATE'],
  })
  public readonly ambiguity!: string;
}

class OwnerResearchCoverageResponseDto {
  @ApiProperty()
  public readonly mspSnapshotChecked!: boolean;

  @ApiProperty()
  public readonly linkageSnapshotChecked!: boolean;

  @ApiProperty()
  public readonly scheduleArtifactsChecked!: number;

  @ApiProperty()
  public readonly webEnrichmentSnapshotChecked!: boolean;

  @ApiProperty()
  public readonly curatedReferenceLedgerChecked!: boolean;

  @ApiProperty()
  public readonly ethicsMetadataSnapshotChecked!: boolean;

  @ApiProperty()
  public readonly ethicsCasesObserved!: number;

  @ApiProperty()
  public readonly noFindingsProvesAbsence!: boolean;
}

class OwnerResearchDeliveryResponseDto {
  @ApiProperty({
    enum: ['AUTHENTICATED_PRIVATE_API'],
  })
  public readonly intendedSurface!: string;

  @ApiProperty({
    enum: ['OWNER_ONLY'],
  })
  public readonly intendedAudience!: string;

  @ApiProperty()
  public readonly canonicalUrlsIncluded!: boolean;

  @ApiProperty()
  public readonly privateApiDeliveryAllowed!: boolean;

  @ApiProperty()
  public readonly publicApiDeliveryAllowed!: boolean;

  @ApiProperty({
    enum: ['CALLING_API'],
  })
  public readonly authenticationEnforcedBy!: string;
}

class OwnerResearchPublicationResponseDto {
  @ApiProperty({
    enum: ['NOT_PUBLISHED'],
  })
  public readonly decision!: string;

  @ApiProperty({
    enum: ['INTERNAL_RESEARCH_ONLY'],
  })
  public readonly destination!: string;

  @ApiProperty()
  public readonly publicExportAllowed!: boolean;

  @ApiProperty()
  public readonly automaticIdentityConfirmation!: boolean;

  @ApiProperty()
  public readonly automaticFactConfirmation!: boolean;
}

class OwnerResearchDossierResponseDto {
  @ApiProperty({
    enum: [1],
  })
  public readonly schemaVersion!: 1;

  @ApiProperty()
  public readonly reportId!: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly generatedAt!: string;

  @ApiProperty({
    enum: ['INTERNAL_PROFESSIONAL_RESEARCH'],
  })
  public readonly purpose!: string;

  @ApiProperty({
    type: OwnerResearchQueryResponseDto,
  })
  public readonly query!: OwnerResearchQueryResponseDto;

  @ApiProperty({
    type: [OwnerResearchCandidateResponseDto],
  })
  public readonly candidates!: readonly OwnerResearchCandidateResponseDto[];

  @ApiProperty({
    type: OwnerResearchCoverageResponseDto,
  })
  public readonly coverage!: OwnerResearchCoverageResponseDto;

  @ApiProperty({
    type: [String],
  })
  public readonly warnings!: readonly string[];

  @ApiProperty({
    type: OwnerResearchDeliveryResponseDto,
  })
  public readonly delivery!: OwnerResearchDeliveryResponseDto;

  @ApiProperty({
    type: OwnerResearchPublicationResponseDto,
  })
  public readonly publication!: OwnerResearchPublicationResponseDto;
}

class OwnerResearchCountsResponseDto {
  @ApiProperty()
  public readonly candidates!: number;

  @ApiProperty()
  public readonly officialRegistryRecords!: number;

  @ApiProperty()
  public readonly institutionalCandidates!: number;

  @ApiProperty()
  public readonly schedules!: number;

  @ApiProperty()
  public readonly webCandidates!: number;

  @ApiProperty()
  public readonly publicReferenceCandidates!: number;

  @ApiProperty()
  public readonly ethicsCandidates!: number;
}

class OwnerResearchNoticeResponseDto {
  @ApiProperty({
    enum: [true],
  })
  public readonly associationsAreUnconfirmedCandidates!: true;

  @ApiProperty({
    enum: [true],
  })
  public readonly sourceDeclaredSpecialtyIsNotMspCredential!: true;

  @ApiProperty({
    enum: [true],
  })
  public readonly publishedScheduleIsNotRealtimeAvailability!: true;

  @ApiProperty({
    enum: [true],
  })
  public readonly absenceOfFindingsDoesNotProveAbsence!: true;

  @ApiProperty({
    enum: [true],
  })
  public readonly verifyWithOriginalSource!: true;

  @ApiProperty()
  public readonly text!: string;
}

export class OwnerProfessionalResearchResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  public readonly professionalId: string;

  @ApiProperty()
  public readonly slug: string;

  @ApiProperty()
  public readonly analysisVersion: string;

  @ApiProperty({
    enum: ['COMPLETED', 'PARTIAL'],
  })
  public readonly runStatus: string;

  @ApiProperty()
  public readonly reportId: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly generatedAt: string;

  @ApiProperty({
    enum: ['NONE', 'MULTIPLE_CANDIDATES', 'NO_CANDIDATE'],
  })
  public readonly queryAmbiguity: string;

  @ApiProperty({
    enum: [0, 1, 2],
    nullable: true,
  })
  public readonly bestFlexibilityIndex: 0 | 1 | 2 | null;

  @ApiProperty({
    type: OwnerResearchCountsResponseDto,
  })
  public readonly counts: OwnerResearchCountsResponseDto;

  @ApiProperty({
    type: OwnerResearchNoticeResponseDto,
  })
  public readonly notice: OwnerResearchNoticeResponseDto;

  @ApiProperty({
    type: OwnerResearchDossierResponseDto,
  })
  public readonly dossier: OwnerResearchDossierResponseDto;

  public constructor(research: OwnerProfessionalResearch) {
    this.professionalId = research.professionalId;
    this.slug = research.slug;
    this.analysisVersion = research.analysisVersion;
    this.runStatus = research.runStatus;
    this.reportId = research.reportId;
    this.generatedAt = research.generatedAt;
    this.queryAmbiguity = research.queryAmbiguity;
    this.bestFlexibilityIndex = research.bestFlexibilityIndex;
    this.counts = research.counts;
    this.notice = research.notice;
    this.dossier = research.dossier;
  }
}
