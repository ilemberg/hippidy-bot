import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages export their TypeScript source under the "source" condition.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
  },
});
