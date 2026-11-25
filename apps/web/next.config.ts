import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repository root: the web app reads `@hippidy/contracts` from the pnpm workspace.
const root = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ]);
  },
};

export default config;
