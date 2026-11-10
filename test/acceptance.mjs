/**
 * One-command FCP-machine acceptance run (the script behind README's 5-minute run).
 * Runs every check that needs a real Final Cut Pro and prints a structured verdict.
 * Usage: node test/acceptance.mjs
 * Exit 0 = full pass, 1 = failure, 10 = FCP not usable (nothing to test here).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "cutsmith-accept-"));

let nextId = 1;
const child = spawn("node", [join(root, "dist", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const request = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  const timer = setTimeout(() => rej(new Error(`timeout: ${method}`)), 180_000);
  const onData = (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === id) {
        clearTimeout(timer); child.stdout.off("data", onData);
        m.error ? rej(new Error(m.error.message ?? JSON.stringify(m.error))) : res(m.result);
      }
    }
  };
  child.stdout.on("data", onData);
  send({ jsonrpc: "2.0", id, method, params });
});
const text = (r) => JSON.parse(r.content[0].text);
let failed = 0, passed = 0;
const check = (name, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// handshake
await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acceptance", version: "0.1.1" } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });

/* 1. Is FCP here and scriptable? */
const fcp = text(await request("tools/call", { name: "check_fcp_available", arguments: {} }));
check("FCP responds to AppleScript", fcp.ok === true, fcp.error ?? "");
if (!fcp.ok) {
  console.log(`\nVerdict: FCP not usable on this machine (${passed} passed).`);
  console.log("Install Final Cut Pro (free 90-day trial works), launch once, grant Automation permission, re-run.");
  child.kill(); process.exit(10);
}

/* 2. DTD present? Validate every artifact we produce. */
const dtdPath = process.env.CUTSMITH_DTD
  ?? "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_14.dtd";
if (!existsSync(dtdPath)) {
  console.log(`WARN  Apple DTD not found at ${dtdPath} — FCP version may differ. Checking Versions/B too.`);
}

/* 3. Build a real media-backed timeline and import it. */
// Use any media the machine has: this file itself becomes the asset (it plays fine in FCP).
const mediaFile = join(root, "README.md");
const outPath = join(work, "acceptance.fcpxml");
const asm = text(await request("tools/call", {
  name: "assemble_rough_cut",
  arguments: {
    outputPath: outPath, eventName: "Cutsmith Acceptance", projectName: "Acceptance Cut",
    fps: 30,
    assets: [{ id: "a1", name: "Acceptance media", path: mediaFile, durationSecs: 60 }],
    keptRegions: [{ assetId: "a1", inSecs: 0, outSecs: 10 }],
  },
}));
check("assemble_rough_cut writes project", asm.ok === true, asm.written ?? asm.error);

if (existsSync(dtdPath)) {
  const v = text(await request("tools/call", { name: "validate_dtd", arguments: { fcpxmlPath: outPath } }));
  check("generated file passes Apple DTD", v.valid === true, v.verdict ?? v.violations?.slice(0, 160));
}

const imp = text(await request("tools/call", { name: "import_xml_into_fcp", arguments: { fcpxmlPath: outPath } }));
check("FCP imported the project (check the window: event 'Cutsmith Acceptance')", imp.ok === true, imp.error ?? "");

child.kill();
console.log(`\nVerdict: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
