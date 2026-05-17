import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built bundle loads under Electron's file:// origin.
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
});
