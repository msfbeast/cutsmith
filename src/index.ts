/**
 * cutsmith — workflow-level MCP server for Final Cut Pro.
 *
 * Tools operate on FCPXML documents and media files; roundtripping into/out of
 * the FCP app itself is exposed as best-effort AppleScript helpers marked
 * "requires Final Cut Pro running on this Mac".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { parseTime, timeStr, t, secs, add, fromSeconds, frameDuration } from "./time.js";
import { parseFcpXml, summarize } from "./fcpxml/parse.js";
import { buildFcpXml, type AssembleClip, type AssembleAsset } from "./fcpxml/write.js";
import { findGlitches, parseSrt, cuesToCaptions, chunkCuesByWords } from "./workflow/captions.js";
import { detectSilences, measureLoudness, gainForTarget, keptRegionsFromSilences } from "./workflow/audio.js";

const server = new McpServer({ name: "cutsmith", version: "0.1.0" });

/** Run an AppleScript osascript snippet; only succeeds when FCP is running on this Mac. */
function osascript(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((res, rej) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr.trim() || err.message));
      else res(stdout.trim());
    });
  });
}

function out(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const zTime = z.string().describe('Rational time, FCPXML style: "150/30s" or "150s" (seconds)');

/* ------------------------------------------------------------------ */
/* Tool: analyze_timeline — read an FCPXML and return an LLM summary   */
/* ------------------------------------------------------------------ */
server.tool(
  "analyze_timeline",
  `Parse a Final Cut Pro FCPXML file and return a compact timeline summary: resolution, fps, project duration, every spine clip (kind, name, offset, in-point, duration, lane), markers and caption counts. Use this FIRST to understand any timeline before editing it.`,
  { fcpxmlPath: z.string().describe("Path to the .fcpxml file") },
  async ({ fcpxmlPath }) => {
    try {
      const model = parseFcpXml(readFileSync(resolve(fcpxmlPath), "utf8"));
      return out({ ok: true, summary: summarize(model) });
    } catch (err) {
      return out({ ok: false, error: `Could not parse "${fcpxmlPath}": ${(err as Error).message}. Is it an FCPXML export from Final Cut Pro (File > Export XML)?` });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: detect_glitches — find micro-clips, gaps, overlaps            */
/* ------------------------------------------------------------------ */
server.tool(
  "detect_glitches",
  `Scan a parsed timeline for edit artifacts: micro-clip glitches (clips shorter than minFrames, the "few frames long" flash cuts silence-removal leaves behind), unintended gaps (black frames), and overlaps. Returns artifacts with exact timecodes; feed them to apply_edits or fix manually.`,
  {
    fcpxmlPath: z.string(),
    minFrames: z.number().int().min(1).max(120).default(5).describe("Clips shorter than this many frames are flagged as glitches"),
  },
  async ({ fcpxmlPath, minFrames }) => {
    try {
      const model = parseFcpXml(readFileSync(resolve(fcpxmlPath), "utf8"));
      const project = model.events.flatMap((e) => e.projects)[0];
      if (!project) return out({ ok: false, error: "No project found in this FCPXML. Export a project (not just a library) from FCP." });
      const fmt = model.formats.find((f) => f.id === project.formatId) ?? model.formats[0];
      const frameSecs = fmt?.frameDuration ? 1 / (fmt.fps ?? 30) : 1 / 30;
      const report = findGlitches(project.spine, minFrames * frameSecs);
      return out({
        ok: true,
        glitchCount: report.microClips.length + report.gaps.length + report.overlaps.length,
        ...report,
      });
    } catch (err) {
      return out({ ok: false, error: (err as Error).message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: analyze_silence — ffmpeg silencedetect on a media file        */
/* ------------------------------------------------------------------ */
server.tool(
  "analyze_silence",
  `Detect silence regions in a media file using ffmpeg silencedetect. Returns segment timecodes in source seconds plus total silence — the raw material for a silence-removed rough cut.`,
  {
    mediaPath: z.string(),
    noise: z.string().default("-30dB").describe("Silence threshold, e.g. -30dB (raise for loud rooms: -25dB)"),
    minDuration: z.number().min(0.05).max(30).default(0.5),
  },
  async ({ mediaPath, noise, minDuration }) => {
    try {
      const report = await detectSilences(resolve(mediaPath), { noise, minDuration });
      return out({
        ok: true,
        totalSilenceSecs: Math.round(report.totalSilence * 100) / 100,
        segmentCount: report.segments.length,
        segments: report.segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
      });
    } catch (err) {
      return out({ ok: false, error: (err as Error).message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: assemble_rough_cut — the core builder                          */
/* ------------------------------------------------------------------ */
server.tool(
  "assemble_rough_cut",
  `Build a new FCPXML project from a clip list and write it to disk. This is the main "edit assembly" surface: pick the source files, give kept regions (source in-points, durations), optional silence-removal from ffmpeg analysis, per-source sync offsets, gain corrections, titles and SRT captions. Output is a NEW .fcpxml file — originals are never modified. Import it into Final Cut Pro via File > Import XML (or the import_xml tool if FCP is running on this machine).`,
  {
    outputPath: z.string().describe("Where to write the new .fcpxml"),
    eventName: z.string().default("Cutsmith Import"),
    projectName: z.string().default("Rough Cut"),
    width: z.number().int().default(1920),
    height: z.number().int().default(1080),
    fps: z.number().default(30),
    assets: z.array(z.object({
      id: z.string().describe("Stable reference id you invent, e.g. cam1, cam2"),
      name: z.string().describe("Human-readable clip name"),
      path: z.string().describe("Absolute path (or file:// URL) of the media file"),
      durationSecs: z.number().positive().describe("Source duration in seconds"),
      syncOffsetSecs: z.number().default(0).describe("Source starts this many seconds LATE; positive shifts content left so all sources align (the cohost-drift fix)"),
      targetLufs: z.number().default(-16).describe("Loudness target used only when normalize=true"),
      normalize: z.boolean().default(false).describe("Measure the file's loudness with ffmpeg and set clip gain accordingly"),
    })).min(1),
    keptRegions: z.array(z.object({
      assetId: z.string(),
      inSecs: z.number().min(0).describe("Source in-point in seconds (before sync offset application)"),
      outSecs: z.number().positive().describe("Source out-point in seconds"),
    })).describe("Which source regions survive the cut, in the order they appear"),
    captionsSrtPath: z.string().optional().describe("Optional SRT/VTT; captions laid on lane 1 snapped to fps"),
    captionStyle: z.object({
      fontSize: z.number().default(63),
      wordsPerTitle: z.number().int().min(1).default(0).describe("If > 0, split cues into N-word chunks (social captions)"),
      fontColor: z.string().default("1 1 1 1"),
    }).optional(),
  },
  async (args) => {
    try {
      const fps = args.fps;
      const assets: AssembleAsset[] = [];
      const assetById = new Map<string, (typeof assets)[number] & { syncOffsetSecs: number; gain: number }>();
      for (const a of args.assets) {
        const p = resolve(a.path);
        if (!existsSync(p)) throw new Error(`media file not found: ${p}`);
        let gain = 1;
        if (a.normalize) {
          const loud = await measureLoudness(p);
          gain = gainForTarget(loud.inputI, a.targetLufs);
        }
        const asset: AssembleAsset & { syncOffsetSecs: number; gain: number } = {
          id: a.id, name: a.name, src: p, duration: fromSeconds(a.durationSecs, fps),
          syncOffsetSecs: a.syncOffsetSecs, gain,
        };
        assets.push(asset);
        assetById.set(a.id, asset);
      }
      const clips: AssembleClip[] = [];
      let cursor = 0;
      for (const r of args.keptRegions) {
        const asset = assetById.get(r.assetId);
        if (!asset) throw new Error(`keptRegions references unknown assetId "${r.assetId}" (known: ${[...assetById.keys()].join(", ")})`);
        // sync offset: positive means source starts LATE -> shift in-point right
        const inSecs = r.inSecs + asset.syncOffsetSecs;
        const dur = r.outSecs - r.inSecs;
        if (dur <= 0) throw new Error(`keptRegion for ${r.assetId}: outSecs must exceed inSecs (got ${r.inSecs}..${r.outSecs})`);
        const spliced: AssembleClip = {
          kind: "asset", ref: asset.id, name: asset.name,
          offset: fromSeconds(cursor, fps),
          start: fromSeconds(Math.max(0, inSecs), fps),
          duration: fromSeconds(dur, fps),
          audioRoles: "dialogue",
          volume: asset.gain !== 1 ? asset.gain : undefined,
        };
        clips.push(spliced);
        cursor += dur;
      }
      // captions
      if (args.captionsSrtPath) {
        const srt = parseSrt(readFileSync(resolve(args.captionsSrtPath), "utf8"));
        const chunked = args.captionStyle && args.captionStyle.wordsPerTitle > 0
          ? chunkCuesByWords(srt, args.captionStyle.wordsPerTitle) : srt;
        const caps = cuesToCaptions(chunked, fps);
        for (const c of caps) {
          clips.push({
            kind: "title", name: c.text.split("\n")[0]?.slice(0, 40) ?? "Caption",
            lane: 1, offset: c.start, duration: t(Math.max(1, Math.round(secs(c.end) * fps) - Math.round(secs(c.start) * fps)), fps),
            text: c.text,
            textStyle: {
              fontSize: args.captionStyle?.fontSize ?? 63,
              fontColor: args.captionStyle?.fontColor ?? "1 1 1 1",
            },
          });
        }
      }
      const xml = buildFcpXml({
        event: args.eventName, name: args.projectName,
        format: { id: "fx1", width: args.width, height: args.height, fps },
        clips,
      }, assets);
      const outPath = resolve(args.outputPath);
      writeFileSync(outPath, xml, "utf8");
      return out({
        ok: true,
        written: outPath,
        timelineDurationSecs: +cursor.toFixed(3),
        clips: clips.filter((c) => c.kind === "asset").length,
        captions: clips.filter((c) => c.kind === "title").length,
        gainsApplied: [...assetById.values()].filter((a) => a.gain !== 1).map((a) => ({ asset: a.id, gain: +a.gain.toFixed(3) })),
        nextStep: `Import into FCP: File > Import XML… and pick "${outPath}". Verify playback, then QC with detect_glitches.`,
      });
    } catch (err) {
      return out({ ok: false, error: `Assembly failed: ${(err as Error).message}` });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: measure_loudness + normalize plan                              */
/* ------------------------------------------------------------------ */
server.tool(
  "measure_loudness",
  `Measure integrated loudness (LUFS) and true peak of a media file with ffmpeg loudnorm, and compute the linear gain needed for a target, e.g. -16 LUFS (platform standard) — the dialable, explicit alternative to black-box audio "enhancement".`,
  { mediaPath: z.string(), targetLufs: z.number().default(-16) },
  async ({ mediaPath, targetLufs }) => {
    try {
      const loud = await measureLoudness(resolve(mediaPath));
      return out({ ok: true, measured: loud, targetLufs, gainMultiplier: +gainForTarget(loud.inputI, targetLufs).toFixed(4) });
    } catch (err) {
      return out({ ok: false, error: (err as Error).message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: convert_srt_to_captions — preview what SRT -> FCPXML will do  */
/* ------------------------------------------------------------------ */
server.tool(
  "convert_srt_to_captions",
  `Parse an SRT/VTT file and return FCPXML-ready caption timings (snapped to your project fps). Preview before assembly; the same parser backs captionsSrtPath in assemble_rough_cut.`,
  { srtPath: z.string(), fps: z.number().default(30), wordsPerTitle: z.number().int().default(0) },
  async ({ srtPath, fps, wordsPerTitle }) => {
    try {
      let cues = parseSrt(readFileSync(resolve(srtPath), "utf8"));
      if (wordsPerTitle > 0) cues = chunkCuesByWords(cues, wordsPerTitle);
      const caps = cuesToCaptions(cues, fps);
      return out({ ok: true, count: caps.length, captions: caps.slice(0, 20).map((c) => ({ start: timeStr(c.start), end: timeStr(c.end), text: c.text })), truncated: caps.length > 20 });
    } catch (err) {
      return out({ ok: false, error: (err as Error).message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* FCP roundtrip (AppleScript) — only when FCP runs on this Mac         */
/* ------------------------------------------------------------------ */
server.tool(
  "check_fcp_available",
  `Check whether Final Cut Pro is installed and scriptable on this Mac (AppleScript probe).`,
  async () => {
    try {
      const v = await osascript('tell application "Final Cut Pro" to launch\ntell application "Final Cut Pro" to play {0}/60', 10_000);
      return out({ ok: true, note: "Final Cut Pro responded to AppleScript.", detail: v });
    } catch (err) {
      return out({
        ok: false,
        error: `Final Cut Pro did not respond: ${(err as Error).message}`,
        hint: "Install Final Cut Pro 10.6+ from the Mac App Store, launch it once manually, and grant Automation permission when macOS asks.",
      });
    }
  },
);

server.tool(
  "import_xml_into_fcp",
  `Open an .fcpxml in Final Cut Pro (equivalent to double-clicking it / File > Import XML). FCP imports it as a new event named after the file. Non-destructive: it never touches existing libraries.`,
  { fcpxmlPath: z.string() },
  async ({ fcpxmlPath }) => {
    const p = resolve(fcpxmlPath);
    if (!existsSync(p)) return out({ ok: false, error: `file not found: ${p}` });
    try {
      const res = await osascript(`tell application "Final Cut Pro" to open POSIX file "${p}"`, 60_000);
      return out({ ok: true, result: res || "opened", note: "Check FCP: the timeline should now be in the import event." });
    } catch (err) {
      return out({ ok: false, error: `FCP refused the open: ${(err as Error).message}`, hint: "Make sure FCP is running and Automation permission is granted (System Settings > Privacy & Security > Automation)." });
    }
  },
);

server.tool(
  "export_project_xml",
  `Ask Final Cut Pro to export the currently open project as FCPXML via AppleScript (equivalent of File > Export XML; FCP's dictionary is read-only, so exact export naming depends on FCP version — use GUI hand-off if this fails).`,
  { outputPath: z.string() },
  async ({ outputPath }) => {
    const p = resolve(outputPath);
    try {
      const res = await osascript(
        `tell application "Final Cut Pro"\n export front document as XML in POSIX file "${p}"\nend tell`, 120_000);
      return out({ ok: true, result: res || "export initiated", written: p, existsAlready: existsSync(p) });
    } catch (err) {
      return out({
        ok: false,
        error: `AppleScript export failed: ${(err as Error).message}`,
        fallback: "FCP versions differ in scripting dictionary. Manual path: select project, File > Export XML… then re-run analyze_timeline on the file. See README > Roundtrip.",
      });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: validate_dtd — certify a timeline against Apple's real DTD    */
/* ------------------------------------------------------------------ */
server.tool(
  "validate_dtd",
  `Validate an .fcpxml against Apple's official FCPXML DTD using xmllint. The DTD is auto-discovered inside your Final Cut Pro install (redistribution is not permitted), or set the CUTSMITH_DTD environment variable to a local copy. This is the strongest correctness check available: if a generated timeline passes this, FCP will import it.`,
  { fcpxmlPath: z.string() },
  async ({ fcpxmlPath }) => {
    const p = resolve(fcpxmlPath);
    if (!existsSync(p)) return out({ ok: false, error: `file not found: ${p}` });
    const candidates = [
      process.env.CUTSMITH_DTD,
      "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_14.dtd",
      "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/B/Resources/FCPXMLv1_14.dtd",
    ].filter((c): c is string => typeof c === "string");
    const dtd = candidates.find((c) => existsSync(c));
    if (!dtd) {
      return out({
        ok: false,
        error: "FCPXML DTD not found on this machine.",
        hint: "Install Final Cut Pro (the DTD ships inside it, not redistributable) or set CUTSMITH_DTD=/path/to/FCPXMLv1_14.dtd",
        searched: candidates,
      });
    }
    try {
      await new Promise<void>((res, rej) => {
        execFile("xmllint", ["--dtdvalid", dtd, "--noout", p], { timeout: 60_000 }, (err, _o, stderr) => {
          if (err) rej(new Error(stderr.trim().split("\n").slice(0, 8).join("\n") || err.message));
          else res();
        });
      });
      return out({ ok: true, valid: true, dtd, file: p, verdict: "Passes Apple's official FCPXML DTD — safe to import." });
    } catch (err) {
      return out({ ok: false, valid: false, dtd, file: p, violations: (err as Error).message, verdict: "DTD violations — fix before importing into Final Cut Pro." });
    }
  },
);

/* ------------------------------------------------------------------ */
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`cutsmith MCP server ready on stdio\n`);
