/**
 * FCPXML generator: build a timeline document from our JSON model.
 * Emits FCPXML 1.11 (importable by Final Cut Pro 10.6.1+).
 * Strategy: one event, one project, a spine of asset clips + gaps, optional
 * title clips (Basic Text) in lane 1 and captions as <caption> children.
 */
import { Time, timeStr, t, secs, cmp, add } from "../time.js";
import type { CaptionInfo, Clip, FormatInfo } from "./parse.js";

export interface AssembleAsset {
  id: string;          // our reference id (becomes r1, r2, ...)
  name: string;
  src: string;         // file:// or absolute path
  duration?: Time;
  hasVideo?: boolean;
  hasAudio?: boolean;
}

export interface AssembleFormat {
  id: string;          // e.g. r1 reserved; we namespace formats as f1...
  width: number;
  height: number;
  fps: number;         // e.g. 30 or 29.97
}

export interface AssembleClip {
  kind: "asset" | "gap" | "title";
  ref?: string;        // AssembleAsset.id
  name?: string;
  offset: Time | null; // null => auto-append after previous clip
  start?: Time;        // source in-point
  duration: Time;
  lane?: number;
  audioRoles?: string;
  mute?: boolean;
  volume?: number;     // linear gain multiplier (1.0 = unity), written as <adjust-volume>
  text?: string;       // titles
  textStyle?: { font?: string; fontSize?: number; fontColor?: string; alignment?: string; bold?: boolean };
  caption?: boolean;   // kind=title + caption => caption semantics kept via clip children
  markers?: { name?: string; start: Time }[];
}

export interface AssembleProject {
  event: string;
  name: string;
  format: AssembleFormat;
  tcStart?: Time;
  clips: AssembleClip[];
  captions?: CaptionInfo[]; // free captions laid on lane 1 as Basic Text titles
}

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESC[c]!);

function fmtNum(n: number): string {
  // FCPXML wants compact rationals; 29.97 => 100/2997 handled via fps*1000
  return String(Math.round(n * 1000) / 1000);
}

function fpsRational(fps: number): { num: number; den: number } {
  // standard NTSC handling: 29.97 -> 100/2997 used by Apple as frameDuration 100/2997s
  if (Math.abs(fps - 29.97) < 0.01) return { num: 100, den: 2997 };
  if (Math.abs(fps - 23.976) < 0.01) return { num: 100, den: 2398 };
  if (Math.abs(fps - 59.94) < 0.01) return { num: 100, den: 5994 };
  if (Math.abs(fps - 119.88) < 0.01) return { num: 100, den: 11988 };
  return { num: 1, den: Math.round(fps) };
}

function frameDur(fps: number): Time {
  const r = fpsRational(fps);
  return t(r.num, r.den);
}

function snap(v: Time, fps: number): Time {
  // snap to nearest frame boundary of the project fps: floor alignment
  const fd = frameDur(fps);
  // value in frames = v / fd; round to integer frames
  const frames = Math.round(secs(v) / secs(fd));
  return t(frames * fd.num, fd.den);
}

