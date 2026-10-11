# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/crewly-space/server/security/advisories/new).
Please do not open a public issue for a security problem.

Include the affected version, what an attacker can do, and the smallest set of
steps that reproduces it. We aim to acknowledge a report within three working
days and to keep you updated until it is resolved.

## Supported versions

Crewly is pre-1.0. Fixes land on `main` and in the next tagged release; there
is no long-term support branch yet.

## What the server does today

- Session tokens are random 32-byte values, stored only as SHA-256 digests.
- WebSocket sessions are revalidated before event delivery and periodically while idle.
  Logout, password changes, suspension, and deletion revoke affected open connections;
  removing a group participant removes their conversation subscription.
- The default MCP HTTP transport validates all DNS answers and pins outbound connections
  to a validated address, including IPv4-mapped IPv6. Private networks require the
  explicit `CREWLY_ALLOW_PRIVATE_NETWORK` opt-in; injected transports are trusted overrides.
- Relaxing tool policies or remembering a tool approval requires `integrations.manage`.
  Members may only tighten existing agent policies; replacements that relax effective
  access are rejected atomically.
- Passwords are hashed with scrypt and compared in constant time.
- Setup and login are rate limited per client address.
- Responses carry a content security policy, `nosniff`, `frame-ancestors 'none'`,
  a referrer policy, and a permissions policy. Request bodies are capped at 1 MB.
- No cross-origin requests are permitted; the app is served same-origin.
- The container image runs as a non-root user with a read-only root filesystem,
  all capabilities dropped, and `no-new-privileges` set.

## Known gaps

These are tracked and deliberately not yet implemented:

- No email verification, password reset, or multi-factor authentication.
- The agentd pairing channel is unbuilt, so local runtime execution is pre-release.
- Releases are verified by SHA-256 checksum but are not yet signed.

Installer and deployment hardening is documented separately in the `infra`
repository.
