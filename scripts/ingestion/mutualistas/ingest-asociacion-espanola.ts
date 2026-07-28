import { ASOCIACION_ESPANOLA_SOURCE, runCaadCli } from './caad-public-schedule';

void runCaadCli(ASOCIACION_ESPANOLA_SOURCE).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
