module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: './backend',
      script: 'index.js',
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
    },
    {
      name: 'frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/vite',
      args: '--host',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
