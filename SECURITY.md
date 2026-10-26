# Security

Use the repository's **Security → Report a vulnerability** form when it is available. Do not open a public issue or pull request containing an exploit, credential, private repository content or personal data. If the form is unavailable, ask a maintainer for a private contact without disclosing the vulnerability. A verified reporting channel must be established before a public release.

Include the affected version or commit, operating system, a minimal reproduction with synthetic data, and expected versus observed behavior. Never send working credentials. Maintainers should acknowledge the report, agree on a private investigation and disclosure timeline, and publish remediation guidance when ready. No response-time commitment is established yet.

Foreman executes repository scripts and coding tools with the permissions of the signed-in operating-system user. Review repositories, setup commands, integrations and tool approvals before execution. Agent plan mode is not a general operating-system sandbox. Remote sandboxes and model providers use your accounts and their security boundaries.

The current development branch has no established supported release series or binary-signing policy. CI passing does not constitute a complete application security review. Release support and reporting availability must be verified before distribution.
