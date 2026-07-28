import type { TemporaryRegistrationKind } from '../../domain/registered-title-state';
import type { PublicEvidenceReference } from '@medicos/provenance';

export interface RegisteredTitleLookupRecord {
  readonly id: string;
  readonly title: string;
  readonly temporaryRegistration: TemporaryRegistrationKind;
  readonly evidenceId: string;
}

export interface RegisteredTitleDetail {
  readonly id: string;
  readonly title: string;
  readonly registrationState: 'ENABLED';
  readonly temporaryRegistration: TemporaryRegistrationKind;
  readonly evidence: PublicEvidenceReference;
}

export interface ProfessionalCredentialsDetail {
  readonly professionalId: string;
  readonly registeredTitles: readonly RegisteredTitleDetail[];
}
