import type { NextConfig } from "next";

// Only Lodestar itself and the launcher site may show Lodestar inside a frame,
// so no other page can load it invisibly and trick a click on Approve.
// LODESTAR_FRAME_ANCESTORS adds more origins, space-separated.
const frameAncestors = ["'self'", "https://bollineni-create.vercel.app", process.env.LODESTAR_FRAME_ANCESTORS]
  .filter(Boolean)
  .join(" ");

const nextConfig: NextConfig = {
  // Native module and font files are loaded from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}` },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
