import 'reflect-metadata';

import { bootstrapHttpApplication, reportBootstrapError } from '@medicos/http';

import { PublicQueryApiModule } from './public-query-api.module';

void bootstrapHttpApplication(PublicQueryApiModule, {
  apiDocumentation: {
    description:
      'API pública, de solo lectura, del directorio médico uruguayo. Cada dato publicado debe conservar evidencia y procedencia aprobadas. La información puede estar desactualizada y no sustituye la verificación ante la fuente oficial, una consulta médica ni asesoramiento jurídico.',
    repositoryUrl: 'https://github.com/eduair94/medicos-uy',
    title: 'Directorio Médico Uruguay',
    version: '1.0.0',
  },
}).catch(reportBootstrapError);
