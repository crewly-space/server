# Installer security

- Release archives are verified against a published SHA-256 manifest before extraction.
- Linux services run as an unprivileged `opencrew` user with a private data directory.
- The systemd unit blocks home access, system writes, privilege gain, and shared temporary directories.
- The Docker image runs as a non-root distroless user.
- Installer overrides are environment variables; normal installation does not write an `.env` file.

Release signing is the next hardening step after the organization chooses a signing identity. Checksums protect against corrupted assets but are not a substitute for signed provenance.
