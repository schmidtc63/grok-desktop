import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "grok-file-page",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
        },
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
