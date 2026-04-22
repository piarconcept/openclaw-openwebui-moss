# PLAN - OpenClaw Open WebUI Moss Plugin

## Scope

This phase defines the architecture only. No implementation files beyond project bootstrap are created in this phase.

Goal: build a production-ready OpenClaw plugin that integrates OpenClaw with Open WebUI channels, routes messages to one of several Moss agents, and fails closed by default.

Supported logical agents:

- `moss-editorial`
- `moss-dev`
- `moss-operator`
- `moss-client`

## Product Principles

- Security first, fail closed by default
- Reusable across clients with config-driven routing
- Minimal dependencies and simple operations model
- Clear boundaries between transport, security, routing, attachments, and OpenClaw integration
- Deterministic behavior over clever heuristics

## High-Level Architecture

```text
                        +------------------------------+
                        |         Open WebUI           |
                        |  Channels + REST + Socket.IO |
                        +---------------+--------------+
                                        |
                         inbound events  |  outbound posts
                                        v
+-------------------------------------------------------------------+
|                  OpenClaw Open WebUI Moss Plugin                   |
|                                                                   |
|  +----------------+    +-------------------+                      |
|  | Config Loader  |    | Plugin Manifest   |                      |
|  | + Validator    |    | + Schema Export   |                      |
|  +--------+-------+    +---------+---------+                      |
|           |                          |                            |
|           v                          v                            |
|  +-------------------------------------------------------------+  |
|  | Realtime Socket Gateway                                     |  |
|  | - token auth                                                |  |
|  | - safe connect / reconnect                                  |  |
|  | - raw event normalization                                   |  |
|  +-----------------------------+-------------------------------+  |
|                                |                                  |
|                                v                                  |
|  +-------------------------------------------------------------+  |
|  | Secure Ingress Pipeline                                     |  |
|  | 1. Channel allowlist                                        |  |
|  | 2. User allowlist                                           |  |
|  | 3. Mention policy                                           |  |
|  | 4. Attachment policy gate                                   |  |
|  | 5. Agent resolver                                           |  |
|  +-----------------------------+-------------------------------+  |
|                                |                                  |
|                                v                                  |
|  +-------------------------------------------------------------+  |
|  | Session + Routing Layer                                      | |
|  | - thread binding to one agent                                | |
|  | - deterministic session key                                  | |
|  | - context shaping for OpenClaw                               | |
|  +-----------------------------+-------------------------------+  |
|                                |                                  |
|                   POST /api/chat|                                  |
|                                v                                  |
|  +-------------------------------------------------------------+  |
|  | OpenClaw Chat Client                                         | |
|  | - target one Moss agent                                      | |
|  | - preserve per-thread session                                | |
|  | - receive reply payload                                      | |
|  +-----------------------------+-------------------------------+  |
|                                |                                  |
|                                v                                  |
|  +-------------------------------------------------------------+  |
|  | Outbound WebUI Adapter                                       | |
|  | - post messages                                              | |
|  | - upload bounded attachments                                 | |
|  | - send typing best effort                                    | |
|  +-------------------------------------------------------------+  |
|                                                                   |
+-------------------------------------------------------------------+
```

## Proposed Repository Structure

```text
src/
  index.ts
  config.ts
  manifest.ts
  api/
    webui-client.ts
  realtime/
    socket.ts
  routing/
    router.ts
    agent-routing.ts
  security/
    access-control.ts
    mention-policy.ts
  agents/
    registry.ts
  attachments/
    inbound.ts
    outbound.ts
    cleanup.ts
  types/
    config.ts
    messages.ts
  utils/
    logger.ts
    errors.ts
```

## Module Responsibilities

- `src/index.ts`
  Plugin entrypoint. Wires manifest, config, socket lifecycle, and routing pipeline.
- `src/config.ts`
  Runtime config parsing and validation. Rejects invalid or unknown config before startup.
- `src/manifest.ts`
  Plugin metadata and exported config schema for OpenClaw.
- `src/api/webui-client.ts`
  REST client for Open WebUI using Bearer token auth only.
- `src/realtime/socket.ts`
  Socket.IO connection, auth refresh, normalization, and safe reconnect policy.
- `src/routing/router.ts`
  End-to-end ingress pipeline orchestration.
