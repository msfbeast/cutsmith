/**
 * End-to-end smoke: spawn the MCP server over stdio, drive it with raw JSON-RPC,
 * and verify a real edit flow: assemble -> re-analyze -> QC -> audio measure.
 * Exits non-zero on any failure. Run: node test/smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, closeSync, existsSync } from "node:fs";
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
const expected = ["analyze_timeline", "detect_glitches", "analyze_silence", "assemble_rough_cut", "measure_loudness", "convert_srt_to_captions", "check_fcp_available", "import_xml_into_fcp", "export_project_xml", "validate_dtd", "remove_silences", "fix_glitches", "plan_ducking"];
check("all 13 tools registered", expected.every((e) => names.includes(e)), names.join(", "));

/* 3. analyze the shipped fixture (paginated) */
const fixture = join(root, "test", "fixtures", "sample.fcpxml");
const analysis = text(await request("tools/call", { name: "analyze_timeline", arguments: { fcpxmlPath: fixture, page: 1, pageSize: 2 } }));
const sp = analysis.summary.spine;
check("analyze_timeline paginates spine", analysis.ok === true && sp.total === 5 && sp.items.length === 2 && sp.hasMore === true,
  `page1: ${sp.items.length}/${sp.total} clips, nextPage=${sp.nextPage}`);

/* 4. glitch QC on the fixture (has a planted 2-frame flash + 4s gap) */
const glitch = text(await request("tools/call", { name: "detect_glitches", arguments: { fcpxmlPath: fixture, minFrames: 5 } }));
check("detect_glitches finds 1 glitch + 1 gap", glitch.ok === true && glitch.microClips.items.length === 1 && glitch.gaps.length === 1,
  `glitches=${glitch.microClips.items.length} gaps=${glitch.gaps.length}`);

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
const spine = re.summary?.spine?.items ?? [];
const durOk = spine[0]?.duration === "15s" && spine[0]?.start === "23/2s" && spine[0]?.offset === "0s";
check("generated FCPXML round-trips through analyzer", re.ok === true && re.summary?.spine?.total === 3 && durOk,
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

/* 8. remove_silences — one-call pipeline on the tone file (4s tone + 2s silence) */
const silOut = join(work, "silenceremoved.fcpxml");
try {
  const rs = text(await request("tools/call", {
    name: "remove_silences",
    arguments: { mediaPath: wav, outputPath: silOut, fps: 30, normalize: true, minSilenceSecs: 0.5 },
  }));
  check("remove_silences builds cut in one call", rs.ok === true && rs.silenceRemovedSecs > 1.5 && rs.timelineDurationSecs < 5,
    `source 6s -> ${rs.timelineDurationSecs}s kept over ${rs.keptRegions} regions, gain x${rs.gainApplied}`);
} catch (err) { check("remove_silences", false, (err).message.slice(0, 100)); }

/* 9. fix_glitches — drop the planted flash clip from the fixture */
const fixed = join(work, "fixed.fcpxml");
try {
  const fg = text(await request("tools/call", {
    name: "fix_glitches",
    arguments: { fcpxmlPath: fixture, outputPath: fixed, strategy: "drop", minFrames: 5 },
  }));
  const reFix = text(await request("tools/call", { name: "detect_glitches", arguments: { fcpxmlPath: fixed, minFrames: 5 } }));
  check("fix_glitches removes flash clip", fg.ok === true && reFix.ok === true && reFix.microClips.items.length === 0,
    `before ${fg.clipsBefore} clips -> after ${fg.clipsAfter}, re-scan glitches=${reFix.microClips.items.length}`);
} catch (err) { check("fix_glitches", false, (err).message.slice(0, 100)); }

/* 10. plan_ducking — voice tone (0-4s speech) over 6s music */
try {
  const duck = text(await request("tools/call", {
    name: "plan_ducking",
    arguments: { voiceMediaPath: wav, musicDurationSecs: 6, duckVolume: 0.25 },
  }));
  const speechRegions = duck.musicRegions.filter((r) => r.volume === 0.25);
  const fullRegions = duck.musicRegions.filter((r) => r.volume === 1);
  check("plan_ducking ducks under speech only", duck.ok === true && duck.musicRegions.length >= 2
    && speechRegions.some((r) => r.inSecs < 3) && fullRegions.some((r) => r.inSecs >= 3.8),
    `${duck.speechSpanCount} speech span(s) -> ${duck.musicRegions.length} music regions`);
} catch (err) { check("plan_ducking", false, (err).message.slice(0, 100)); }

/* 11. DTD validation — only when an FCPXML DTD is available (FCP install or CUTSMITH_DTD) */
const dtdPath = process.env.CUTSMITH_DTD
  ?? "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_14.dtd";
if (existsSync(dtdPath)) {
  const { spawnFile } = await import("../dist/proc.js");
  try {
    await spawnFile("xmllint", ["--noout", "--dtdvalid", dtdPath, fixed], 30_000);
    check("DTD: fix_glitches output is Apple-DTD valid", true, dtdPath.split("/").pop());
  } catch (err) { check("DTD: fix_glitches output", false, (err).message.slice(0, 160)); }
} else {
  console.log("SKIP  DTD validation (no DTD on this machine — set CUTSMITH_DTD or install FCP)");
}

child.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
process.exit(failed.length ? 1 : 0);