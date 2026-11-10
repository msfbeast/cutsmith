# Changelog

## 0.1.1 — Handoff hardening

- **DTD-true output**: assets now use Apple's canonical `<media-rep kind="original-media" src=…>` child form; `adjust-volume` before markers per DTD order. All generator output and the fixture validate against Apple's official FCPXML v1.11 DTD (`xmllint --dtdvalid`).
- **`validate_dtd` tool**: xmllint against Apple's DTD, auto-discovered inside the FCP install (`CUTSMITH_DTD` override).
- **Pagination**: `analyze_timeline` rides with page/pageSize on the spine (large episodes no longer flood context); `detect_glitches` caps arrays with truncation flags.
- **`remove_silences`**: one call — ffprobe duration → silencedetect → kept regions → normalized FCPXML.
- **`fix_glitches`**: drop or absorb micro-clips; refuses to flatten nested structures unless `force`.
- **`plan_ducking`**: explicit dialable ducking plan (speech-informed regions with per-region volumes, consumed by `assemble_rough_cut` per-region `volume`).
- Parser reads titles' text payloads (typed `text`) and both asset `src` placements.
- Smoke expanded to 12 checks. Real type-check (tsc 5.9.3): 0 errors.

## 0.1.0 — First release

- 9 tools: analyze/QC/assemble/captions/loudness + best-effort FCP AppleScript roundtrip.
