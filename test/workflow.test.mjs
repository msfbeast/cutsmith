import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findGlitches, parseSrt, chunkCuesByWords, cuesToCaptions } from "../dist/workflow/captions.js";
import { parseFcpXml } from "../dist/fcpxml/parse.js";
import { secs } from "../dist/time.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.fcpxml");

test("flags the 2-frame flash clip and the 4s gap", () => {
  const model = parseFcpXml(readFileSync(fixture, "utf8"));
  const spine = model.events[0].projects[0].spine;
  const report = findGlitches(spine, 5 / 30);
  assert.equal(report.microClips.length, 1);
  assert.ok(report.microClips[0].atSecs > 58 && report.microClips[0].atSecs < 59);
  assert.equal(report.gaps.length, 1);
  assert.ok(Math.abs(report.gaps[0].durationSecs - 4) < 1e-9);
  // clip B -> flash clip boundary must be seamless (no gap flagged between them)
  assert.ok(!report.overlaps.length);
});

const SRT = `1
00:00:01,000 --> 00:00:03,000
Welcome back

2
00:00:03,500 --> 00:00:06,250
today we are building
something great

3
00:00:07,000 --> 00:00:08,000
<b>fast</b>
`;

test("SRT parser handles multi-line cues and strips formatting tags", () => {
  const cues = parseSrt(SRT);
  assert.equal(cues.length, 3);
  assert.equal(cues[1].text, "today we are building\nsomething great");
  assert.equal(cues[2].text, "fast");
  assert.equal(cues[0].start, 1);
});

test("word chunking splits cues evenly", () => {
  const cues = parseSrt(SRT);
  const chunked = chunkCuesByWords(cues, 2);
  // cue1: 2 words -> 1 chunk; cue2: 5 words -> 3 chunks; cue3: 1 word -> 1 chunk
  assert.equal(chunked.length, 5);
  const caps = cuesToCaptions(chunked, 30);
  // cue2 has 6 words -> 3 even chunks over 3.5..6.25s: 3.5, 3.5+0.9167, ...
  // frame snap at 30fps biases down at half-frames: 132.5 frames -> 132 (4.4s)
  assert.ok(Math.abs(secs(caps[1].start) - 3.5) < 1e-9);
  assert.ok(Math.abs(secs(caps[1].end) - 4.4) < 1e-9);
});

test("bad timestamps throw with guidance", () => {
  assert.throws(() => parseSrt("1\nnot a time --> also not\ntext"), /bad timestamp/);
});
