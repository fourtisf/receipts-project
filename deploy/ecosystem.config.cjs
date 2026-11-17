// PM2 process file — run from the repo root: pm2 start deploy/ecosystem.config.cjs --env production
module.exports = {
  apps: [
    {
      name: 'receipts-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '700M',
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'receipts-api',
      cwd: './apps/api',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '500M',
      env_production: { NODE_ENV: 'production', API_PORT: 4000 },
    },
    {
      name: 'receipts-worker',
      cwd: './apps/worker',
      script: 'dist/index.js',
      instances: 1, // exactly one: nonce managers and the executor must not run twice
      exec_mode: 'fork',
      max_memory_restart: '600M',
      kill_timeout: 15000, // let in-flight txs finish
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
