import { defineConfig } from "vitest/config";

process.env["MO_LOG_SILENT"] = "1";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
