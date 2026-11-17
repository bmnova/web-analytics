import { defineConfig } from "tsup";

const common = {
  format: ["esm"] as const,
  dts: true,
  sourcemap: true,
  target: "es2022",
  external: ["next", "next/server", "react", "react/jsx-runtime", "@bmnova/web-analytics/client"],
};

export default defineConfig([
  {
    ...common,
    entry: {
      "client/index": "src/client/index.ts",
      "server/index": "src/server/index.ts",
      "shared/index": "src/shared/index.ts",
    },
  },
  {
    // React components run in the browser; the directive must survive bundling.
    ...common,
    entry: { "react/index": "src/react/index.ts" },
    banner: { js: '"use client";' },
  },
]);
