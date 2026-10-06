import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApiPlugin } from "./mock-api";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/",
  plugins: [react(), demoApiPlugin()],
  build: {
    outDir: new URL("../src/web/dist", import.meta.url).pathname,
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
