# Dependency licenses

Foreman's original source is Apache-2.0. Dependencies retain their own licenses;
this repository does not relicense vendor SDKs, native executables, fonts or the
workspace-name catalogue. The catalogue's attribution remains in
[workspace-names.md](workspace-names.md) and [NOTICE](../NOTICE).

## Source publication and installed dependencies

The publication candidate contains Foreman's source and dependency references in
`package.json` and `package-lock.json`. It excludes `node_modules`, compiled output
and installers. Installing from source fetches packages from their publishers;
users must comply with the applicable vendor terms. In particular, the Claude
Agent SDK and Cursor SDK are proprietary dependencies, not Apache-licensed code.
Publishing this repository does not grant permission to redistribute them.

`npm run check:licenses` checks source-publication dependency metadata and the
exact-package evidence in `scripts/dependency-license-reviews.json`. Unknown
licenses fail unless a review records the locked version, tarball integrity,
declared license, retained notice hash and source reference. A changed artifact,
missing notice or stale review fails. The ordinary SPDX-expression allowlist has
not been expanded to accept all unknown, proprietary, MPL or EPL packages.

The review dated 26 October 2026 resolves the 34 original inventory entries as
follows. These are package entries, including platform variants, not 34 different
license problems.

| Packages | Evidence and disposition |
| --- | --- |
| `busboy` 1.6.0, `streamsearch` 1.1.0, `xmlhttprequest-ssl` 2.1.2 | Their published tarballs contain MIT grants although the lock metadata omits the license. Exact notices are retained under `docs/licenses/`. |
| `khroma` 2.1.0 | The npm release's `gitHead`, `4968165afb0d3d09be66497e7985a34f7bfe6d42`, contains the MIT grant. Its npm archive omits that file, so this repository supplies the notice. |
| `lightningcss` 1.33.0 and platform variants; `web-push` 3.6.7 | MPL-2.0, with retained license/notice text. Source references are acceptable in this repository; distributing covered code requires the corresponding source and notices. |
| `elkjs` 0.9.3 | EPL-2.0, with retained license text. Mermaid can bundle it into the renderer despite its dev-dependency classification. Distribution requires the corresponding source, including relevant ELK build sources, and notices. |
| `@anthropic-ai/claude-agent-sdk` 0.3.301 and platform variants | Proprietary vendor terms. Source references remain; installer redistribution and authentication compliance have not been cleared. |
| `@cursor/sdk` 1.0.40 and platform variants | Proprietary vendor terms. Source references remain; permission to redistribute the SDK and native binaries inside installers has not been established. |
| `sherpa-onnx-win-arm64` 2.0.0 | A versionless optional lockfile placeholder caused the unknown-license finding and `npm install --package-lock-only` to fail. Restored its exact registry version, integrity, CPU/OS and Apache-2.0 metadata; no package upgrade. |

## Installer and bundle distribution

`npm run check:licenses:distribution` reports the remaining distribution work. It
currently fails on the vendor packages and on the MPL/EPL source-and-notice
requirements. A successful source inventory check is not installer clearance.
Local packaging commands retain `--publish never`; no release is published by
these checks.

Before distributing an installer or compiled bundle:

1. Establish permission and applicable conditions for the proprietary SDKs and
   their native binaries, or change packaging to avoid redistributing them.
2. Supply the corresponding source for covered MPL/EPL code, with exact release
   revisions, build dependencies and any modifications. Verify that recipients
   can obtain it; an unverified upstream link alone is not the completed check.
3. Inventory the actual packaged files and renderer bundle, including transitive
   dependencies, fonts, native code and downloaded speech models. Preserve every
   required copyright/license notice.
4. Inspect the resulting package to confirm the notices and source information
   are included. The packaging file list includes this document and
   `docs/licenses/`, but configuration alone does not verify a release artifact.

Items 3 and 4 are now generated and checked for each package (below). Items 1
and 2 still need owner decisions.

### Generated installer notices

electron-builder runs `scripts/third-party-notices.mjs` as its `afterPack` hook
on every package, including `--dir` builds, before signing. It reads the
packaged `app.asar` rather than the lockfile:

