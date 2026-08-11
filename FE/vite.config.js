import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for flint3-explorer.
//
// `base` is conditional:
//   - dev server → "/" (standard, module URLs resolve correctly against localhost)
//   - production build → "./" (relative asset paths, so dist/index.html works when
//     opened directly from the filesystem OR hosted from any subdirectory)
//
// The two settings are incompatible: "./" at dev time breaks module resolution.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === "build" ? "./" : "/",
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    open: true,
  },
}));
