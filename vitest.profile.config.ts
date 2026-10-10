import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/rendering.profile.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
