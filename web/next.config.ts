import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict Mode mounts twice in dev. The wallet adapter then sends a second
  // wallet_requestPermissions while the first prompt is still open, and Phantom
  // rejects it and the selected wallet is cleared.
  reactStrictMode: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // The table has buttons that move money. It must not be framed by another site.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        net: false,
        tls: false,
      };
    }
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
