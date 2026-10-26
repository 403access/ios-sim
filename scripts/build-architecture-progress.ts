/**
 * Render docs-site/static/architecture-progress.html from the data module.
 *
 * Usage: bun scripts/build-architecture-progress.ts [output]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { architecture, renderArchitecture } from "./architecture-progress.js";

const output =
  process.argv[2] ?? join(import.meta.dirname, "../docs-site/static/architecture-progress.html");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, renderArchitecture(architecture));
console.log(`wrote ${output}`);
