import fs from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: { entry: { index: "src/index.ts" } },
    sourcemap: true,
    clean: true,
    splitting: false,
    shims: false,
    define: { __MEMENTO_VERSION__: JSON.stringify(pkg.version) },
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    splitting: false,
    shims: false,
    define: { __MEMENTO_VERSION__: JSON.stringify(pkg.version) },
    banner: { js: "#!/usr/bin/env node" },
    // The workbench UI is a static asset: the server reads `ui.html` from its
    // own directory at runtime, so it must sit next to the bundled cli.js.
    onSuccess: async () => {
      fs.copyFileSync(new URL("./src/web/ui.html", import.meta.url), new URL("./dist/ui.html", import.meta.url));
    },
  },
]);
