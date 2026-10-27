# Changelog

Notable changes to Foreman, newest first. Versions follow [semver](https://semver.org/); see "Releases" in [docs/maintenance.md](docs/maintenance.md) for how a release is made.

## 1.0.1 (2026-10-27)

### Fixed

- Plans from ACP agents (such as OpenCode) show in the chat again. The ACP SDK 2.0 bump had dropped the `plan_update` messages they're sent in. ([#32](https://github.com/elite-build/foreman/pull/32))
- The macOS app is ad-hoc signed, so a downloaded DMG can be opened with **Open Anyway** instead of being killed at launch. ([#31](https://github.com/elite-build/foreman/pull/31))

### Changed

- Electron 45 (from 44.9.3). ([#1](https://github.com/elite-build/foreman/pull/1))
- `@agentclientprotocol/sdk` 2.0.1 (from 1.8.0). Foreman uses its `/unstable` entry point, which matches how 1.8 behaved. ([#2](https://github.com/elite-build/foreman/pull/2), [#32](https://github.com/elite-build/foreman/pull/32))
- `lucide-react` 1.61.0 (from 1.57.0) and `@babel/parser` 8.0.7 (from 7.29.9). ([#3](https://github.com/elite-build/foreman/pull/3), [#5](https://github.com/elite-build/foreman/pull/5))
- A shorter README with screenshots. ([#30](https://github.com/elite-build/foreman/pull/30))

### Development

- `@types/node` stays on 22.x, the oldest Node Foreman supports (a bump to 26.x was reverted). ([#4](https://github.com/elite-build/foreman/pull/4), [#32](https://github.com/elite-build/foreman/pull/32))
- The viewed-marks test no longer fails on fast machines. ([#32](https://github.com/elite-build/foreman/pull/32))

## 1.0.0 (2026-10-27)

First release. Highlights:

- Foreman tells you when a newer version is released, and shows the running version in the sidebar footer. ([#27](https://github.com/elite-build/foreman/pull/27), [#28](https://github.com/elite-build/foreman/pull/28))
- CPU and memory stay flat when many agents run in parallel. ([#25](https://github.com/elite-build/foreman/pull/25))
- Tighter local CLI socket authorization and bridge input checks. ([#14](https://github.com/elite-build/foreman/pull/14))
- Screen capture stays refused when Electron reports it as display capture. ([#17](https://github.com/elite-build/foreman/pull/17))
- The vulnerable `zod` is out of the Vercel sandbox auth chain. ([#13](https://github.com/elite-build/foreman/pull/13))
- Composer and Daytona sandbox fixes on macOS. ([#7](https://github.com/elite-build/foreman/pull/7), [#9](https://github.com/elite-build/foreman/pull/9), [#10](https://github.com/elite-build/foreman/pull/10))
- A release process, manually started installer builds for macOS and Windows, and third-party notices generated from the packaged app. ([#12](https://github.com/elite-build/foreman/pull/12), [#24](https://github.com/elite-build/foreman/pull/24), [#26](https://github.com/elite-build/foreman/pull/26))

Full list: [v1.0.0 release](https://github.com/elite-build/foreman/releases/tag/v1.0.0).
