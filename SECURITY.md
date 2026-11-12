# Security

## Reporting a vulnerability

Use the repository's [**Security → Report a vulnerability**](https://github.com/elite-build/foreman/security/advisories/new) form (GitHub private vulnerability reporting). It is turned on for the repository, but whether it appears to someone without write access has not yet been confirmed ([maintenance controls](docs/maintenance.md)). Do not open a public issue or pull request containing an exploit, credential, private repository content or personal data. If the form is not shown, open an issue that only asks a maintainer for a private contact and contains no vulnerability details. No dedicated security email address is published.

Include the affected version or commit, operating system, a minimal reproduction with synthetic data, and expected versus observed behavior. Never send working credentials. Maintainers should acknowledge the report, agree on a private investigation and disclosure timeline, and publish remediation guidance when ready. No response-time commitment is established yet.

## Signed releases

The [code signing policy](CODE_SIGNING.md) says which release files are signed, by whom, and how to verify a download. Report a binary signed for Foreman that this repository's release workflow did not build, or any other misuse of a signing certificate, as above. Once Windows releases are signed through SignPath Foundation, also report it to SignPath at support@signpath.io, who can revoke the certificate.

## Scope

Foreman executes repository scripts and coding tools with the permissions of the signed-in operating-system user. Review repositories, setup commands, integrations and tool approvals before execution. Agent plan mode is not a general operating-system sandbox. Remote sandboxes and model providers use your accounts and their security boundaries.

The current development branch has no established supported release series. Passing the repository's checks does not constitute a complete application security review. Release support and reporting availability must be verified before distribution.
