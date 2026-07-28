import type { RegisteredTitleLookupRecord } from '../models/professional-credentials-read-model';

export interface ProfessionalCredentialsReader {
  findPublicByProfessionalId(
    professionalId: string,
  ): Promise<readonly RegisteredTitleLookupRecord[] | undefined>;
}

export const PROFESSIONAL_CREDENTIALS_READER = Symbol('PROFESSIONAL_CREDENTIALS_READER');
