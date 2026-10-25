import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ios-sim/protocol": fromRoot("./packages/protocol/src/index.ts"),
      "@ios-sim/darwin-compat": fromRoot("./packages/darwin-compat/src/index.ts"),
      "@ios-sim/host": fromRoot("./apps/host/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "docs-site/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "apps/host/src/web.ts"],
    },
  },
});
