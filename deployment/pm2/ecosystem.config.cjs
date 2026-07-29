const applicationDirectory = process.env.MEDICOS_APP_DIRECTORY || '/srv/medicos-backend/current';
const environmentFile =
  process.env.MEDICOS_ANALYSIS_ENV_FILE || '/etc/medicos-backend/private-analysis.env';
const publicQueryEnvironmentFile =
  process.env.MEDICOS_PUBLIC_QUERY_ENV_FILE || '/etc/medicos-backend/public-query-api.env';

module.exports = {
  apps: [
    {
      name: 'medicos-public-query-api',
      cwd: applicationDirectory,
      script: 'deployment/pm2/run-public-query-api.sh',
      interpreter: '/bin/sh',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: 10000,
      max_memory_restart: '512M',
      kill_timeout: 30000,
      time: true,
      merge_logs: true,
      out_file: '/var/log/medicos-backend/public-query-api.out.log',
      error_file: '/var/log/medicos-backend/public-query-api.error.log',
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
        MEDICOS_PUBLIC_QUERY_ENV_FILE: publicQueryEnvironmentFile,
      },
    },
    {
      name: 'medicos-private-analysis',
      cwd: applicationDirectory,
      script: 'deployment/pm2/run-private-analysis-scheduler.sh',
      interpreter: '/bin/sh',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      min_uptime: 10000,

      // Server 104 and its PM2 daemon use UTC. This is 03:37 America/Montevideo (UTC-03:00).
      cron_restart: '37 6 * * *',

      max_memory_restart: '1536M',
      kill_timeout: 120000,
      time: true,
      merge_logs: true,
      out_file: '/var/log/medicos-backend/private-analysis.out.log',
      error_file: '/var/log/medicos-backend/private-analysis.error.log',

      // Only non-secret process controls belong here. The root-owned file is validated and sourced
      // by the scheduler; database credentials and HMAC material never enter the ecosystem file.
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
        MEDICOS_ANALYSIS_ENV_FILE: environmentFile,
      },
    },
  ],
};
