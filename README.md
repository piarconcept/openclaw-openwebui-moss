# OpenClaw Open WebUI Moss

Secure OpenClaw plugin and sidecar bridge that connects Open WebUI channels to multiple Moss agents with explicit allowlists, deterministic routing, streamed attachments, loop protection, automatic bot authentication, and operational observability.

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

- `src/config.ts`: strict config normalization plus runtime validation
- `src/api/webui-auth.ts`: Open WebUI bot authentication and in-memory token refresh
- `src/realtime/socket.ts`: Socket.IO connection and early event filtering
- `src/security/*`: allowlists, mention gating, rate limiting, loop protection
- `src/routing/*`: deterministic one-agent resolution and message pipeline
- `src/attachments/*`: bounded streaming plus cleanup
- `src/api/*`: Open WebUI and OpenClaw HTTP clients

## Security Model

The plugin fails closed by default.

Controls enforced:

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
- automatic Open WebUI session token caching in memory only
- no session token persistence to disk
- no secret logging for `auth.password`, `auth.token`, or refreshed session tokens
- automatic re-authentication on REST `401` with a single retry
- Socket.IO reconnect attempts capped to avoid infinite loops

## Authentication Modes

The plugin supports two Open WebUI auth modes.

Production mode:

- `auth.mode = "password"`
- use a dedicated Open WebUI bot account
- the plugin logs in with email/password
- Open WebUI returns a session token
- the plugin caches that token in memory only
- on REST `401`, the plugin re-authenticates once and retries the request
- on Socket.IO reconnects, the plugin refreshes the session token before rejoining

Testing mode only:

- `auth.mode = "token"`
- use a manually supplied bearer token
- intended for local testing and controlled troubleshooting
- if the token is rejected, the plugin disables itself safely because the token cannot be renewed automatically

Recommended operational model:

- create a dedicated low-privilege bot account in Open WebUI
- store the bot password in your secrets manager or deployment environment
- keep `allowedChannels` and `allowedUsers` narrow per client
- keep `botUserId` aligned with the dedicated bot account used for login

## Configuration

Runtime config is read from `OPENWEBUI_MOSS_CONFIG_PATH` and must match the schema exported in `openclaw.plugin.json`.

The plugin is zero-config friendly at install time. If the config is missing or incomplete, it does not crash OpenClaw. Instead it logs:

- `Moss plugin installed but not configured`
- `Moss plugin installed. Configure it in OpenClaw UI or openclaw.json`

Create `config/plugin.config.json` from `config/plugin.config.example.json` before enabling the bridge.

Production example using password auth:

```json
{
  "baseUrl": "https://openwebui.example.com",
  "auth": {
    "mode": "password",
    "email": "bot@example.com",
    "password": "replace-with-bot-password"
  },
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

Local testing example using token auth:

```json
{
  "baseUrl": "https://openwebui.example.com",
  "auth": {
    "mode": "token",
    "token": "replace-with-testing-token"
  },
  "botUserId": "replace-with-open-webui-bot-user-id",
  "requireMention": true,
  "allowedChannels": ["channel-editorial"],
  "allowedUsers": ["user-editor-1"],
  "agents": {
    "editorial": {
      "channelId": "channel-editorial",
      "trigger": "@moss-editorial",
      "agentId": "moss-editorial"
    }
  },
  "attachments": {
    "enabled": false,
    "maxBytes": 10485760,
    "tempDir": "/tmp/openclaw-openwebui-moss"
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
node dist/standalone.js
```

## Deployment

Build and run with Docker Compose:

```bash
docker compose up -d --build
```

The compose file includes `host.docker.internal:host-gateway` so the container can reach a local OpenClaw instance on Linux hosts.

## Testing

Vitest coverage currently focuses on the policy-critical and auth-critical paths:

- config validation for token and password auth modes
- successful password-mode login
- REST re-authentication on `401`
- plugin disabled mode on auth failure
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
- Password auth depends on the Open WebUI signin endpoint remaining available for bot automation

## Why this plugin is safer than naive implementations

Naive integrations usually fail in one or more of these ways:

- they accept messages from any user in any reachable channel
- they trust mention-like text without deterministic routing
- they buffer attachments entirely in memory
- they skip temp-file cleanup
- they only protect against loops by checking author ID
- they rely on long-lived manually rotated session tokens without controlled refresh
- they log credentials or raw payloads too freely

This implementation is stricter:

- channel and user allowlists are mandatory
- mention gating is optional but explicit and exact
- routing resolves to one agent or rejects the message
- attachments are streamed and capped
- outbound replies are tagged and cached for loop suppression
- password-mode auth refreshes automatically in memory without persisting session tokens
- token-mode auth is explicitly downgraded to testing-only use
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

## OpenAI-Compatible Provider

This repository now also ships a standalone OpenAI-compatible provider for Open WebUI.

Provider endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

The provider is filesystem-driven. Models are discovered from:

```text
~/.openclaw/workspace/moss-models/
```

Each model lives in its own folder:

```text
moss-models/
  moss-dev/
    IDENTITY.md
    config.json
    docs/
      coding-guidelines.md
      architecture.md
  moss-editorial/
    IDENTITY.md
    style-guide.md
```

Rules:

- folder name becomes `model.id`
- `IDENTITY.md` is required
- `config.json` is optional and may define `agentId` and `limits.maxContextBytes`
- `.md` and `.txt` files are indexed recursively as plain context
- invalid folders are skipped with a warning
- no hardcoded system prompt is used in code

### Provider Model Config

Optional `config.json` example:

```json
{
  "agentId": "moss-dev",
  "limits": {
    "maxContextBytes": 51200
  }
}
```

### Provider Prompt Construction

For `POST /v1/chat/completions`, the provider:

1. reloads models from disk
2. validates that the requested model exists
3. reads the last user message from the OpenAI request
4. builds a prompt as:

```text
IDENTITY.md

Context:
<concatenated .md/.txt files>

User:
<last user message>
```

5. sends that prompt to OpenClaw `POST /api/chat`
6. returns an OpenAI-compatible `chat.completion` response

### Provider Usage

Run the provider locally:

```bash
export OPENCLAW_API_URL=http://127.0.0.1:3000/api/chat
export MOSS_MODELS_DIR=$HOME/.openclaw/workspace/moss-models
export MOSS_PROVIDER_PORT=4000
corepack pnpm build
node dist/provider-standalone.js
```

Development mode:

```bash
corepack pnpm dev:provider
```

The provider rescans the models directory on each request, so dropping or editing files changes model behavior without code changes or a server restart.
