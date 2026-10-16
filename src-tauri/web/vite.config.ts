import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/",
  plugins: [react(),{
    name:"local-markdown-renderer-url",
    resolveId(id){if(id==="virtual:markdown-renderer-url")return "\0markdown-renderer-url";},
    load(id){if(id!=="\0markdown-renderer-url")return; if(this.meta.watchMode)return 'export default "/src/conversation/markdown-renderer.tsx"';const ref=this.emitFile({type:"chunk",id:new URL("./src/conversation/markdown-renderer.tsx",import.meta.url).pathname,name:"markdown-renderer",preserveSignature:"strict"});return `export default import.meta.ROLLUP_FILE_URL_${ref}`;},
  }],
  build: {
    outDir: new URL("./dist", import.meta.url).pathname,
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
