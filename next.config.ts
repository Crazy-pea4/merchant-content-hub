import type { NextConfig } from 'next';
const config: NextConfig = {
  output: process.env.NEXT_STANDALONE === 'true' ? 'standalone' : undefined,
  poweredByHeader: false,
  experimental: { proxyClientMaxBodySize: '130mb' },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' }
    ] }];
  }
};
export default config;
