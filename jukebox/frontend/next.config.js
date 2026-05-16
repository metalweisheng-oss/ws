/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output is only needed for Docker; Vercel handles output itself
  ...(process.env.DOCKER_BUILD === '1' && { output: 'standalone' }),
  images: {
    domains: ['i.ytimg.com'],
  },
};

module.exports = nextConfig;
