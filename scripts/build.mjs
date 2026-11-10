/**
 * Build script: transpile all src .ts files to dist .js (strips types, keeps ESM).
 * Import specifiers in our source already use ".js" endings, so output tree
 * resolves directly under Node. No bundling: keeps debugging and dependency
 * semantics identical to source.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const srcDir = join(root, "src");
const distDir = join(root, "dist");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const entries = walk(srcDir);
await build({
  entryPoints: entries,
  outdir: distDir,
  outbase: srcDir,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: false,
  logLevel: "warning",
});
console.log(`built ${entries.length} modules -> dist/`);
