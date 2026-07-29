import 'reflect-metadata';

import { bootstrapHttpApplication, reportBootstrapError } from '@medicos/http';

import { CommandApiModule } from './command-api.module';

void bootstrapHttpApplication(CommandApiModule, {
  apiDocumentation: {
    enabled: false,
  },
  ownerAuthentication: {
    basicEnabled: false,
  },
}).catch(reportBootstrapError);
