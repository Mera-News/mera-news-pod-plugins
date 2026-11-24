// A static export: the web plugin serves these files itself, and no Next.js server runs.
/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  // The same files from every build: the plugin folder commits them and a test compares a fresh build.
  generateBuildId: async () => 'web',
  // No instruction files for coding tools in this repository.
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
};
