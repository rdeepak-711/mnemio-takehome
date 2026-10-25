import type { NextConfig } from 'next';

// pg stays a plain Node require on the server instead of being bundled (D56). Next's TypeScript check stays on.
const nextConfig: NextConfig = {
  serverExternalPackages: ['pg'],
};

export default nextConfig;
