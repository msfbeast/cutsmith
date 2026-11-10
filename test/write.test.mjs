import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFcpXml } from "../dist/fcpxml/write.js";
import { parseFcpXml } from "../dist/fcpxml/parse.js";
import { t, parseTime, secs } from "../dist/time.js";

const assets = [
  { id: "camA", name: "Cam A Interview", src: "file:///footage/camA.mov", duration: t(600) },
  { id: "broll", name: "Broll Desk", src: "file:///footage/broll.mov", duration: t(120) },
];

test("generator emits parseable FCPXML with correct spine layout", () => {
  const xml = buildFcpXml({
    event: "Cutsmith Import",
    name: "Test Cut",
    format: { id: "fx1", width: 1920, height: 1080, fps: 30 },
    clips: [
      { kind: "asset", ref: "camA", name: "A1", offset: t(0), start: t(10), duration: t(4) },
      { kind: "gap", offset: t(4), duration: t(1) },
      { kind: "asset", ref: "broll", name: "B1", offset: t(5), start: t(0), duration: t(3) },
      { kind: "title", ref: undefined, name: "Basic Text", lane: 1, offset: t(0), duration: t(3), text: "Hello world" },
    ],
  }, assets);
  const model = parseFcpXml(xml);
  assert.equal(model.formats[0].fps, 30);
  const spine = model.events[0].projects[0].spine;
  assert.equal(spine.length, 4);
  assert.equal(secs(spine[0].duration), 4);
  assert.equal(secs(model.events[0].projects[0].duration), 8);
  const title = spine[3];
  assert.equal(title.kind, "title");
});

test("auto-layout: null offsets append after previous clip", () => {
  const xml = buildFcpXml({
    event: "E", name: "P", format: { id: "fx1", width: 1920, height: 1080, fps: 30 },
    clips: [
      { kind: "asset", ref: "camA", name: "A1", offset: null, duration: t(4, 1) },
      { kind: "asset", ref: "camA", name: "A2", offset: null, duration: t(2500, 30) },
    ],
  }, assets);
  const spine = parseFcpXml(xml).events[0].projects[0].spine;
  // second clip snaps to the 30fps grid after the first
  assert.ok(Math.abs(secs(spine[1].offset) - 4) < 1e-9);
});

test("rejects unknown asset refs with an actionable error", () => {
  assert.throws(() => buildFcpXml({
    event: "E", name: "P", format: { id: "fx1", width: 1920, height: 1080, fps: 30 },
    clips: [{ kind: "asset", ref: "nope", offset: t(0), duration: t(1) }],
  }, assets), /unknown asset id "nope"/);
});

test("NTSC fps uses Apple's rational frame durations", () => {
  const xml = buildFcpXml({
    event: "E", name: "P", format: { id: "fx1", width: 1920, height: 1080, fps: 29.97 },
    clips: [{ kind: "asset", ref: "camA", offset: null, duration: t(1) }],
  }, assets);
  assert.match(xml, /frameDuration="100\/2997s"/);
});
