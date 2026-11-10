/**
 * SRT -> FCPXML caption/title conversion.
 * Parses SRT (and basic VTT) into timed text, laid as Basic Text titles on lane 1,
 * snapped to project fps so the DTD stays happy.
 */
import { t, fromSeconds, secs, type Time } from "../time.js";
import type { CaptionInfo } from "../fcpxml/parse.js";

export interface SrtCue {
  index: number;
  start: number; // seconds
  end: number;
  text: string;
}

function tsToSeconds(ts: string): number {
  // "00:01:02,500" (SRT) or "00:01:02.500" (VTT)
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts.trim());
  if (!m) throw new Error(`bad timestamp "${ts}" — expected HH:MM:SS,mmm`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]!.padEnd(3, "0")}`);
}

export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = content.replace(/\r\n/g, "\n").replace(/^WEBVTT.*\n/, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    const tsLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (tsLineIdx === -1) continue;
    const [a, b] = lines[tsLineIdx]!.split("-->");
    const text = lines.slice(tsLineIdx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    cues.push({
      index: cues.length + 1,
      start: tsToSeconds(a!),
      end: tsToSeconds(b!.trim().split(/\s+/)[0]!),
      text,
    });
  }
  if (!cues.length) throw new Error("no cues found — is this an SRT/VTT file with timed text?");
  return cues;
}

export function cuesToCaptions(cues: SrtCue[], fps: number): CaptionInfo[] {
  return cues.map((c) => ({
    start: fromSeconds(c.start, fps),
    end: fromSeconds(c.end, fps),
    text: c.text,
  }));
}

/**
 * Word-timed captions (karaoke style input): one cue per N words.
 * Input: cues with text; we re-chunk by words with even time distribution
 * across each cue — honest simplification until word-level timings are supplied.
 */
export function chunkCuesByWords(cues: SrtCue[], wordsPerChunk = 4): SrtCue[] {
  const out: SrtCue[] = [];
  for (const c of cues) {
    const words = c.text.split(/\s+/);
    const span = c.end - c.start;
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const chunk = words.slice(i, i + wordsPerChunk);
      const frac0 = i / words.length, frac1 = Math.min(1, (i + chunk.length) / words.length);
      out.push({
        index: out.length + 1,
        start: c.start + span * frac0,
        end: c.start + span * frac1,
        text: chunk.join(" "),
      });
    }
  }
  return out;
}

/** Flash-frame / micro-glitch finder over a laid-out spine. */
export interface GlitchReport {
  microClips: { index: number; name?: string; durationSecs: number; atSecs: number }[];
  gaps: { atSecs: number; durationSecs: number }[];
  overlaps: { atSecs: number; durationSecs: number }[];
}

export function findGlitches(
  clips: { offset: Time | null; duration: Time; kind: string; name?: string }[],
  minKeepSecs = 5 / 30, // default: anything under ~5 frames at 30fps
): GlitchReport {
  const real = clips
    .filter((c) => c.kind !== "gap" && c.offset !== null)
    .sort((a, b) => secs(a.offset!) - secs(b.offset!));
  const microClips = real
    .map((c, i) => ({
      index: i,
      name: c.name,
      durationSecs: secs(c.duration),
      atSecs: secs(c.offset!),
    }))
    .filter((c) => c.durationSecs < minKeepSecs);
  const gaps: { atSecs: number; durationSecs: number }[] = [];
  const overlaps: { atSecs: number; durationSecs: number }[] = [];
  for (let i = 1; i < real.length; i++) {
    const prevEnd = secs(real[i - 1]!.offset!) + secs(real[i - 1]!.duration);
    const here = secs(real[i]!.offset!);
    const d = here - prevEnd;
    if (Math.abs(d) > 1e-6) {
      if (d > 0) gaps.push({ atSecs: prevEnd, durationSecs: d });
      else overlaps.push({ atSecs: here, durationSecs: -d });
    }
  }
  return { microClips, gaps, overlaps };
}

// t() used indirectly via fromSeconds; keep the import referenced for future in-point math
void t;
