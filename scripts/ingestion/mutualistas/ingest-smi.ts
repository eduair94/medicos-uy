import { runCaadCli, SMI_SOURCE } from './caad-public-schedule';

void runCaadCli(SMI_SOURCE).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
