# Security policy

## Supported versions

Security fixes are supported for the 0.95.x release line.  Install the latest available 0.95.x patch release.  Earlier previews and unreleased development snapshots are not supported release lines.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/adachis/riosoma/security/advisories/new) on the public Riosoma repository.  You can also open the repository's Security page and choose Report a vulnerability.  GitHub explains the process in its [private reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Do not put vulnerability details, exploits, or sensitive data in a public issue.  If the private reporting form is unavailable, open an issue asking maintainers to enable private vulnerability reporting, without describing the vulnerability.

Include:

- The affected version, installation method, and relevant configuration
- A description of the vulnerability and who could exploit it
- Reproduction steps or a small proof of concept using synthetic data
- The expected and actual behavior, affected permissions, and possible impact
- Redacted logs or screenshots, and any proposed fix or workaround

Leave out passwords, tokens, private records, and other people's personal information.  Test only on systems you own or have permission to assess.

## What to expect

Maintainers will review the private report, try to reproduce it, and discuss impact and a fix with you in the advisory.  The target is an initial response within five business days and a progress update at least every 15 business days while a confirmed report remains open.  These are response goals, not guaranteed deadlines.

For confirmed vulnerabilities, maintainers will coordinate a patch, any available mitigation, and public disclosure with you.  Fix timing depends on impact and complexity.  Reporter credit will be discussed before publication.  Keep details private until coordinated disclosure so operators have a chance to update.

For installation and backup guidance, see the [install guides](docs/install/README.md) and [upgrades, backups, and rollbacks](docs/install/upgrades.md).  Ordinary bugs belong in [GitHub Issues](https://github.com/adachis/riosoma/issues).
