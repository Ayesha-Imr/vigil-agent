import { defineConfig } from "vitest/config";

// Only vigil's own tests: the vendored skills under skills/ carry tests of their own.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
