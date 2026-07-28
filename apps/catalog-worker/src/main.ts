import 'reflect-metadata';

import { bootstrapWorkerApplication, reportWorkerBootstrapError } from '@medicos/worker';

import { CatalogWorkerModule } from './catalog-worker.module';

void bootstrapWorkerApplication(CatalogWorkerModule).catch(reportWorkerBootstrapError);