- every package root in `app.asar`. electron-builder re-hoists `node_modules`
  (the packaged `node_modules/agent-base` is the lockfile's
  `node_modules/axios/node_modules/agent-base`), so packages are matched to
  `package-lock.json` and to reviews by installed name and version;
- every package inlined into the main, preload or renderer bundle, which
  `scripts/third-party-packages.mjs` records in each bundle's
  `third-party-packages.json` at build time. Minified bundles drop most license
  comments; the elkjs chunk keeps none;
- every PE, ELF or Mach-O file, each of which must match a reviewed component in
  `scripts/distribution-components.json`.

It writes `THIRD_PARTY_NOTICES.txt` and `third-party-inventory.json` (name,
version, license, location, lockfile integrity, distribution status and source
of each package and component) next to `app.asar`. Packaging fails when a
shipped package has no license text in the package, in its review or in a
version-pinned `packageNotices` entry; when native code has no reviewed
component; when an excluded file is packaged; or when Electron's
`LICENSE.electron.txt` or `LICENSES.chromium.html` is missing. A new or upgraded
dependency therefore fails packaging until its notice is reviewed. The notices
are not redistribution clearance.

`packageNotices` supplies text for shipped packages that publish none. Each
text was taken from the package itself (agent-base and https-proxy-agent
README license sections), from the release `gitHead` (protobuf-es, connect-es,
Daytona clients, Statsig, xterm.js, http_ece, standard-webhooks), from the
Apache-2.0 text the package declares (Codex, sherpa-onnx, three AWS SDK
packages without a `gitHead`), or from the official MPL-2.0 text (web-push ships
only the Exhibit A header). Two are weaker evidence: jsonlines 0.1.1 publishes
no license text anywhere, so its notice supplies the standard MIT text for the
declared author and says so; standardwebhooks 1.1.1 declares MIT, but the only
license file in its release source is Apache-2.0, which is supplied.

### Packaged inventory: Windows x64, 26 October 2026

Taken from `electron-builder --win --dir --publish never` on Windows (an
unpacked directory, not a signed installer; local native rebuild skipped because
node-gyp could not run winpty's `GetCommitHash.bat` on this machine, so the
`node-pty` N-API prebuilds were packaged). macOS and Linux were not packaged;
the macOS rows below come from listing the published darwin-arm64 npm tarballs.

| Area | Finding |
| --- | --- |
| Packages | 491: 350 in `app.asar`, 139 inlined only in the renderer, 2 in both. The main and preload bundles inline none; all their imports are externalized dependencies in `app.asar`. 485 are `allowed`; 4 are `review-required` (Claude Agent SDK, Cursor SDK and their win32-x64 packages); 2 are `source-required` (web-push in `app.asar`, elkjs in the renderer). lightningcss is a build tool and is not shipped. |
| Fonts | Geist and Geist Mono 5.3.0 (OFL-1.1) are inlined as renderer `woff2` assets; their OFL text comes from the `@fontsource-variable` packages. KaTeX's fonts are not emitted. |
| Native code | Claude Code `claude.exe` (Anthropic-signed); Cursor `cursorsandbox.exe` (unsigned) plus ripgrep 14.1.1-cursor3 and tree-sitter/tree-sitter-bash bindings, shipped without notices by Cursor; Codex 0.163.0 executables and ripgrep 15.2.0; node-pty, winpty and Microsoft ConPTY; sherpa-onnx 2.0.0 with ONNX Runtime 1.28.2 (its MIT license and third-party notices are supplied). The macOS tarballs carry the same components as Mach-O files. |
| Excluded | Codex's voice runtime: LGPL-2.1 GStreamer/GLib/libintl, libffi, PCRE2, Opus, zlib and, on Windows, Microsoft's `vcruntime140.dll`, whose notice says Microsoft's runtime terms alone do not grant redistribution. Foreman does not use Codex voice. `build.files` leaves out `codex-resources/voice/**`; the hook fails if it reappears. A copy of `codex.exe` without it printed its version and ran `codex exec` through startup to the expected 401 without credentials (Windows only; no authenticated turn). |
| Downloaded models | The speech model is not in the installer. It is downloaded on the user's consent from Hugging Face `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26`, pinned to `672fbf1b30579d6585301139bb363f42a0ad4a24`, which is tagged Apache-2.0. |
| Signing | With no certificate configured, electron-builder's signtool pass left the vendor executables byte-identical; `claude.exe` keeps Anthropic's valid signature. A real Windows certificate or macOS signing was not tested and may re-sign nested binaries. |
| Electron | `LICENSE.electron.txt` and `LICENSES.chromium.html` ship beside the app. Electron's own `ffmpeg.dll` (LGPL build) and Microsoft DirectX compiler DLLs come with Electron and were not reviewed separately. |

