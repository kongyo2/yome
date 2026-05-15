import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/_/": process.env["YOME_DEV_BACKEND"] ?? "http://localhost:16275",
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/utils/**", "src/hooks/**", "src/components/**"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
