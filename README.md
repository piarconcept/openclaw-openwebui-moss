# OpenClaw Open WebUI Moss

Secure OpenClaw plugin and sidecar bridge that connects Open WebUI channels to multiple Moss agents with explicit allowlists, deterministic routing, streamed attachments, loop protection, and operational observability.

## Overview

This project is designed as a reusable product, not a one-off integration. It connects Open WebUI channels to OpenClaw, resolves each approved message to exactly one logical Moss agent, forwards the request to `POST /api/chat`, and posts the response back into the original Open WebUI channel or thread.

Supported logical agent identities out of the box:

- `moss-editorial`
- `moss-dev`
- `moss-operator`
- `moss-client`

The routing model is config-driven, so the same codebase can be reused across clients and channel topologies.

## Architecture

```text
Open WebUI Socket.IO
  -> early channel filter
  -> secure ingress router
  -> user allowlist
  -> channel allowlist
  -> mention policy
  -> loop protection
  -> rate limiter
  -> one-agent resolver
  -> streamed attachment download
  -> OpenClaw POST /api/chat
  -> streamed attachment upload
  -> Open WebUI reply post
```

Key modules:

- `src/config.ts`: strict config and runtime validation
- `src/realtime/socket.ts`: Socket.IO connection and early event filtering
- `src/security/*`: allowlists, mention gating, rate limiting, loop protection
- `src/routing/*`: deterministic one-agent resolution and message pipeline
- `src/attachments/*`: bounded streaming plus cleanup
- `src/api/*`: Open WebUI and OpenClaw HTTP clients

## Security Model

The plugin fails closed by default.

Controls enforced:

- Bearer token auth only for Open WebUI
- no password login path
- strict `allowedChannels`
- strict `allowedUsers`
- optional mention gating with `botUserId`
- rejection before routing and before attachment download
- one-agent resolution only; ambiguity is rejected
- loop protection with `botUserId`, outbound meta tagging, and recent outbound cache
- basic per-user-per-channel rate limiting
- streamed attachment downloads with `maxBytes` enforcement
- temp directory cleanup after each request and stale sweep on startup
- correlation-aware structured logging with secret redaction

## Configuration

Runtime config is read from `OPENWEBUI_MOSS_CONFIG_PATH` and must match the schema exported in `openclaw.plugin.json`.

Example `config/plugin.config.json`:

```json
{
  "baseUrl": "https://openwebui.example.com",
  "token": "replace-with-bearer-token",
  "botUserId": "replace-with-open-webui-bot-user-id",
  "requireMention": true,
  "allowedChannels": ["channel-editorial", "channel-dev", "channel-ops"],
  "allowedUsers": ["user-editor-1", "user-dev-1", "user-ops-1"],
  "agents": {
    "editorial": {
      "channelId": "channel-editorial",
      "trigger": "@moss-editorial",
      "agentId": "moss-editorial"
    },
    "dev": {
      "channelId": "channel-dev",
      "trigger": "@moss-dev",
      "agentId": "moss-dev"
    },
    "operator": {
      "channelId": "channel-ops",
      "trigger": "@moss-operator",
      "agentId": "moss-operator"
    },
    "client": {
      "trigger": "@moss-client",
      "agentId": "moss-client"
    }
  },
  "attachments": {
    "enabled": true,
    "maxBytes": 10485760,
    "tempDir": "/app/tmp/openclaw-openwebui-moss"
  },
  "rateLimit": {
    "enabled": true,
    "windowMs": 30000,
    "maxMessages": 12
  }
}
```

Required environment variables:

- `OPENWEBUI_MOSS_CONFIG_PATH`: path to plugin JSON config. Defaults to `config/plugin.config.json`.
- `OPENCLAW_API_URL`: full URL to OpenClaw `POST /api/chat`. Defaults to `http://127.0.0.1:3000/api/chat`.

Optional environment variables:

- `OPENCLAW_REQUEST_TIMEOUT_MS`: request timeout for `/api/chat`, default `60000`
- `ATTACHMENT_STALE_TTL_MS`: stale temp directory retention, default `86400000`
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`

## Usage

Local development:

```bash
corepack pnpm install
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Run as a Node 22 process:

```bash
export OPENWEBUI_MOSS_CONFIG_PATH=./config/plugin.config.json
export OPENCLAW_API_URL=http://127.0.0.1:3000/api/chat
node dist/index.js
```

## Deployment

Build and run with Docker Compose:

```bash
docker compose up -d --build
```

The compose file includes `host.docker.internal:host-gateway` so the container can reach a local OpenClaw instance on Linux hosts.

## Testing

Vitest coverage currently focuses on the policy-critical paths:

- config validation
- access control
- mention gating
- rate limiting
- loop protection
- agent routing

## Limitations

- Thread-to-agent bindings are in-memory for the current process lifetime
- Open WebUI server-side channel subscription controls may still be limited by the upstream API
- The plugin assumes OpenClaw exposes an HTTP `POST /api/chat` endpoint reachable from the process
- Response chunking is not implemented in this first release; very large replies depend on Open WebUI server behavior

## Why this plugin is safer than naive implementations

Naive integrations usually fail in one or more of these ways:

- they accept messages from any user in any reachable channel
- they trust mention-like text without deterministic routing
- they buffer attachments entirely in memory
- they skip temp-file cleanup
- they only protect against loops by checking author ID
- they log credentials or raw payloads too freely

This implementation is stricter:

- channel and user allowlists are mandatory
- mention gating is optional but explicit and exact
- routing resolves to one agent or rejects the message
- attachments are streamed and capped
- outbound replies are tagged and cached for loop suppression
- correlation IDs make operational tracing possible without exposing secrets

## Publishing Readiness

The repository includes:

- MIT license
- changelog
- Docker assets
- typed config schema
- strict TypeScript build
- lint and test scripts
- GitHub-ready structure
