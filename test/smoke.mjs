/**
 * End-to-end smoke: spawn the MCP server over stdio, drive it with raw JSON-RPC,
 * and verify a real edit flow: assemble -> re-analyze -> QC -> audio measure.
 * Exits non-zero on any failure. Run: node test/smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "cutsmith-smoke-"));

let nextId = 1;
const child = spawn("node", [join(root, "dist", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  return new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => rej(new Error(`timeout on ${method}`)), 60_000);
    const onLine = (buf) => {
      for (const line of buf.toString().split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) {
          clearTimeout(timer);
          child.stdout.off("data", onLine);
          if (msg.error) rej(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          else res(msg.result);
        }
      }
    };
    const prev = child.stdout.listeners("data");
    child.stdout.on("data", onLine);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function text(result) {
  return JSON.parse(result.content[0].text);
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/* 1. MCP handshake */
const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.1" },
});
check("server initializes", init.serverInfo?.name === "cutsmith", `v${init.serverInfo?.version}`);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

/* 2. tool discovery */
const tools = await request("tools/list", {});
const names = tools.tools.map((t) => t.name);
const expected = ["analyze_timeline", "detect_glitches", "analyze_silence", "assemble_rough_cut", "measure_loudness", "convert_srt_to_captions", "check_fcp_available", "import_xml_into_fcp", "export_project_xml"];
check("all 9 tools registered", expected.every((e) => names.includes(e)), names.join(", "));

/* 3. analyze the shipped fixture */
const fixture = join(root, "test", "fixtures", "sample.fcpxml");
const analysis = text(await request("tools/call", { name: "analyze_timeline", arguments: { fcpxmlPath: fixture } }));
check("analyze_timeline reads fixture spine", analysis.ok === true && analysis.summary.spine.length === 5,
  `${analysis.summary?.projects?.[0]?.project}: ${analysis.summary?.spine?.length} clips @ ${analysis.summary?.resolution?.fps}fps`);

/* 4. glitch QC on the fixture (has a planted 2-frame flash + 4s gap) */
const glitch = text(await request("tools/call", { name: "detect_glitches", arguments: { fcpxmlPath: fixture, minFrames: 5 } }));
check("detect_glitches finds 1 glitch + 1 gap", glitch.ok === true && glitch.microClips.length === 1 && glitch.gaps.length === 1,
  `glitches=${glitch.microClips.length} gaps=${glitch.gaps.length}`);

/* 5. assemble a real rough cut (dummy media files, no normalize) */
const a1 = join(work, "camA.mov"), a2 = join(work, "camB.mov");
touchSyncFix(a1); touchSyncFix(a2);
function touchSyncFix(p) { closeSync(openSync(p, "w")); }
const outPath = join(work, "roughcut.fcpxml");
const asm = text(await request("tools/call", {
  name: "assemble_rough_cut",
  arguments: {
    outputPath: outPath,
    eventName: "Smoke Event",
    projectName: "Smoke Cut",
    fps: 30,
    assets: [
      { id: "cam1", name: "Cam 1", path: a1, durationSecs: 600, syncOffsetSecs: 1.5, normalize: false },
      { id: "broll", name: "B-roll", path: a2, durationSecs: 120, syncOffsetSecs: 0, normalize: false },
    ],
    keptRegions: [
      { assetId: "cam1", inSecs: 10, outSecs: 25 },
      { assetId: "broll", inSecs: 5, outSecs: 23 },
 { assetId: "cam1", inSecs: 40, outSecs: 52 },
    ],
  },
}));
check("assemble_rough_cut writes timeline", asm.ok === true && asm.clips === 3,
  `${asm.timelineDurationSecs}s across ${asm.clips} clips`);

/* 6. read the generated file back through the analyzer and verify the edit survived.
 * Clip 1: in 10s + sync offset 1.5s => source in-point 11.5s = "23/2s", duration 15s. */
const re = text(await request("tools/call", { name: "analyze_timeline", arguments: { fcpxmlPath: outPath } }));
const spine = re.summary?.spine ?? [];
const durOk = spine[0]?.duration === "15s" && spine[0]?.start === "23/2s" && spine[0]?.offset === "0s";
check("generated FCPXML round-trips through analyzer", re.ok === true && spine.length === 3 && durOk,
  `first clip: offset=${spine[0]?.offset} start=${spine[0]?.start} dur=${spine[0]?.duration}`);

/* 7. ffmpeg audio smoke — generate a tone file, analyze silence + loudness */
const { spawnFile } = await import("../dist/proc.js");
const wav = join(work, "tone.wav");
try {
  await spawnFile("ffmpeg", ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]", "-map", "[out]", wav]);
  const sil = text(await request("tools/call", { name: "analyze_silence", arguments: { mediaPath: wav, minDuration: 0.5 } }));
  check("analyze_silence finds the 2s silent tail", sil.ok === true && sil.totalSilenceSecs > 1.8,
    `${sil.segmentCount} segment(s), total ${sil.totalSilenceSecs}s`);
  const loud = text(await request("tools/call", { name: "measure_loudness", arguments: { mediaPath: wav } }));
  check("measure_loudness returns LUFS", loud.ok === true && typeof loud.measured?.inputI === "number"
    && loud.measured.inputI > -70, `measured ${loud.measured?.inputI} LUFS, gain for -16: ${loud.gainMultiplier}`);
} catch (err) {
  check("ffmpeg audio analysis", false, (err).message.slice(0, 120));
}

child.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
process.exit(failed.length ? 1 : 0);
