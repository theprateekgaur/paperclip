# Pro Bridge

`pro-bridge` is the first concrete `Air -> Pro -> local automation -> Air` sidecar.

It implements Paperclip's existing deferred remote-run contract so `Air` can trigger
repo-local commands on `Pro` and receive live status/log callbacks.

This is phase 1 only.

- Supported now: Paperclip-originated remote runs
- Not supported yet: passive ingestion of Codex app / Cursor sessions that start outside Paperclip

## What It Does

`pro-bridge` exposes three endpoints on `Pro`:

- `GET /health`
- `POST /paperclip/invoke`
- `POST /paperclip/cancel/:externalRunId`

On invoke:

1. validate bearer auth if configured
2. resolve a profile or inline command
3. spawn the local process on `Pro`
4. immediately return `accepted=true`
5. stream stdout/stderr back to `POST /api/heartbeat-runs/:runId/remote`
6. post final `succeeded|failed|cancelled`

## Run Model

The bridge expects the standard Paperclip envelope:

```json
{
  "paperclip": {
    "runId": "...",
    "agentId": "...",
    "companyId": "...",
    "authToken": "...",
    "callbacks": {
      "updateUrl": "http://air:3100/api/heartbeat-runs/<runId>/remote"
    }
  },
  "bridge": {
    "profile": "dexter-codex-nightly"
  }
}
```

The `bridge` section can either point to a profile in `PRO_BRIDGE_CONFIG`, or inline:

```json
{
  "bridge": {
    "cwd": "/Users/prateekgaur/Developer/dexter",
    "command": ["pnpm", "run", "nightly:polish"],
    "env": {
      "AUTOMATION_SOURCE": "paperclip"
    }
  }
}
```

## Profiles

Set `PRO_BRIDGE_CONFIG` to a JSON file shaped like:

```json
{
  "profiles": {
    "dexter-codex-nightly": {
      "cwd": "/Users/prateekgaur/Developer/dexter",
      "command": ["codex", "--full-auto", "Run the nightly Dexter polish checklist"],
      "env": {
        "AUTOMATION_SOURCE": "paperclip"
      },
      "metadata": {
        "repo": "dexter",
        "runtime": "codex_cli"
      }
    }
  }
}
```

String values support simple template substitution against the full invoke body:

- `{{paperclip.runId}}`
- `{{paperclip.agentId}}`
- `{{paperclip.context.taskId}}`

## Running

From the Paperclip repo:

```bash
PRO_BRIDGE_CONFIG=/abs/path/pro-bridge.config.json \
  PRO_BRIDGE_WEBHOOK_BEARER=replace-me \
  PRO_BRIDGE_PUBLIC_BASE_URL=http://pro:3211 \
  node cli/node_modules/tsx/dist/cli.mjs scripts/pro-bridge.ts
```

Or:

```bash
pnpm pro-bridge
```

## Suggested Paperclip Agent Config

Create an agent on `Air` using the `http` adapter:

- `url`: `http://pro:3211/paperclip/invoke`
- `webhookAuthHeader`: `Bearer <same value as PRO_BRIDGE_WEBHOOK_BEARER>`
- `payloadTemplate`:

```json
{
  "bridge": {
    "profile": "dexter-codex-nightly"
  }
}
```

The agent's own prompt is not forwarded by the bridge yet. Phase 1 is for
repo-local automation commands and wrappers, not full remote Codex/Claude prompt execution.

## launchd

Use [com.paperclip.pro-bridge.plist.example](/Users/prateekgaur/Developer/paperclip/launchd/com.paperclip.pro-bridge.plist.example)
as the starting point on `Pro`.

## Next Step

Phase 2 should add app-originated ingestion:

- Cursor hook watcher
- Codex CLI wrapper
- Codex app session/log watcher if the desktop app exposes usable local artifacts