- `src/routing/agent-routing.ts`
  Deterministic agent resolution and thread binding behavior.
- `src/security/access-control.ts`
  Channel allowlist and user allowlist enforcement.
- `src/security/mention-policy.ts`
  Mention gating and trigger parsing.
- `src/agents/registry.ts`
  Logical agent definitions derived from config; no hardcoded routing logic.
- `src/attachments/inbound.ts`
  Stream inbound attachment downloads with hard size enforcement.
- `src/attachments/outbound.ts`
  Safe upload path for outbound files.
- `src/attachments/cleanup.ts`
  Temp file lifecycle and guaranteed cleanup helpers.
- `src/types/config.ts`
  TypeScript config types.
- `src/types/messages.ts`
  Message, event, and normalized envelope types.
- `src/utils/logger.ts`
  Structured logging with secret redaction.
- `src/utils/errors.ts`
  Typed domain errors and mapping to operational logs.

## Config Model

Target config shape:

```json
{
  "baseUrl": "https://webui.example.com",
  "token": "redacted",
  "requireMention": true,
  "allowedChannels": ["channel-1", "channel-2"],
  "allowedUsers": ["user-1", "user-2"],
  "agents": {
    "editorial": {
      "channelId": "channel-1",
      "trigger": "@moss-editorial",
      "agentId": "moss-editorial"
    },
    "dev": {
      "trigger": "@moss-dev",
      "agentId": "moss-dev"
    }
  },
  "attachments": {
    "enabled": true,
    "maxBytes": 10485760,
    "tempDir": "/var/tmp/openclaw-openwebui-moss"
  }
}
```

### Validation Rules

- `baseUrl`
  - required
  - must be valid `http` or `https` URL
  - normalized without trailing slash
- `token`
  - required
  - non-empty string
  - never logged
- `requireMention`
  - required boolean
- `allowedChannels`
  - required array
  - must be non-empty in production defaults
  - values must be unique, non-empty strings
- `allowedUsers`
  - required array
  - must be non-empty in production defaults
  - values must be unique, non-empty strings
- `agents`
  - required object
  - each entry must contain `agentId`
  - each entry must define at least one selector: `channelId` or `trigger`
  - `agentId` values may repeat only if explicitly intended; routing selectors must remain unambiguous
  - duplicate triggers are rejected
  - duplicate exclusive channel mappings are rejected
- `attachments.enabled`
  - required boolean
- `attachments.maxBytes`
  - required positive integer
  - bounded to a sane upper limit at validation time
- `attachments.tempDir`
  - required absolute path
  - created on startup if missing
  - startup fails if not writable
- unknown properties anywhere in the config
  - rejected

### Defaults

- Fail closed
- `requireMention: true`
- attachments disabled unless explicitly enabled
- no implicit wildcard channels or users
- no implicit default agent

## Data Flow

### Inbound Message Flow

```text
1. Plugin starts
2. Load config
3. Validate config strictly
4. Open Socket.IO connection to Open WebUI using Bearer token
5. Receive raw channel event
6. Normalize event into internal message envelope
7. Reject if channel is not in allowedChannels
8. Reject if sender is not in allowedUsers
9. Reject if mention policy fails when requireMention=true
10. Reject if event type is unsupported or malformed
11. Resolve one agent using thread binding or config selectors
12. If attachments enabled, stream approved files to tempDir with maxBytes enforcement
13. Build OpenClaw request with session key and resolved agentId
14. POST request to OpenClaw /api/chat
15. Receive assistant reply
16. Upload any outbound attachments safely if present
17. Post reply back to the source Open WebUI channel/thread
18. Clean up temp files in finally blocks
```

### Outbound Flow to OpenClaw

```text
Normalized inbound message
  -> security gate
  -> agent resolver
  -> session key builder
  -> OpenClaw /api/chat request
      {
        agentId,
        sessionKey,
        message,
        metadata,
        attachments?
      }
  -> OpenClaw response
  -> WebUI outbound adapter
```

## Security Model

### Trust Boundaries

- Boundary 1: Open WebUI server -> plugin process
- Boundary 2: plugin process -> OpenClaw `/api/chat`
- Boundary 3: plugin process -> local filesystem for temp attachments
- Boundary 4: plugin logs -> operators / log sinks

