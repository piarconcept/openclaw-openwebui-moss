# Changelog

## [0.1.0] - 2026-04-22

### Added

- Initial production-focused implementation plan and project scaffold
- Secure allowlist enforcement for channels and users
- Mention gating and deterministic one-agent routing
- Loop protection with `botUserId`, outbound message tagging, and correlation IDs
- Basic in-memory rate limiting per user/channel window
- Streamed attachment handling with byte caps and cleanup
- Vitest coverage for config, security, mention policy, and routing
- Dockerfile and docker-compose deployment assets
