# Installer security

- Release archives are verified against a published SHA-256 manifest before extraction.
- Linux services run as an unprivileged `crewly` user with a private data directory.
- The systemd unit blocks home access, system writes, privilege gain, and shared temporary directories.
- The Docker image runs as a non-root Node user.
- Installer overrides are environment variables; normal installation does not write an `.env` file.

Server releases include an Ed25519 signature over the final checksum manifest. The CLI verifies that signature using its pinned public key. Routine releases must retain the existing signing identity.