### Security Objectives

- Only explicitly authorized users may invoke the plugin
- Only explicitly authorized channels may be processed
- Only intentional messages pass when mention gating is enabled
- Only one resolved agent is allowed per message
- Attachments are bounded, streamed, and cleaned up
- Tokens and secrets never appear in logs
- Misconfiguration fails at startup, not during traffic

### Mandatory Controls

- Bearer token auth only
- No password login flow
- Strict allowlists for channels and users
- Mention gating configurable and fail closed
- Event rejection before routing and before attachment download
- Reject unsupported message types early
- Attachment byte cap enforced during stream, not after buffering
- Temp file cleanup in `finally`
- Structured logs with correlation IDs and redaction
- No command execution paths based on message content

### Logging Policy

Allowed in logs:

- channel ID
- user ID
- agent ID
- message ID
- thread key
- operation outcome
- byte counts

Not allowed in logs:

- Bearer token
- attachment contents
- raw secrets from config
- full message bodies by default

## Access Control Strategy

Access control happens before routing and before attachment handling.

Evaluation order:

1. `allowedChannels`
   - exact match required
   - unknown channel -> reject
2. `allowedUsers`
   - exact match required
   - unknown user -> reject
3. `requireMention`
   - if enabled, message must contain either:
     - the bot mention format for the Open WebUI bot user, or
     - exactly one configured agent trigger
   - failure -> reject
4. selector ambiguity
   - more than one matching agent trigger -> reject
   - conflicting channel and trigger mappings -> reject unless thread is already bound

This design explicitly avoids the audited plugin flaw of marking all inbound messages as authorized.

## Agent Routing Design

Agents are config-defined logical identities. The plugin never hardcodes agent behavior. It only resolves `agentId`.

### Resolution Rules

A message must resolve to exactly one agent.

Precedence:

1. Existing thread binding
2. Explicit agent trigger match from message content
3. Exact channel mapping from config
4. Otherwise reject as unroutable

### Thread Binding

Once the first message in a thread/session resolves to an agent, the thread is bound to that agent for the process lifetime.

Binding key strategy:

- DM: `dm:{channelId}`
- Threaded channel: `channel:{channelId}:thread:{parentId}`
- Non-threaded channel: `channel:{channelId}`

OpenClaw session key strategy:

- `owui:{bindingKey}:agent:{agentId}`

This preserves agent context inside OpenClaw and prevents a later message in the same thread from silently hopping to another agent.

### Ambiguity Handling

Reject, do not guess, when:

- multiple triggers match
- a new thread matches more than one channel-based selector
- no selector matches and no existing thread binding exists

### Why This Is Reusable

- New clients only change config, not code
- New agents only require config entries
- One plugin binary can serve different tenants with different routing maps

## Mention Policy Design

Mention policy is separate from access control and separate from agent routing.

Rules:

- If `requireMention=false`, mention gating is skipped but access control still applies
- If `requireMention=true`, accepted signals are:
  - Open WebUI bot mention format
  - one explicit configured trigger such as `@moss-dev`
- Agent triggers are exact token matches, not fuzzy matches
- Multiple triggers in one message are rejected as ambiguous

This avoids accidental activation from ordinary prose.

## Attachment Handling Design

### Inbound

- Attachments are processed only after channel and user allowlist checks succeed
- If `attachments.enabled=false`, attachment metadata is ignored and files are never downloaded
- Download via streaming HTTP response
- Enforce `attachments.maxBytes` while streaming
- Reject file once the byte limit is exceeded
- Use safe filename normalization
- Store under `attachments.tempDir` with request-scoped subdirectories
- Always clean up temp files in `finally`

### Outbound

- Upload only files produced by OpenClaw response handling
- Validate file path and existence
- Enforce max size before upload
- Avoid loading entire file into memory when multipart streaming is possible

### Cleanup

- Per-request cleanup runs immediately after response handling
- Startup cleanup can delete stale temp subdirectories older than a configured TTL
- Crash leftovers are considered operational debt and cleaned on next startup sweep

This explicitly corrects the audited plugin flaw of buffering full files and leaving temp artifacts behind.

## OpenClaw Integration Design

