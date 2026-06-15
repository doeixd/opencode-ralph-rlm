import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  appType: "custom",
  plugins: [nitro()],
});