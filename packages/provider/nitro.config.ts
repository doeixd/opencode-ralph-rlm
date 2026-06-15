import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  srcDir: "./server",
  devServer: {
    port: Number(process.env.RALPH_PROVIDER_PORT ?? 8787),
    hostname: process.env.RALPH_PROVIDER_HOST ?? "127.0.0.1",
  },
  experimental: {
    openAPI: true,
  },
  openAPI: {
    meta: {
      title: "Ralph RLM Provider",
      description: "Supervisor provider and loop management API",
      version: "0.2.0",
    },
    production: "runtime",
  },
  runtimeConfig: {
    opencodeBaseUrl: process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
  },
});