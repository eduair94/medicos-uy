import {
  InvalidProfessionalCredentialsQueryError,
  ProfessionalCredentialsNotFoundError,
} from '../errors/professional-credentials.error';

import type {
  ProfessionalCredentialsDetail,
  RegisteredTitleDetail,
} from '../models/professional-credentials-read-model';
import type { ProfessionalCredentialsReader } from '../ports/professional-credentials-reader.port';
import type { ApprovedEvidenceFinder } from '@medicos/provenance';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class GetProfessionalCredentials {
  public constructor(
    private readonly credentials: ProfessionalCredentialsReader,
    private readonly evidence: ApprovedEvidenceFinder,
  ) {}

  public async execute(rawProfessionalId: string): Promise<ProfessionalCredentialsDetail> {
    const professionalId = rawProfessionalId.trim();

    if (!UUID_PATTERN.test(professionalId)) {
      throw new InvalidProfessionalCredentialsQueryError();
    }

    const records = await this.credentials.findPublicByProfessionalId(professionalId);

    if (records === undefined) {
      throw new ProfessionalCredentialsNotFoundError();
    }

    const titles = await Promise.all(
      records.map(async (record): Promise<RegisteredTitleDetail | undefined> => {
        const evidence = await this.evidence.findApprovedById(record.evidenceId);

        if (evidence === undefined) {
          return undefined;
        }

        return {
          id: record.id,
          title: record.title,
          registrationState: 'ENABLED',
          temporaryRegistration: record.temporaryRegistration,
          evidence,
        };
      }),
    );
    const publicTitles = titles.filter(
      (title): title is RegisteredTitleDetail => title !== undefined,
    );

    if (publicTitles.length === 0) {
      throw new ProfessionalCredentialsNotFoundError();
    }

    return {
      professionalId,
      registeredTitles: publicTitles,
    };
  }
}
