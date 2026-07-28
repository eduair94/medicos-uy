import { eq } from 'drizzle-orm';

import { publicRegisteredTitleView } from './credentials.schema';

import type { RegisteredTitleLookupRecord } from '../../../application/models/professional-credentials-read-model';
import type { ProfessionalCredentialsReader } from '../../../application/ports/professional-credentials-reader.port';
import type { CatalogDatabase } from '@medicos/database';

export class DrizzleProfessionalCredentialsReader implements ProfessionalCredentialsReader {
  public constructor(private readonly database: CatalogDatabase) {}

  public async findPublicByProfessionalId(
    professionalId: string,
  ): Promise<readonly RegisteredTitleLookupRecord[] | undefined> {
    const rows = await this.database
      .select({
        id: publicRegisteredTitleView.id,
        title: publicRegisteredTitleView.title,
        evidenceId: publicRegisteredTitleView.currentEvidenceId,
        temporaryRegistration: publicRegisteredTitleView.temporaryRegistration,
      })
      .from(publicRegisteredTitleView)
      .where(eq(publicRegisteredTitleView.professionalId, professionalId))
      .orderBy(publicRegisteredTitleView.normalizedTitle, publicRegisteredTitleView.id);

    return rows.length === 0 ? undefined : rows;
  }
}
