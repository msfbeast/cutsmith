import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFcpXml, summarize } from "../dist/fcpxml/parse.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.fcpxml");
const model = parseFcpXml(readFileSync(fixture, "utf8"));

test("extracts formats with fps", () => {
  assert.equal(model.formats.length, 1);
  assert.equal(model.formats[0].fps, 30);
  assert.equal(model.formats[0].width, 1920);
  assert.equal(model.formats[0].height, 1080);
});

test("extracts assets with src and durations", () => {
  assert.equal(model.assets.length, 3);
  const camA = model.assets.find((a) => a.id === "r2");
  assert.equal(camA.name, "Cam A Interview");
  assert.equal(camA.src, "file:///Users/editor/footage/camA.mov");
  assert.equal(camA.duration.num, 600);
});

test("parses spine in order with kinds, offsets, markers, captions", () => {
  const spine = model.events[0].projects[0].spine;
  assert.equal(spine.length, 5);
  assert.deepEqual(spine.map((c) => c.kind), ["asset", "asset", "asset", "gap", "asset"]);
  const first = spine[0];
  assert.equal(first.duration.num, 50);
  assert.equal(first.start.num, 15);
  assert.equal(first.markers.length, 1);
  assert.equal(first.markers[0].name, "Good take");
  const flash = spine[2];
  assert.ok(secsOf(flash.duration) < 0.1);
  assert.ok(secsOf(flash.offset) > 2, "rational offset '64091584/48640s' parses to > 2s");
  const last = spine[4];
  assert.equal(last.captions.length, 1);
  assert.equal(last.captions[0].text, "Welcome back to the show");
});

import { secs } from "../dist/time.js";
function secsOf(t) { return secs(t); }

test("summarize emits LLM-friendly JSON", () => {
  const s = summarize(model);
  assert.equal(s.resolution.fps, 30);
  assert.equal(s.projects[0].project, "Rough Cut v1");
  assert.equal(s.events[0], "Podcast Ep 42");
  assert.equal(s.spine.length, 5);
  assert.equal(s.spine[4].captions, 1);
});
