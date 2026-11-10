/**
 * ffmpeg-backed audio analysis: silence detection and loudness measurement.
 * Both shells out to ffmpeg (macOS homebrew standard); errors surfaced with
 * actionable messages because MCP tool results are what the LLM sees.
 */
import { spawnFile } from "../proc.js";
import { fromSeconds, secs, type Time } from "../time.js";

export interface SilenceSegment {
  start: number; // seconds
  end: number;
  duration: number;
}

export interface SilenceReport {
  segments: SilenceSegment[];
  totalSilence: number; // seconds
  detection: { noise: string; minDuration: number };
}

export async function detectSilences(
  mediaPath: string,
  opts: { noise?: string; minDuration?: number } = {},
): Promise<SilenceReport> {
  const noise = opts.noise ?? "-30dB";
  const minDuration = opts.minDuration ?? 0.5;
  try {
    const { stderr } = await spawnFile("ffmpeg", [
      "-hide_banner", "-nostats", "-i", mediaPath,
      "-af", `silencedetect=noise=${noise}:d=${minDuration}`,
      "-f", "null", "-",
    ]);
    const segments: SilenceSegment[] = [];
    let pendingStart: number | null = null;
    for (const line of stderr.split("\n")) {
      const startM = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (startM) { pendingStart = parseFloat(startM[1]!); continue; }
      const endM = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
      if (endM && pendingStart !== null) {
        const start = Math.max(0, pendingStart);
        const end = parseFloat(endM[1]!);
        segments.push({ start, end, duration: end - start });
        pendingStart = null;
      }
    }
    const totalSilence = segments.reduce((acc, s) => acc + s.duration, 0);
    return { segments, totalSilence, detection: { noise, minDuration } };
  } catch (err) {
    throw new Error(
      `ffmpeg silencedetect failed on "${mediaPath}": ${(err as Error).message}. ` +
      `Check that the file exists and contains an audio stream (ffmpeg -i "${mediaPath}").`);
  }
}

export interface LoudnessReport {
  inputI: number;   // integrated loudness LUFS
  inputTp: number;  // true peak dBTP
  inputLra: number; // loudness range
  inputThresh: number;
}

export async function measureLoudness(mediaPath: string): Promise<LoudnessReport> {
  try {
    const { stderr } = await spawnFile("ffmpeg", [
      "-hide_banner", "-nostats", "-i", mediaPath,
      "-af", "loudnorm=print_format=json", "-f", "null", "-",
    ]);
    const m = stderr.match(/\{[\s\S]*\}/); // loudnorm prints one JSON block
    if (!m) throw new Error("loudnorm produced no JSON (media may have no audio stream)");
    const j = JSON.parse(m[0]) as Record<string, string>;
    return {
      inputI: parseFloat(j.input_i ?? "-70"),
      inputTp: parseFloat(j.input_tp ?? "-70"),
      inputLra: parseFloat(j.input_lra ?? "0"),
      inputThresh: parseFloat(j.input_thresh ?? "-70"),
    };
  } catch (err) {
    throw new Error(
      `ffmpeg loudnorm failed on "${mediaPath}": ${(err as Error).message}. ` +
      `Loudness measurement needs an audio stream.`);
  }
}

/**
 * Gain (multiplier) needed to move a clip from measured LUFS to a target LUFS.
 * Linear gain = 10^((target - measured)/20). FCPXML <adjust-volume amount> is
 * a linear multiplier, so this maps cleanly onto the generator.
 */
export function gainForTarget(measuredLufs: number, targetLufs = -16): number {
  return Math.pow(10, (targetLufs - measuredLufs) / 20);
}

/** Turn silence segments into kept regions of source [0, totalDuration). */
export function keptRegionsFromSilences(
  segments: SilenceSegment[],
  totalDuration: Time,
  padding = 0.1,
  fps = 30,
): { start: Time; duration: Time }[] {
  const total = secs(totalDuration);
  const kept: SilenceSegment[] = [];
  let cursor = 0;
  for (const s of segments) {
    const sStart = Math.max(0, s.start - padding);
    if (sStart > cursor) kept.push({ start: cursor, end: sStart, duration: sStart - cursor });
    cursor = Math.max(cursor, s.end + padding);
  }
  if (cursor < total) kept.push({ start: cursor, end: total, duration: total - cursor });
  return kept.map((k) => ({ start: fromSeconds(k.start, fps), duration: fromSeconds(k.duration, fps) }));
}