export function buildFcpXml(p: AssembleProject, assets: AssembleAsset[]): string {
  if (!assets.length) throw new Error("no assets: an FCPXML project must reference at least one imported asset");
  const fps = p.format.fps;
  // resource ids: assets r1..rn, then the title effect rn+1, format f1
  const assetIds = new Map(assets.map((a, i) => [a.id, `r${i + 1}`]));
  const titleEffectId = `r${assets.length + 1}`;
  const formatId = "r1";
  // NOTE: format id must not collide with asset ids in strict readers; Apple uses
  // shared id space. We allocate formats as fx1 to be safe.
  const formatRef = "fx1";

  const lines: string[] = [];
  const fd = frameDur(fps);
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push(`<fcpxml version="1.11">`);
  lines.push(`  <resources>`);
  lines.push(`    <format id="${formatRef}" frameDuration="${timeStr(fd)}" width="${p.format.width}" height="${p.format.height}" colorSpace="1-1-1 (Rec. 709)"/>`);
  for (const a of assets) {
    const flags = `hasVideo="${a.hasVideo === false ? 0 : 1}" hasAudio="${a.hasAudio === false ? 0 : 1}"`;
    const dur = a.duration ? ` duration="${timeStr(a.duration)}"` : "";
    const formatAttr = ` format="${formatRef}"`;
    lines.push(`    <asset id="${assetIds.get(a.id)}" name="${esc(a.name)}" src="${esc(a.src)}" start="0/1s"${dur}${formatAttr} audioSources="1" audioChannels="2" ${flags} />`);
  }
  lines.push(`    <effect id="${titleEffectId}" name="Basic Text" uid=".../Titles.localized/Basic Text.localized/Basic Text.moti"/>`);
  lines.push(`  </resources>`);

  lines.push(`  <library>`);
  lines.push(`    <event name="${esc(p.event)}">`);
  lines.push(`      <project name="${esc(p.name)}">`);
  // compute total duration while laying out
  let cursor: Time = t(0);
  const laidOut: { clip: AssembleClip; offset: Time }[] = [];
  for (const c of p.clips) {
    const offset = c.offset ? snap(c.offset, fps) : cursor;
    // titles/captions ride higher lanes: they extend the timeline only if they
    // reach past the current spine cursor
    const end = add(offset, c.duration);
    cursor = cmp(end, cursor) > 0 ? end : cursor;
    laidOut.push({ clip: c, offset });
  }
  const total = cursor;
  const tcStart = p.tcStart ?? t(3600);
  lines.push(`        <sequence format="${formatRef}" duration="${timeStr(total)}" tcStart="${timeStr(tcStart)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  lines.push(`          <spine>`);

  let tsCounter = 0;
  for (const { clip: c, offset } of laidOut) {
    const common = `offset="${timeStr(offset)}"`;
    if (c.kind === "gap") {
      lines.push(`            <gap name="Gap" ${common} duration="${timeStr(c.duration)}"/>`);
      continue;
    }
    if (c.kind === "asset") {
      const ref = c.ref ? assetIds.get(c.ref) : undefined;
      if (!ref) throw new Error(`clip references unknown asset id "${c.ref}"`);
      const vol = c.volume !== undefined && c.volume !== 1 ? `<adjust-volume amount="${fmtNum(c.volume)}"/>` : "";
      const mk = (c.markers ?? []).map((m) =>
        `<marker start="${timeStr(m.start)}" duration="1/${Math.round(fps)}s" value="${esc(m.name ?? "")}"/>`).join("");
      lines.push(`            <asset-clip name="${esc(c.name ?? "Clip")}" ref="${ref}" ${common} start="${timeStr(c.start ?? t(0))}" duration="${timeStr(c.duration)}"${c.mute ? ' audioMute="1"' : ""}${c.audioRoles ? ` audioRoles="${esc(c.audioRoles)}"` : ""}>${mk}${vol}</asset-clip>`);
      continue;
    }
    if (c.kind === "title") {
      tsCounter++;
      const style = c.textStyle ?? {};
      const fontSize = style.fontSize ?? 63;
      const font = style.font ?? "Helvetica";
      const bold = style.bold ? ' fontFace="Bold"' : ' fontFace="Regular"';
      const color = style.fontColor ?? "1 1 1 1";
      const align = style.alignment ?? "center";
      lines.push(`            <title name="${esc(c.name ?? "Basic Text")}" ref="${titleEffectId}" lane="${c.lane ?? 1}" ${common} start="3600s" duration="${timeStr(c.duration)}">`);
      lines.push(`              <text>`);
      lines.push(`                <text-style ref="ts${tsCounter}">${esc(c.text ?? "")}</text-style>`);
      lines.push(`              </text>`);
      lines.push(`              <text-style-def id="ts${tsCounter}">`);
      lines.push(`                <text-style font="${esc(font)}" fontSize="${fontSize}"${bold} fontColor="${color}" alignment="${align}" />`);
      lines.push(`              </text-style-def>`);
      lines.push(`            </title>`);
      continue;
    }
  }
  lines.push(`          </spine>`);
  lines.push(`        </sequence>`);
  lines.push(`      </project>`);
  lines.push(`    </event>`);
  lines.push(`  </library>`);
  lines.push(`</fcpxml>`);
  return lines.join("\n") + "\n";
}
