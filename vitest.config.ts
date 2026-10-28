import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["src/tests/bulkify.test.ts"] },
      },
      {
        // Talks to a real store, see the file for setup
        test: {
          name: "store",
          include: ["src/tests/store.test.ts"],
          testTimeout: 5 * 60_000,
        },
      },
    ],
  },
});
