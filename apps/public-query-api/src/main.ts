import 'reflect-metadata';

import { bootstrapHttpApplication, reportBootstrapError } from '@medicos/http';

import { PublicQueryApiModule } from './public-query-api.module';

void bootstrapHttpApplication(PublicQueryApiModule, {
  apiDocumentation: {
    description:
      'API privada, de solo lectura, del directorio médico uruguayo. Separa hechos oficiales de candidatos de investigación y conserva fuentes, fechas, decisiones y advertencias. La información puede estar desactualizada y no sustituye la verificación ante la fuente original, una consulta médica ni asesoramiento jurídico.',
    repositoryUrl: 'https://github.com/eduair94/medicos-uy',
    title: 'Directorio Médico Uruguay',
    version: '1.0.0',
  },
  ownerAuthentication: {
    basicEnabled: true,
  },
}).catch(reportBootstrapError);
