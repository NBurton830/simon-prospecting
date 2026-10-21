import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // PGlite boots a WASM Postgres per test file; give integration suites room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
