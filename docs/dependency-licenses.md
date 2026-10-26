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
   required copyright/license notice. The notices added in this change cover the
   reviewed exceptions; they are not a complete installer notice inventory.
4. Inspect the resulting package to confirm the notices and source information
   are included. The packaging file list includes this document and
   `docs/licenses/`, but configuration alone does not verify a release artifact.

The license check cannot establish ownership of original source or clear copied
material. Source provenance is a separate question; removing a product name is
not evidence of permission or independent authorship.

## References

- [MPL FAQ: executable distribution and larger works](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [EPL-2.0 text](licenses/elkjs.txt)
- [Anthropic: legal agreements, product embedding and authentication](https://code.claude.com/docs/en/legal-and-compliance)
- [Cursor terms](https://cursor.com/terms-of-service)
- [Khroma release-source license](https://github.com/fabiospampinato/khroma/blob/4968165afb0d3d09be66497e7985a34f7bfe6d42/license)

This records the evidence and its scope, not a blanket compatibility or
redistribution certification. Recheck vendor terms and exact package evidence
when dependencies or distribution plans change.
