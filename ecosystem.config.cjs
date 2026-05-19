module.exports = {
  apps: [
    {
      name: 'outlook-fetcher',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3000,
      },
    },
  ],
};
