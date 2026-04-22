# OpenClaw Open WebUI Moss Provider

OpenAI-compatible model provider for Open WebUI.

Open WebUI sees normal models through `GET /v1/models` and `POST /v1/chat/completions`, but each model is actually a filesystem-backed Moss profile that the provider translates into a call to OpenClaw `POST /v1/chat/completions`.

## Core Idea

```text
Open WebUI
  -> GET /v1/models
  -> POST /v1/chat/completions
  -> Moss provider
  -> load model folder from filesystem
  -> build prompt from IDENTITY.md + context files + user message
  -> OpenClaw POST /v1/chat/completions
  -> OpenAI-compatible response
```

The MVP is intentionally simple:

- models come from the filesystem, not JSON
- prompts come from files, not hardcoded strings
- context is basic `.md` and `.txt` concatenation
- the model identity is injected as a `system` message and the full OpenAI chat history is forwarded
- no embeddings
- no vector database
- no hot-reload daemon; the provider rescans on requests so filesystem changes are picked up automatically

## HTTP API

Required endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

Example `GET /v1/models` response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "moss-dev",
      "object": "model"
    },
    {
      "id": "moss-editorial",
      "object": "model"
    }
  ]
}
```

Example `POST /v1/chat/completions` request:

```json
{
  "model": "moss-dev",
  "messages": [
    {
      "role": "user",
      "content": "Review this architecture."
    }
  ]
}
```

## Model Registry

Models are discovered from:

```text
~/.openclaw/workspace/moss-models/
```

Each folder becomes one model:

```text
moss-models/
  moss-dev/
    IDENTITY.md
    docs/
      architecture.md
  moss-editorial/
    IDENTITY.md
```

Rules:

- folder name becomes `model.id`
- `IDENTITY.md` is required
- `.md` and `.txt` files are loaded recursively as extra context
- invalid model folders are skipped with a warning
- the provider scans the registry on startup
- the provider refreshes from disk when serving requests so new models can appear without restart

Optional `config.json` inside a model folder:

```json
{
  "agentId": "main",
  "limits": {
    "maxContextBytes": 51200
  }
}
```

`agentId` defaults to `main` when omitted.

## Prompt Construction

For a chat completion request, the provider:

1. Finds the requested model folder.
2. Loads `IDENTITY.md`.
3. Loads context files from the same folder tree.
4. Builds a `system` message from the model identity and context.
5. Forwards the full OpenAI `messages` history to OpenClaw, prepending that model `system` message.
6. Sends the request to OpenClaw `POST /v1/chat/completions` using the gateway model.
7. Returns the answer as an OpenAI-compatible `chat.completion` payload.

```text
System:
<IDENTITY.md>

Context:
<concatenated .md/.txt files>

Messages:
<full OpenAI chat history>
```

## Run Locally

Install and build:

```bash
corepack pnpm install
corepack pnpm build
```

Start the provider:

```bash
export OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions
export OPENCLAW_MODEL=openai-codex/gpt-5.4
export OPENCLAW_GATEWAY_TOKEN=your-openclaw-gateway-token
export MOSS_MODELS_DIR=$HOME/.openclaw/workspace/moss-models
export MOSS_PROVIDER_PORT=4000
node dist/provider-standalone.js
```

If `OPENCLAW_GATEWAY_TOKEN` is not set, the provider falls back to reading
`$OPENCLAW_CONFIG_PATH`, or `~/.openclaw/openclaw.json`, and uses
`gateway.auth.token` when the OpenClaw gateway is configured in token mode.

When the provider runs embedded as an OpenClaw plugin, it also reads its plugin
configuration from `plugins.entries.openclaw-openwebui-moss.config` inside
`$OPENCLAW_CONFIG_PATH` or `~/.openclaw/openclaw.json` by default.

Development mode:

```bash
corepack pnpm dev
```

## Open WebUI Setup

Configure this service in Open WebUI as an OpenAI-compatible provider pointing at this server.

Once connected, Open WebUI will see models such as:

- `moss-dev`
- `moss-editorial`
- any new folder added under `moss-models/`

Selecting one of those models in Open WebUI sends the chat request to this provider, which then routes it into OpenClaw.

When loaded as an OpenClaw extension through `activate()`, the embedded provider starts by default on `127.0.0.1:18790` unless `MOSS_PROVIDER_HOST` or `MOSS_PROVIDER_PORT` override it. If the legacy bridge config is missing or invalid, the plugin logs that it is running in fallback mode and keeps serving `GET /v1/models` and `POST /v1/chat/completions`.

## Docker

Build and run:

```bash
docker compose up -d --build
```

The included compose file:

- exposes port `4000`
- mounts `${HOME}/.openclaw/workspace/moss-models` into the container
- points to `http://host.docker.internal:18789/v1/chat/completions` for OpenClaw by default
- uses `openai-codex/gpt-5.4` as the default gateway model unless `OPENCLAW_MODEL` overrides it

## Project Defaults

The repo now defaults to the provider path:

- `pnpm dev` starts `src/provider-standalone.ts`
- `openclaw-openwebui-moss` runs the provider binary
- Docker starts `dist/provider-standalone.js`

Legacy channel-bridge code still exists in the repository, but it is not the primary MVP path for this project.

## Limitations

- only non-streaming `chat.completions` is implemented
- only the last user message is used when building the OpenClaw prompt
- context loading is plain file concatenation
- attachments, tools, embeddings, and vector search are out of scope for this first provider MVP
