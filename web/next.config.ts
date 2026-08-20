import type { NextConfig } from "next";

/**
 * Nothing exotic. The app is a single client-rendered page that talks to the chain
 * through wagmi, so there is no server runtime to configure.
 */
const config: NextConfig = {
  reactStrictMode: true,
};

export default config;