The plugin acts as a transport and policy layer.

It sends one request per accepted inbound message to `POST /api/chat` with:

- resolved `agentId`
- deterministic `sessionKey`
- user-visible message text
- normalized channel metadata
- optional attachment references

The plugin does not embed agent logic. OpenClaw remains the system that executes the agent conversation.

## Limitations of Open WebUI API

Known or expected constraints that shape the design:

1. Socket channel scoping may be limited
   - If Open WebUI cannot limit subscriptions server-side by channel, the plugin must still reject unauthorized events before any expensive work.
   - Operational mitigation: use a dedicated bot account that only belongs to intended channels.
2. Mention syntax is platform-specific
   - Native mention parsing depends on Open WebUI user mention format.
3. Thread semantics may be partial
   - Some messages may only expose `parent_id` or `reply_to_id`, requiring conservative session derivation.
4. Attachment metadata may be incomplete
   - Content length may be missing, so streaming byte counting is mandatory.
5. Reactions and typing may be best effort
   - Core functionality must not depend on them.
6. Token expiry and websocket reconnect behavior may vary across WebUI versions
   - Reconnect logic must be resilient and observable.

## Comparison With the Audited Plugin

| Audited weakness | New design response |
| --- | --- |
| Authorized every message | Explicit allowlists for both channels and users; fail closed |
| Weak channel isolation | Reject unknown channels before routing, before context fetch, before attachments |
| Password login | Bearer token only |
| Global event processing without policy | Early ingress firewall and dedicated bot account recommendation |
| Unsafe attachments | Streamed downloads, hard max bytes, tempDir cleanup |
| Empty config schema | Strict typed config with runtime validation and unknown-key rejection |
| No real routing model | Deterministic one-agent resolver with ambiguity rejection |
| No maintainability baseline | Planned tests, linting, Docker, docs, changelog |

## Tradeoffs

1. Dedicated allowlists increase setup effort
   - Worth it because it prevents accidental exposure.
2. Rejecting ambiguous routing may feel strict
   - Worth it because silent misrouting is worse in production.
3. Non-threaded channel sessions may share a channel-level session key
   - Simpler and more predictable than inventing hidden heuristics.
4. Thread bindings are process-local in the first version
   - Avoids premature persistence complexity; restart behavior is documented.
5. Minimal dependencies mean more custom validation code
   - Acceptable to keep operational surface small.
6. Dedicated bot account is strongly recommended
   - Necessary because Open WebUI server-side subscription controls may be limited.

## Testing Strategy

Use Vitest for unit coverage on core policy logic.

Required tests:

- config validation
  - rejects unknown keys
  - rejects empty token
  - rejects bad URLs
  - rejects duplicate triggers
  - rejects ambiguous channel mappings
- access control
  - accepts allowed user/channel
  - rejects unknown channel
  - rejects unknown user
- mention policy
  - accepts bot mention
  - accepts one valid trigger
  - rejects no mention when required
  - rejects multiple triggers
- routing
  - thread binding wins
  - trigger wins over channel mapping for new thread
  - unroutable messages are rejected
  - ambiguous messages are rejected

## Tooling Plan

Development tooling to add during implementation phase:

- TypeScript strict mode
- Vitest
- ESLint
- Prettier
- `package.json` scripts:
  - `dev`
  - `build`
  - `test`
  - `lint`

Dependency posture:

- Prefer built-in Node APIs for fetch, streams, fs, path, os
- Keep external runtime deps minimal
- Avoid large schema libraries unless the manifest integration truly requires one

## Deployment Plan

Implementation phase will add:

- `Dockerfile`
- `docker-compose.yml`

Container goals:

- run under non-root user
- mount temp attachment directory explicitly
- pass config via environment or mounted config file
- support `docker compose up -d`

## Documentation Plan

Implementation phase README will include:

- overview
- architecture
- security model
- config reference
- usage
- limitations
- deployment
- "Why this plugin is safer than naive implementations"

## Non-Goals for the First Release

- Persistent thread binding storage across restarts
- Multi-tenant auth brokering
- Server-side admin automation for Open WebUI channel membership
- Rich moderation workflows beyond allowlists and mention policy

## Implementation Gate

Do not implement the plugin until this plan is approved.
