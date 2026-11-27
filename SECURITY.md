# Security

## Supported versions

Security fixes go into the next release, made from `main`. Only the latest published release is supported: there are no maintained older release lines, and a fix is never backported. Installed copies offer each new release by themselves ([Updates](README.md#updates)), so staying supported means installing the update when Foreman offers it. Prereleases on the Beta channel are supported until the release they lead to is published.

| Version | Supported |
| --- | --- |
| The latest release on the [releases page](https://github.com/elite-build/foreman/releases/latest) | Yes |
| Any earlier release | No: update to the latest |
| A build from source or from a branch | No, unless the problem is also in the latest release |

## Reporting a vulnerability

Use the repository's [**Security → Report a vulnerability**](https://github.com/elite-build/foreman/security/advisories/new) form (GitHub private vulnerability reporting). It is turned on for the repository, but whether it appears to someone without write access has not yet been confirmed ([maintenance controls](docs/maintenance.md)). Do not open a public issue or pull request containing an exploit, credential, private repository content or personal data. If the form is not shown, open an issue that only asks a maintainer for a private contact and contains no vulnerability details. No dedicated security email address is published.

Include the affected version or commit, operating system, a minimal reproduction with synthetic data, and expected versus observed behavior. Never send working credentials.

## What happens next

These response targets are **proposed and not yet confirmed by the maintainer**; until they are, treat them as intentions rather than commitments.

| Step | Proposed target |
| --- | --- |
| Acknowledge the report | Within 3 business days |
| First assessment: confirmed or not, severity, affected versions | Within 10 business days |
| Fix released for a critical or high severity issue | Within 30 days of confirmation |
| Fix released for a medium or low severity issue | In a following release, normally within 90 days |
| Public advisory | When the fix is released, or after 90 days if agreed with the reporter |

The maintainer keeps the reporter informed in the private advisory, agrees a disclosure date with them, and credits them in the advisory and release notes unless they prefer not to be named. A fixed vulnerability is published as a GitHub security advisory, with a CVE when one applies, and listed under **Security** in the release's notes. If a release itself turns out to be harmful, the steps in [A bad release](docs/maintenance.md#a-bad-release) stop it reaching more users.

## Safe harbour

Research carried out in good faith under this policy is welcome. If you make a good-faith effort to follow it, the maintainers will not pursue or support legal action against you for that research, and will say so if anyone else asks. Good faith means: test only against your own installation, your own accounts and your own repositories; don't access, change or keep anyone else's data, and stop and report as soon as you come across any; don't degrade services Foreman connects to (GitHub, model providers, sandbox providers and others), and follow their own rules for testing them; and give the maintainers reasonable time to release a fix before you disclose. This statement covers only Foreman's maintainers; it can't authorize testing of third-party services or waive anyone else's rights. If you are unsure whether something is in scope, ask through the report form first.

## Signed releases

The [code signing policy](CODE_SIGNING.md) says which release files are signed, by whom, and how to verify a download. Every file attached to a release also carries a build provenance attestation from the release workflow, which `gh attestation verify <file> --repo elite-build/foreman` checks ([build provenance](docs/maintenance.md#build-provenance)). Report a binary signed for Foreman that this repository's release workflow did not build, or any other misuse of a signing certificate, as above. Once Windows releases are signed through SignPath Foundation, also report it to SignPath at support@signpath.io, who can revoke the certificate.

## Scope

Foreman executes repository scripts and coding tools with the permissions of the signed-in operating-system user. Review repositories, setup commands, integrations and tool approvals before execution. Agent plan mode is not a general operating-system sandbox. Remote sandboxes and model providers use your accounts and their security boundaries. [What leaves your computer](docs/privacy.md) lists every service Foreman itself contacts.

Passing the repository's checks does not constitute a complete application security review.
