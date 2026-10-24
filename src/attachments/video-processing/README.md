# Disabled native video processing port

NativeVideoProcessor accepts a verified processor directory, generated job root and optional reduced deadline. process(bytes, {filename, mime}, signal?) returns normalized MP4, JPEG thumbnail, dimensions, duration, peakRssBytes and nativeRssObserved; shutdown cancels active work. One job per instance is enforced here; the application must hold the frozen global processing lease across image/video instances. This port is not registered in routes or enabled configuration.

The child heap is 64MiB with one native thread. The parent supervises the entire job against 15s, including filesystem admission, binary integrity checks, probe, full decode, remux, normalized decode and thumbnail. Supplied filenames never become paths. Generated exact-owned directories are removed in finally, including failure/cancellation. Temporary disk is observed against 64MiB; source/remux/thumbnail limits also bound expected outputs. Bounded stdout/stderr are discarded from public errors; secrets, PATH, NODE_OPTIONS, proxy settings and application environment are not inherited.

A valid input passes frozen complete MP4 structural validation, strict ffprobe profile/dimensions/CFR/audio/stream checks and fatal full FFmpeg decode. Remux then strips all type6 SEI, supplied container/stream metadata and chapters; explicit generic handler/language metadata is regenerated. Normalized output must pass structural validation, contain zero SEI, pass an allowlist of generated native metadata and full decode again. A bounded JPEG thumbnail is generated, metadata stripped, structurally validated and fully decoded. The input is never returned as a fallback. Raw compressed slices/AAC remain untrusted until native decode.

Linux uses a separate process group and SIGKILL on timeout/cancellation; fresh-exec /proc VmHWM observations include Node and its currently observed native child. At least one native observation is required for Linux success. The watchdog uses192MiB and25ms sampling; it is not an OS memory cap, allocation proof, or network sandbox. file/pipe protocol restrictions do not imply network isolation. Windows uses taskkill /T /F and real descendant-termination regression tests. nativeRssObserved is false on Windows: local functional tests do not establish native-memory acceptance.

## Explicit processor packaging

The build operator may run:
```text
node scripts/package-phase30-processors.cjs ARCHIVE DESTINATION [--download]
```
This is not an app startup/request hook. --download selects only the previously approved HTTPS release, caps bytes and total download time, and does not create an external provider. Without that flag it uses an existing archive. DESTINATION must not already exist; the script never performs bucket/filesystem-wide cleanup.

The approved Linux LGPL archive is137943568bytes, SHA2565ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927, releaseautobuild-2026-10-20-13-08, versionn9.0.2-29-g6dfaba896f. After checksum validation, tar listing is bounded and only the exact ffmpeg/ffprobe/LICENSE members are emitted through stdout into generated filenames. Archive-controlled paths are never extracted onto the filesystem. Per-binary hashes and pinned source/build/license references are retained in manifest.json. Failed installs are rejected; preserve any failed exact-owned directory for diagnosis or remove that exact directory explicitly before retrying.

At runtime both binary hashes, archive identity and exact native version/configuration are rechecked. No system ffmpeg or PATH fallback exists. LGPL LICENSE.txt is retained; upstream source/build instructions and linked-library notices must accompany any distribution. This slice does not claim legal/patent clearance. Sources:
- https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-20-13-08
- https://github.com/BtbN/FFmpeg-Builds
- https://github.com/FFmpeg/FFmpeg/tree/6dfaba896f

The explicit local functional tests use the already present approved Windows binaries, checked against their fixed SHA256 hashes, and a temporary ownership manifest. No downloads occur in those tests. Set PHASE30_PROCESSOR_DIR to that approved directory or an approved Linux package to run native-pipeline.spec.ts; otherwise those native cases are visibly skipped.

## Evidence and remaining gates

Executed locally: strict probe/admission tests; real pinned Windows generated color-only source with private synthetic title/comment/SEI; successful complete decode/sanitize/thumbnail; structurally valid corrupted compressed slices rejected; actual native descendants terminated on timeout/cancel; exact-owned temporary file cleanup. No real-user media or provider access.

Not executed by this slice: Linux archive extraction/download, Linux current resource/termination measurements, hardest15s/720p native implementation resource cases, actual Render packaging/cgroup/headroom/API interference, real attachment route/storage/authorization lifecycle, production deployment or provider changes. Full isolated raw artifact proofs from001 do not replace these implementation gates. Windows functional success is not Render acceptance. Every format remains disabled until the authoritative002 exact deployment/security/resource gates pass. No READY/publication integration or architecture policy expansion is authorized here.
