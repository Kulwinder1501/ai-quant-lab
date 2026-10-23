/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // next dev otherwise writes AGENTS.md / CLAUDE.md into the web package on every start;
  // those untracked files would be baked into Docker builds. Keep the tree clean.
  agentRules: false,
};
export default nextConfig;
