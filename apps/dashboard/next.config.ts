import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard only imports *types* from @radar/core; transpile it anyway
  // so that shared constants can be used safely.
  transpilePackages: ["@radar/core"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
