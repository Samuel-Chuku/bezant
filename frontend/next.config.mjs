/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Silence harmless transient-dep warnings from the wagmi/RainbowKit stack.
    // - @react-native-async-storage/async-storage: pulled in by @metamask/sdk for React Native; unused on web.
    // - pino-pretty: optional dev-only pretty-printer for pino; pino falls back gracefully.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,
    };
    config.externals = [...(config.externals ?? []), 'pino-pretty'];
    return config;
  },
};

export default nextConfig;
