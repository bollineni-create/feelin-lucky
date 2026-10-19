import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module and font files are loaded from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
