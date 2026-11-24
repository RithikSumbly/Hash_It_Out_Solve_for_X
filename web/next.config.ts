import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@redqueen/sdk"],
  // the relay/bots are not part of the site; only the SDK is bundled
  eslint: { ignoreDuringBuilds: true },
  // basic security headers. No content-security policy yet: the page loads WebGL, fonts, her Space and
  // several RPCs, and a strict one needs testing on every edition. The microphone stays allowed for her audience.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)" },
        ],
      },
    ];
  },
  webpack: (cfg) => {
    // wagmi's optional connectors pull these in; the arena only uses the injected (MetaMask) connector
    cfg.resolve.fallback = { ...(cfg.resolve.fallback ?? {}), "pino-pretty": false, "@react-native-async-storage/async-storage": false };
    return cfg;
  },
};

export default config;
