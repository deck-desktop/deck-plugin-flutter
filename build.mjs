// Build the flutter plugin.
//
//   node plugins/flutter/build.mjs
//
// Everything happens in the shared builder; see plugins/build-plugin.mjs.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../build-plugin.mjs";

await buildPlugin(dirname(fileURLToPath(import.meta.url)));
