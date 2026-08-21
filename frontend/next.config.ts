import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // 本地分离端口开发用 127.0.0.1:3000 访问时，dev server 默认只放行 localhost 系来源，
  // 会 403 拦截 /_next/* 资源与 HMR websocket，页面卡白屏。显式放行 127.0.0.1。
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // The Fragment-ref scroll handler in Next 16.3 Preview can crash during
    // consecutive client redirects. Keep the stable handler until upstream fixes it.
    appNewScrollHandler: false,
    useTypeScriptCli: true,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
