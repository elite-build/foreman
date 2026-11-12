# Code signing policy

| | |
| --- | --- |
| Project | Foreman |
| Repository | [elite-build/foreman](https://github.com/elite-build/foreman) |
| License | [Apache License 2.0](LICENSE) (see [NOTICE](NOTICE)) |
| Windows signing provider | [SignPath Foundation](https://signpath.org), through [SignPath.io](https://signpath.io): **application pending** |
| macOS signing | Apple Developer ID, signed and notarized ([macOS signing and notarization](docs/maintenance.md#macos-signing-and-notarization)) |

**Status.** Foreman has not yet been accepted by SignPath Foundation, and **its Windows releases are not code-signed**. Windows SmartScreen warns when the installer is first run. The release workflow is ready to sign them, but signing stays off until the application is approved and the setup in [Turning signing on](#turning-signing-on) is done. Until then nothing here means that a Windows binary is signed. Once it is approved, Windows releases will carry this attribution:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

Only binaries built from this repository by its own release workflow are signed, and only for a version tag on `main`:

| File | When it is signed |
| --- | --- |
| `Foreman.exe`, the application executable | After the app is built and **before** it is packaged into the installer, so the installed copy is signed too |
| `Foreman-Setup-<version>.exe`, the NSIS installer | After it is built from the signed application |

Both are signed by SignPath with the same SignPath Foundation certificate, a SHA-256 file digest and an RFC 3161 timestamp.

Not signed with Foreman's certificate:

- **Upstream binaries shipped unchanged inside the app.** These are Electron's runtime libraries, node-pty with winpty and ConPTY, ONNX Runtime and sherpa-onnx, electron-builder's `elevate.exe`, and the coding agents' executables: Claude Code's `claude.exe`, Codex's executables, and Cursor's `cursorsandbox.exe` with ripgrep. SignPath Foundation's terms allow them inside a signed package but not signed as Foreman's. Some, such as `claude.exe`, `codex.exe` and ConPTY, already carry their vendors' signatures; the rest are unsigned. See [dependency licenses](docs/dependency-licenses.md) for what ships.
- **The uninstaller inside the installer.** electron-builder generates it and embeds it while it builds the installer, so there is no point at which SignPath could sign it.
- **The macOS app**, which Apple's Developer ID process signs (above), and the Linux AppImage, which isn't published.

## Team and roles

SignPath Foundation requires these roles. Foreman currently has one maintainer, who holds all three.

| Role | Who | Responsibility |
| --- | --- | --- |
| Committers (authors) | [Members of elite-build with write access](https://github.com/orgs/elite-build/people): Yatin Chaubal ([@YatinChaubal](https://github.com/YatinChaubal)) | May change the source, including build scripts and workflows, through pull requests to `main`. Prepare each release: the version bump, the tag and the Release workflow run. |
| Reviewers | [Members of elite-build with write access](https://github.com/orgs/elite-build/people): Yatin Chaubal | Review every pull request before it merges. `main` is protected by a ruleset requiring a pull request with an approving review ([maintenance controls](docs/maintenance.md)). Build scripts, `package.json`'s `build` section and `.github/workflows/` are source code and get the same review: they decide what is signed. |
| Approvers | [Owners of elite-build](https://github.com/orgs/elite-build/people?query=role%3Aowner): Yatin Chaubal | Approve or reject every signing request in SignPath. Approve only a request that came from the Release workflow for a `v<version>` tag on `main`, whose version and files are the ones expected, and reject anything else. |

Every team member must use multi-factor authentication for GitHub and for SignPath. Signing permissions, roles and approvers are changed only by the owners.

## Privacy

Foreman runs on your computer. It has no Foreman account, no Foreman service and no telemetry: its measurements stay on your computer ([local telemetry](docs/telemetry.md)). It connects to other systems in these cases:

- **The services you set up.** The coding agents and model providers you sign in to, and the integrations you configure: GitHub, GitLab, Linear, Slack, remote sandboxes (Vercel, Docker, E2B, Daytona) and MCP servers. What is sent, and under whose privacy policy, is between you and those services. The bundled agents (Claude Code, Codex, Cursor) are third-party programs that connect to their own providers under those providers' terms when you use them.
- **Update checks.** Foreman asks `api.github.com` whether a newer release of `elite-build/foreman` exists: a few seconds after it starts, when the computer wakes, and every few hours. Each check is one unauthenticated request, and GitHub sees your IP address and Foreman's version. It is on by default and can be turned off in **Settings → General → Updates** (see [Updates](README.md#updates)).
- **Phone and browser access**, only when you turn it on and pair a device.

Foreman sends no other information to any networked system unless you, or the person installing or running it, ask it to.

## How a release is built, signed and published

```text
v<version> tag on main
└─ Release workflow (.github/workflows/release.yml), started by hand on the tag
   ├─ Verify tag: the tag names package.json's version and is on main; reads SIGNPATH_SIGNING once
   ├─ Installers (.github/workflows/installers.yml): GitHub-hosted runners, read-only token
   │  ├─ macOS: Developer ID signed and notarized (docs/maintenance.md)
   │  └─ Windows, with sign-windows:
   │     1. build the app into dist/win-unpacked (electron-builder --win dir)
   │     2. upload Foreman.exe as the run artifact unsigned-windows-app
   │     3. SignPath signing request (artifact configuration windows-app); an approver approves it;
   │        SignPath fetches the artifact from GitHub, signs it and returns it
   │     4. check the signed Foreman.exe with SignTool (scripts/verify-windows-release.ps1)
   │     5. put it back and build the installer from the app as it is (electron-builder --prepackaged)
   │     6. upload the installer as unsigned-windows-installer
   │     7. SignPath signing request (artifact configuration windows-installer); approved; signed installer returned
   │     8. recompute latest.yml and the blockmap for the signed installer (scripts/windows-update-feed.mjs)
   │     9. check the installer, the Foreman.exe inside it (same certificate) and latest.yml with SignTool
   │    10. upload Foreman-Windows-x64: the installer, its blockmap and latest.yml
   └─ Draft release: the only job with a write token; checks nothing out and runs no repository code.
      Attaches every installer, the update files and SHA256SUMS.txt (computed from the signed files) to a draft
└─ A maintainer reviews the draft and publishes it
```

The steps in full are under [Releases](docs/maintenance.md#releases). The parts that concern signing:

- **Origin.** SignPath signs only files it downloads itself from the workflow run's artifacts, after checking with GitHub which repository, workflow, commit and runner built them. Signing keys never reach GitHub; SignPath holds them. The intermediate artifacts are deliberately not named `Foreman-*`, so the draft release, which attaches every `Foreman-*` artifact, can never pick up an unsigned file.
- **Approval.** Each release makes two signing requests, one for `Foreman.exe` and one for the installer, and each waits up to an hour for an approver. Nothing is signed without an approval.
- **Restrictions.** The artifact configurations in [`.signpath/artifact-configurations/`](.signpath/artifact-configurations/) name the one file each request may sign and require its product name to be `Foreman` and its product version to be the release's version. SignPath keeps the configuration it applies; these copies are for review and must be kept the same.
- **Digest and timestamp.** The artifact configurations ask for SHA-256. SignPath adds the timestamp itself, and the verification fails unless it is an RFC 3161 timestamp.
- **Verification before publication.** `scripts/verify-windows-release.ps1` runs Microsoft's SignTool (`signtool verify /pa /tw /v`) on each file and reads each signature itself. It requires a valid signature chaining to a trusted root, a SHA-256 file digest, the signer `SignPath Foundation`, an RFC 3161 timestamp, the same certificate on `Foreman.exe` and the installer, and a `latest.yml` matching the signed installer. The Windows artifact is uploaded only after it passes.
- **Update feed.** Installed copies check a downloaded update against the SHA-512 and size in `latest.yml` (electron-updater). Signing changes the installer's bytes, so the workflow recomputes `latest.yml` and the blockmap with electron-builder's own code after signing.
- **Checksums.** `SHA256SUMS.txt` is computed in the draft-release job from the files as published, so it covers the signed installer.

### Failures

There is no unsigned fallback once signing is on. If the SignPath settings are missing, a request is rejected or times out, SignPath is unavailable, or any verification fails, the Windows job fails, no `Foreman-Windows-x64` artifact is made and the Release workflow creates no draft. Fix the cause and run the failed jobs again; a rerun makes new signing requests, which need approving again. If SignPath's `disallow_reruns` policy is turned on for the project, start a new run of the Release workflow instead. A tag that already has a release, draft or published, is refused as before.

While `SIGNPATH_SIGNING` is not `true`, releases are built exactly as before with an unsigned Windows installer, and the Release run says so in a warning and in its summary.

## Verifying a download

Check the file against the release's `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Foreman-Setup-<version>.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
```

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

For a release signed through SignPath, check the signature on Windows. In File Explorer, open the file's **Properties → Digital Signatures**. From PowerShell:

```powershell
Get-AuthenticodeSignature .\Foreman-Setup-<version>.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

`Status` must be `Valid`, the signer's subject must name `SignPath Foundation`, and there must be a timestamp certificate. With the Windows SDK, `signtool verify /pa /v .\Foreman-Setup-<version>.exe` shows the certificate chain, the SHA-256 file hash and the timestamp. Run the same check on `Foreman.exe` in the installation folder. From a checkout, `powershell -File scripts/verify-windows-release.ps1 -Publisher 'SignPath Foundation' -Folder <folder>` runs every check the release workflow runs, on a folder holding the installer, its blockmap and `latest.yml`. Each signed release's assets are uploaded by a run of the Release workflow, listed under the repository's **Actions** tab, and SignPath keeps the matching signing requests.

## Turning signing on

Signing needs SignPath Foundation's approval first; none of this works with a self-signed or test certificate, and the verification rejects one.

1. **Apply** at [signpath.org/apply](https://signpath.org/apply) with this repository. Meet the [conditions](https://signpath.org/terms.html), including the open items below.
2. **In SignPath**, once approved:
   - Add the predefined **GitHub.com** trusted build system to the organization and link it to the Foreman project. Install the SignPath GitHub App on this repository.
   - Create two artifact configurations from [`windows-app.xml`](.signpath/artifact-configurations/windows-app.xml) and [`windows-installer.xml`](.signpath/artifact-configurations/windows-installer.xml).
   - Use the signing policy with the SignPath Foundation certificate. Require manual approval, with the approvers above. Set GitHub policies that fit this workflow: `runners.required_github_hosted`, and branch-ruleset constraints matching **Protect main**.
   - Create a CI user with the submitter role on that project and policy, and an API token for it.
3. **In GitHub** (Settings → Secrets and variables → Actions):

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | The SignPath organization ID |
   | Variable | `SIGNPATH_PROJECT_SLUG` | The project's slug |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | The signing policy's slug |
   | Variable | `SIGNPATH_APP_CONFIGURATION_SLUG` | The slug of the configuration made from `windows-app.xml` |
   | Variable | `SIGNPATH_INSTALLER_CONFIGURATION_SLUG` | The slug of the configuration made from `windows-installer.xml` |
   | Variable | `SIGNPATH_SIGNING` | `true`, last, to turn signing on for releases |

   Never commit a token, certificate or key; `.gitignore` and `npm run check:repository` reject key and certificate files. Only the Windows job's two signing steps receive the token. It is a repository secret, so any workflow on any branch could read it, but every request still needs an approver and must come from this repository's workflow. Moving it into a GitHub environment that only `v*` tags may deploy to, as recommended for the Apple secrets, would narrow that further.
4. **Try it** before a release: `gh workflow run installers.yml --ref <branch> -f sign-windows=true` runs the signed Windows build (the variables must be set; `SIGNPATH_SIGNING` need not be). Approve the two requests and check the artifact.
5. **Then**: add the attribution above to the release notes, alongside a link to this page, and update [README.md](README.md#install), [docs/windows.md](docs/windows.md) and this page's status.

### Open items before applying

- **Privacy notice in the installer.** SignPath Foundation's terms ask software that sends data to systems the user did not choose to describe this in a privacy policy, show it during installation and let it be turned off. The update check can be turned off and is described above, but the installer doesn't show it yet.
- **Executable metadata.** `package.json` has no `author`, so electron-builder leaves Electron's default company name, `GitHub, Inc.`, in `Foreman.exe`, and the installer has none. Setting `author` (for example to `Yatin Chaubal`, as in [NOTICE](NOTICE)) would also change the copyright line and the installer's publisher, so it is the owner's decision.
- **Multi-factor authentication.** The elite-build organization does not yet require two-factor authentication ([GitHub settings](docs/maintenance.md#github-settings-observed-on-2026-10-26)).