### Owner decisions and remaining work

These need the owner, not a packaging change made on their behalf:

1. **Claude Agent SDK and Claude Code binary.** Anthropic's legal page
   (checked 26 October 2026) says preinstalling or running Claude Code in a
   product requires agreeing to the Commercial Terms, shipping the binary
   unmodified with every built-in sign-in method intact, and having each end
   user authenticate with their own credentials. Accepting those terms is the
   owner's decision. The same page says developers using the Agent SDK should
   use API keys and "may not collect, store, or intermediate Claude.ai
   credentials or session tokens". Local sign-in runs the binary's own
   `auth login`, but cloud workspaces store a `claude setup-token` token in
   Foreman's vault and inject it as `CLAUDE_CODE_OAUTH_TOKEN`; confirm that with
   Anthropic or limit cloud workspaces to API keys. Confirm too whether
   re-signing nested binaries for macOS notarization counts as modification.
2. **Cursor SDK.** Its `LICENSE.md` points to Cursor's Terms of Service (last
   updated 3 September 2026), which grant a limited right to access and use the
   Service and prohibit reproducing it; they give no redistribution grant. The
   platform package declares a `LICENSE.md` it does not contain. Redistribution
   needs written permission from Anysphere.
3. **Packaging alternative for both.** Without those permissions, stop bundling
   the SDKs: load them from a user-installed location, or install them on first
   use with the user's consent (as the speech model is downloaded). That
   changes `src/main/agents/claude.ts`, `cursor.ts`, `platform.ts` and
   `cursorWorker.ts` and the onboarding flow; it is proposed, not implemented.
4. **elkjs corresponding source.** The notices name the elkjs 0.9.3 release
   commit, but the EPL object code is GWT-compiled from ELK Java sources whose
   exact revision elkjs does not pin (its build takes `../elk`). The owner must
   choose between hosting a verified source archive (or written offer) and
   removing elk layouts, which would mean patching Mermaid's internal chunk.
   web-push ships as unmodified source in `app.asar`, now with the MPL-2.0 text.
5. **Statically linked code inside vendor binaries.** The npm packages publish
   no notices for the Rust crates in Codex and ripgrep, the runtime inside
   `claude.exe`, Cursor's binaries or sherpa-onnx's static dependencies.
   ConPTY 1.23.251008001 is not listed on nuget.org; the package family is MIT
   from microsoft/terminal, whose v1.23 license is supplied.
6. **Release artifacts.** Run the hook's checks on each platform's real
   installer (macOS DMG, signed Windows NSIS) and inspect the result; this
   review packaged only the unpacked Windows x64 directory.

The license check cannot establish ownership of original source or clear copied
material. Source provenance is a separate question; removing a product name is
not evidence of permission or independent authorship.

## References

- [MPL FAQ: executable distribution and larger works](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [EPL-2.0 text](licenses/elkjs.txt)
- [Anthropic: legal agreements, product embedding and authentication](https://code.claude.com/docs/en/legal-and-compliance)
- [Cursor terms](https://cursor.com/terms-of-service)
- [Khroma release-source license](https://github.com/fabiospampinato/khroma/blob/4968165afb0d3d09be66497e7985a34f7bfe6d42/license)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [Codex 0.163.0 release source, including `third_party/voice/`](https://github.com/openai/codex/tree/rust-v0.163.0)
- [ONNX Runtime 1.28.2 license and third-party notices](https://github.com/microsoft/onnxruntime/tree/v1.28.2)
- [Visual C++ redistribution information](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)

This records the evidence and its scope, not a blanket compatibility or
redistribution certification. Recheck vendor terms and exact package evidence
when dependencies or distribution plans change.
