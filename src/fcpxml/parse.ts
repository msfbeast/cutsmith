/**
 * FCPXML parser: turn a timeline document into a plain JSON model an LLM can reason over.
 *
 * CRITICAL DESIGN NOTE: we use fast-xml-parser in preserveOrder mode. Default mode
 * groups same-named siblings into arrays, which silently REORDERS interleaved
 * <asset-clip>/<gap>/<title> children of <spine> — destroying the edit order,
 * which for a timeline document is the content. preserveOrder keeps document
 * order; we walk entries as { elementName: [...children], ":@": {attrs} }.
 *
 * Tolerates FCPXML 1.8-1.13 spine-based project structure. Nested stories and
 * compound clips are preserved as raw children (phase 2 will flatten them).
 */
import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { Time, parseTime, timeStr, secs, t } from "../time.js";

export interface FormatInfo {
  id: string;
  frameDuration?: Time;
  width?: number;
  height?: number;
  fps?: number;
  name?: string;
}

export interface AssetInfo {
  id: string;
  name?: string;
  src?: string;
  duration?: Time;
  hasVideo?: boolean;
  hasAudio?: boolean;
  formatId?: string;
}

export interface MarkerInfo {
  name?: string;
  start: Time;
  type?: string; // marker | chapter | toDo
}

export interface CaptionInfo {
  start: Time;
  end: Time;
  text: string;
}

export interface Clip {
  kind: "asset" | "gap" | "title" | "other";
  ref?: string;
  name?: string;
  offset: Time | null;
  start?: Time;
  duration: Time;
  lane?: number;
  audioStart?: Time;
  roles?: string;
  text?: string; // title/caption text (for titles: the <text> payload)
  markers: MarkerInfo[];
  captions?: CaptionInfo[];
  children?: unknown[]; // raw child nodes (compound clips, stories, audio)
}

export interface ProjectModel {
  name?: string;
  duration?: Time;
  formatId?: string;
  tcStart?: Time;
  spine: Clip[];
}

export interface TimelineModel {
  version: string;
  formats: FormatInfo[];
  assets: AssetInfo[];
  effects: { id: string; name?: string; uid?: string }[];
  events: { name?: string; projects: ProjectModel[] }[];
}

type Node = Record<string, unknown>; // preserveOrder entry: { tag: children, ":@": attrs }

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: true,
  textNodeName: "#text",
});

function tagName(n: Node): string | null {
  for (const k of Object.keys(n)) if (k !== ":@") return k;
  return null;
}

function attrs(n: Node): Record<string, string> {
  return (n[":@"] as Record<string, string>) ?? {};
}

function children(n: Node): Node[] {
  const tag = tagName(n);
  const inner = tag ? n[tag] : undefined;
  return Array.isArray(inner) ? inner : [];
}

const num = (v: unknown): number | undefined =>
  v !== undefined && v !== "" ? Number(v) : undefined;

function maybeTime(v: unknown): Time | undefined {
  if (typeof v !== "string" || !v) return undefined;
  try { return parseTime(v); } catch { return undefined; }
}

function collectTextRecurse(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (tagName(n) === "#text") {
      out += String(n["#text"] ?? "");
      continue;
    }
    out += collectTextRecurse(children(n));
  }
  return out;
}

function clipFromNode(tag: string, n: Node): Clip {
  const a = attrs(n);
  const kind: Clip["kind"] =
    tag === "asset-clip" || tag === "video" || tag === "audio" ? "asset" :
    tag === "gap" ? "gap" :
    tag === "title" ? "title" : "other";
  const kids = children(n);
  const markers: MarkerInfo[] = [];
  const captions: CaptionInfo[] = [];
  const rawChildren: unknown[] = [];
  let text: string | undefined;
  for (const kid of kids) {
    const kt = tagName(kid);
    if (kt === "marker") {
      const ka = attrs(kid);
      markers.push({
        name: ka["@_value"] ?? ka["@_name"],
        start: maybeTime(ka["@_start"]) ?? t(0),
        type: ka["@_type"],
      });
    } else if (kt === "text" && kind === "title") {
      text = collectTextRecurse(children(kid)).trim();
    } else if (kt === "caption") {
      const ka = attrs(kid);
      captions.push({
        start: maybeTime(ka["@_start"]) ?? t(0),
        end: maybeTime(ka["@_end"]) ?? t(0),
        text: collectTextRecurse(children(kid)).trim(),
      });
    } else if (kt && kt !== "#text" && kind === "asset") {
      // audio/video sub-elements: keep raw (phase 2 flattens adjustments)
      rawChildren.push(kid);
    } else if (kt && kt !== "#text") {
      rawChildren.push(kid);
    }
  }
  return {
    kind,
    ref: a["@_ref"],
    name: a["@_name"],
    offset: maybeTime(a["@_offset"]) ?? null,
    start: maybeTime(a["@_start"]),
    duration: maybeTime(a["@_duration"]) ?? t(0),
    lane: num(a["@_lane"]),
    audioStart: maybeTime(a["@_audioStart"]),
    roles: a["@_audioRoles"],
    text,
    markers,
    captions: captions.length ? captions : undefined,
    children: rawChildren.length ? rawChildren : undefined,
  };
}

