import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // run.test.ts talks to a real store and needs a .env
    include: ["src/tests/bulkify.test.ts"],
  },
});
