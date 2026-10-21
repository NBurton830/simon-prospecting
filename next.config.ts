import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (local database mode) ships WASM and must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