function extractResource(n: Node, formats: FormatInfo[], assets: AssetInfo[], effects: TimelineModel["effects"]): void {
  const rt = tagName(n);
  if (rt === "format") {
    const f = attrs(n);
    const fd = maybeTime(f["@_frameDuration"]);
    const fdS = fd ? secs(fd) : undefined;
    formats.push({
      id: f["@_id"] ?? "",
      frameDuration: fd,
      width: num(f["@_width"]),
      height: num(f["@_height"]),
      fps: fdS ? Math.round((1 / fdS) * 1000) / 1000 : undefined,
      name: f["@_name"],
    });
  } else if (rt === "asset") {
    const a = attrs(n);
    // Apple's 1.11 form: file lives in <media-rep kind="original-media" src=...>;
    // older/community files put src directly on the asset — accept both.
    const rep = children(n).find((c) => tagName(c) === "media-rep");
    assets.push({
      id: a["@_id"] ?? "",
      name: a["@_name"],
      src: (rep ? attrs(rep)["@_src"] : undefined) ?? a["@_src"],
      duration: maybeTime(a["@_duration"]),
      hasVideo: a["@_hasVideo"] === "1",
      hasAudio: a["@_hasAudio"] === "1",
      formatId: a["@_format"],
    });
  } else if (rt === "effect") {
    const e = attrs(n);
    effects.push({ id: e["@_id"] ?? "", name: e["@_name"], uid: e["@_uid"] });
  }
}

export function parseFcpXml(xml: string): TimelineModel {
  const doc = PARSER.parse(xml) as Node[];
  const root = doc.find((n) => tagName(n) === "fcpxml");
  if (!root) throw new Error("not an FCPXML document (missing <fcpxml> root)");
  const ra = attrs(root);
  const formats: FormatInfo[] = [];
  const assets: AssetInfo[] = [];
  const effects: TimelineModel["effects"] = [];
  const events: TimelineModel["events"] = [];
  for (const res of children(root)) {
    const rt = tagName(res);
    if (rt === "resources") {
      for (const n of children(res)) extractResource(n, formats, assets, effects);
    } else {
      extractResource(res, formats, assets, effects);
    }
  }
  // events may live under <library>; FCPXML 1.11 also allows <project> at root level (rare)
  const walkEvents = (nodes: Node[]) => {
    for (const n of nodes) {
      const nt = tagName(n);
      if (nt === "library") walkEvents(children(n));
      else if (nt === "event") {
        const ev = attrs(n);
        const projects: ProjectModel[] = [];
        for (const p of children(n)) {
          if (tagName(p) !== "project") continue;
          const pa = attrs(p);
          const seq = children(p).find((c) => tagName(c) === "sequence");
          let spine: Clip[] = [];
          if (seq) {
            const spineNode = children(seq).find((c) => tagName(c) === "spine");
            if (spineNode) spine = children(spineNode)
              .filter((c) => tagName(c) !== "#text")
              .map((c) => clipFromNode(tagName(c)!, c));
          }
          projects.push({
            name: pa["@_name"],
            duration: seq ? maybeTime(attrs(seq)["@_duration"]) : undefined,
            formatId: seq ? attrs(seq)["@_format"] : undefined,
            tcStart: seq ? maybeTime(attrs(seq)["@_tcStart"]) : undefined,
            spine,
          });
        }
        events.push({ name: ev["@_name"], projects });
      }
    }
  };
  walkEvents(children(root));
  return { version: ra["@_version"] ?? "1.11", formats, assets, effects, events };
}

export function parseFcpXmlFile(path: string): TimelineModel {
  return parseFcpXml(readFileSync(path, "utf8"));
}

/** Compact LLM-facing summary of a timeline. */
export function summarize(model: TimelineModel): Record<string, unknown> {
  const projects = model.events.flatMap((e) =>
    e.projects.map((p) => ({ event: e.name, project: p.name, clips: p.spine.length })));
  const primary = model.events.flatMap((e) => e.projects)[0];
  const fmt = model.formats.find((f) => f.id === primary?.formatId) ?? model.formats[0];
  return {
    fcpxmlVersion: model.version,
    resolution: fmt ? { width: fmt.width, height: fmt.height, fps: fmt.fps } : undefined,
    events: model.events.map((e) => e.name),
    projects,
    assets: model.assets.map((a) => ({ id: a.id, name: a.name, src: a.src })),
    ...(primary ? { spine: primary.spine.map((c) => ({
      kind: c.kind,
      name: c.name,
      ref: c.ref,
      offset: c.offset ? timeStr(c.offset) : null,
      start: c.start ? timeStr(c.start) : undefined,
      duration: timeStr(c.duration),
      lane: c.lane,
      markers: c.markers.length ? c.markers.map((m) => ({ name: m.name, at: timeStr(m.start) })) : undefined,
      captions: c.captions?.length ?? 0,
    })) } : {}),
  };
}
