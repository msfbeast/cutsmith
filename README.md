# CutSmith

**Workflow-level MCP server for Final Cut Pro.** Lets any MCP-capable LLM (Claude, Hermes,
Cursor, …) assemble rough cuts, clean up edit artifacts, distribute captions, and QC timelines —
on stock Final Cut Pro, no patched builds or kernel injection.

The idea is not "another wrapper around FCP menus" (see [Prior art](#prior-art)).
The primitive tools already exist; CutSmith sits a level above: it does the
workflows that turn raw recordings into a finished timeline, built directly on
Apple's FCPXML interchange format and ffmpeg audio analysis.

> Phase 1 focuses on the four pain points podcast/video editors complain about most:
> per-source sync drift, invisible loudness decisions, glitch frames left by silence
> removal, and captioning. Each maps to a tool below.

## Tools (9)

| Tool | What it does |
|------|-------------|
| `analyze_timeline` | Parse any `.fcpxml` → resolution, fps, projects, every clip with timecodes, markers, captions |
| `detect_glitches` | Find micro-clip flash frames (clips shorter than N frames), unintended gaps, overlaps |
| `analyze_silence` | ffmpeg `silencedetect` on a media file → silence segments in source timecodes |
| `measure_loudness` | ffmpeg `loudnorm` → integrated LUFS, true peak, and the exact linear gain needed for a target (e.g. -16 LUFS) |
| `assemble_rough_cut` | **The core builder**: kept regions + per-source sync offsets + measured gain corrections + SRT captions → a new FCPXML project. Originals are never modified |
| `convert_srt_to_captions` | SRT/VTT → FCPXML-caption preview, with N-word chunking for social-style captions |
| `check_fcp_available` | Probe whether Final Cut Pro is running and scriptable on this Mac |
| `import_xml_into_fcp` | Open a generated `.fcpxml` in FCP (File > Import XML equivalent) |
| `export_project_xml` | Ask FCP to export the front project as XML |
| `validate_dtd` | Certify an `.fcpxml` against Apple's official DTD (auto-found inside the FCP install) with `xmllint` — the strongest import-safety check |
| `remove_silences` | One call: ffprobe → silencedetect → kept regions (padded, frame-snapped) → loudness-normalized NEW project |
| `fix_glitches` | Drop or absorb micro-clips in a NEW file; refuses to flatten nested structures unless forced |
| `plan_ducking` | Speech-informed music ducking plan with explicit dials (duckVolume / padding / threshold); output feeds `assemble_rough_cut` per-region volume |

All tools page or cap their output, so hour-long episodes analyze without flooding model context. Every generated file in the test suite validates against Apple's official FCPXML v1.11 DTD.

## The sync-offset fix

Riverside/podcast recordings drift per guest. Instead of manually nudging clips every
session, CutSmith turns the fix into data: each asset carries a `syncOffsetSecs`, and
`assemble_rough_cut` applies it mathematically to every in-point. Set it once per guest.

## Why not inject into FCP?

Bottom line: splice-in works in other tools; here it is out of scope. CutSmith only
reads and writes documented, forward-compatible formats (FCPXML 1.11) plus AppleScript
that Apple ships. It cannot break your libraries or get your FCP version bricked by
an macOS update — a real consideration for production machines.

## Install

Requirements: macOS, Node 18+, Final Cut Pro 10.6+ (only for the FCP roundtrip tools;
analysis/assembly work without it), ffmpeg on PATH (audio tools).

```bash
git clone https://github.com/yourname/cutsmith.git
cd cutsmith
npm install && npm run build
npm test && npm run smoke   # 20 unit tests + 8 end-to-end checks
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cutsmith": {
      "command": "node",
      "args": ["/absolute/path/to/cutsmith/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add cutsmith -- node /absolute/path/to/cutsmith/dist/index.js
```

### Hermes Agent (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  cutsmith:
    command: "node"
    args: ["/absolute/path/to/cutsmith/dist/index.js"]
```

## Example flow

```
You:    "Here are yesterday's Riverside files for Ep 43. Build a rough cut."
LLM:    analyze_silence on each guest track
        → assemble_rough_cut with keptRegions you approve, syncOffset for the
          cohost, targetLufs -16 with normalize: true
        → import_xml_into_fcp
        → detect_glitches on the import, fix, re-import
You:    review the timeline in FCP, tweak, ship.
```

## Roundtrip notes

FCP's AppleScript dictionary is limited. XML export timing varies by FCP version —
`export_project_xml` does its best via AppleScript and falls back with instructions
(File > Export XML… → re-run `analyze_timeline` on the file). Import of generated XML
is reliable: `File > Import XML…` or `import_xml_into_fcp`. Read
[FCPXML on Apple's docs](https://support.apple.com/guide/final-cut-pro/xml-interchange-verd99cb99ec/mac) for the format.

## Prior art

- [SpliceKit](https://github.com/elliotttate/SpliceKit) — the deepest FCP MCP (~200 tools via ObjC runtime, requires patched FCP build)
- [fcp-mcp](https://github.com/kks0488/fcp-mcp) — 30 safe FCPXML/QC/roundtrip tools

CutSmith is the workflow layer: assemble-from-scratch, audio-measured gain, sync
offsets, caption chunking — with tests that verify the actual written timelines.

## Verifying on a FCP machine

The whole run is one command — every check that can only pass with Final Cut Pro present:

```bash
node test/acceptance.mjs
```

- exit `10` + install instructions → FCP missing/unusable (nothing else tested)
- PASS list + exit `0` → AppleScript roundtrip live, DTD-certified project imported into real FCP

The 90-day free FCP trial (Mac App Store) is enough; remove it after testing if you don't own it.

Manual depth-checks after a pass:
1. `npm install && npm run build && npm test && npm run smoke` — all 20 unit tests + 12 smoke checks must pass.
2. Launch FCP once by hand first (first-run dialogs out of the way); grant macOS Automation permission when the acceptance run asks.
3. In FCP, confirm the imported event ("Cutsmith Acceptance"): clips land, titles render, audio present.
4. `validate_dtd` on any FCP-exported XML — must pass both ways.

## Known limitations (read before trusting it with a master timeline)

- **Roundtripping complex timelines is lossy.** The parser reads compound clips, attached audio sub-clips and effect payloads raw; the generator writes flat spines. Analyze-and-assemble-new is the safe path; in-place regeneration of an editor's intricate project will flatten structure (tools warn and refuse unless `force=true`).
- Captions ship as Basic Text titles (universal), not native `<caption>` elements; word timings in chunked captions are evenly distributed, not word-accurate.
- Volume ducking is stepped per region (FCPXML has no editable crossfade automation in 1.11); keep duck levels moderate.
- Drop-frame timecode (29.97 DF) and >2-channel audio layouts are not yet mapped.
- `import_xml_into_fcp` / `export_project_xml` behavior varies across FCP versions; validated import path is FCP's own File > Import XML. Apple's DTD ships inside FCP and cannot be redistributed here.

## Credits

DTD verification uses Apple's FCPXML DTDs, discovered at runtime from your FCP install; the DTD forms matched against OpenFCPXMLKit's published copies during development.

## License

MIT
