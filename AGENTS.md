# AGENTS.md

Orientation file for AI coding agents working on Project Friday. Optimised for
fast loading: scan top-to-bottom once, then jump by section header.

The repo README is for humans; this file is for you.

---

## TL;DR

Friday is a **two-process voice assistant**: a browser frontend (Vite + React)
and a Node orchestrator. They talk over a single WebSocket. The orchestrator
holds all third-party keys (AWS Bedrock, Deepgram, optional ElevenLabs) and
runs the STT → Claude → TTS pipeline. The browser handles mic, speakers, and
UI. **No Electron, no desktop wrapper, no native code.**

Stack: TypeScript strict, pnpm workspaces, Turborepo, Vite, React 18, zustand,
Bedrock-hosted Claude 3 Sonnet, Deepgram Nova 2, Cohere multilingual
embeddings, Postgres 16 + pgvector. Browser `speechSynthesis` is the default
TTS; ElevenLabs is optional.

---

## Read these files first (in this order)

1. [`apps/orchestrator/src/index.ts`](apps/orchestrator/src/index.ts) — entry; wires every component
2. [`apps/orchestrator/src/pipeline.ts`](apps/orchestrator/src/pipeline.ts) — turn lifecycle, single source of truth for the pipeline
3. [`apps/orchestrator/src/state-machine.ts`](apps/orchestrator/src/state-machine.ts) — allowed phase transitions
4. [`apps/orchestrator/src/ws-server.ts`](apps/orchestrator/src/ws-server.ts) — WS protocol surface
5. [`apps/renderer/src/lib/controller.ts`](apps/renderer/src/lib/controller.ts) — renderer-side orchestrator client
6. [`packages/shared/src/events.ts`](packages/shared/src/events.ts) — typed wire protocol (`ClientToServer` / `ServerToClient`)
7. [`packages/shared/src/config.ts`](packages/shared/src/config.ts) — env schema (zod)

After these you have the full mental model.

---

## Mental model

```
       Browser                          Orchestrator (Node)
  ┌──────────────────┐             ┌──────────────────────────┐
  │  AudioBridge     │             │  Pipeline                │
  │  ├ wake word     │             │  ├ StateMachine          │
  │  ├ mic capture   │ ──client.── │  ├ InterruptionManager   │
  │  ├ PCM playback  │   wake/     │  ├ DeepgramSession       │  ──► Deepgram
  │  └ BrowserTTS    │   audio/    │  ├ AgentRouter           │  ──► Bedrock
  │                  │   text      │  ├ ClaudeClient          │  ──► Bedrock
  │  WSClient        │             │  ├ ToolRegistry          │
  │  └ reconnects    │ ──server.── │  ├ VectorStore           │  ──► Postgres
  │                  │   phase/    │  ├ ConversationSummariser│
  │  Controller      │   delta/    │  └ ElevenLabsTTSSession  │  ──► ElevenLabs
  │  (event router)  │   tool/tts  │                          │      (optional)
  │                  │             │  WSServer ←──── one ─────│
  │  zustand store   │             │           client at a    │
  │  └ UI renders    │             │           time           │
  └──────────────────┘             └──────────────────────────┘
```

**One turn = one armed cancellation token.** Everything inside the turn
(Claude stream, Deepgram, ElevenLabs, tool calls, browser TTS) is bound to
that token. `interrupt()` cancels the token; every component releases.

**The Pipeline is the only thing that mutates pipeline state.** Don't reach
around it. If WS handlers need to inject something into a turn, add a method
on `Pipeline` and call it.

---

## Critical invariants — DO NOT VIOLATE

### State machine
- **Allowed transitions** are listed in [`state-machine.ts:13-21`](apps/orchestrator/src/state-machine.ts). Tested in [`state-machine.test.ts`](apps/orchestrator/src/state-machine.test.ts).
- `idle → transcribing` is **NOT** legal. Must go via `listening`.
- Any phase except `idle` can transition to `interrupted`.
- Illegal transitions throw. Catch defensively only at known race points (see `Pipeline.beginTurn` post-`stt.open`).

### Pipeline
- `Pipeline.beginTurn` resets the state machine if it's not idle before transitioning to `listening`. **Don't remove this guard** — it prevents the rapid-wake-button race.
- After `stt.open()` resolves in `beginTurn`, the code re-checks `this.active && !token.isCancelled` before transitioning to `transcribing`. Removing this brings the race back.
- `Pipeline.injectText(text)` is the **only** way to feed typed text into a turn. It writes BOTH `active.finalText` (which `handleEndpoint` checks) AND the state machine's `finalTranscript` (which the renderer displays). The old "just call `state.appendFinalTranscript`" path silently no-ops because `handleEndpoint` reads `active.finalText`.
- On TTS error mid-stream, the handler **must null out `this.active.tts`** so the runLLM cleanup hits the text-only branch (which fires `tts.end` + `endTurn`). Skipping this hangs the turn forever.

### Cancellation
- Every long-lived per-turn op accepts a `CancellationToken` from [`packages/shared/src/cancellation.ts`](packages/shared/src/cancellation.ts).
- Bedrock/Anthropic SDK calls get `token.toAbortSignal()`.
- All `stop()` / `close()` / `cancel()` methods are **idempotent**. Tests rely on this.

### Single client
- The WS server hosts **one active client at a time** (the renderer). Don't add multi-client logic without rethinking state ownership.

### Browser TTS vs server TTS are mutually exclusive
- In `controller.ts`, when `ttsMode === 'browser'`, `server.tts.frame` events are **ignored**. Don't change one branch without the other or you'll get duplicated audio.

---

## Common tasks

### Add a new LLM tool
1. Pick or create a file in [`packages/tools/src/`](packages/tools/src) (e.g. `system-tools.ts`).
2. `defineTool({ name, description, tags, input: zodSchema, run })`.
3. Any agent whose `toolTags` (in [`packages/llm/src/agents.ts`](packages/llm/src/agents.ts)) overlaps your `tags` will see it automatically.
4. The Zod schema is auto-converted to JSON Schema by `zodToJsonSchema` in [`tool-registry.ts`](packages/llm/src/tool-registry.ts). Subset is limited — add a case if you need a type that's missing (e.g. `ZodTuple`).

### Add a new agent
1. Add entry to `AGENTS` in [`agents.ts`](packages/llm/src/agents.ts) (`id`, `name`, `toolTags`, `systemPrompt`, optional `temperature`/`maxTokens`).
2. Add the id to the router's enum in [`router.ts`](packages/llm/src/router.ts) (`SCHEMA.input_schema.properties.agent.enum`) and to the system prompt's agent list.
3. Update the `AgentId` union in `agents.ts`.

### Add a new WS event type
1. Edit `ClientToServer` or `ServerToClient` in [`packages/shared/src/events.ts`](packages/shared/src/events.ts).
2. Add a handler in `ws-server.ts` (`handleClientMessage` switch) for inbound, or call `broadcast(...)` for outbound.
3. The renderer's `Controller.handleEvent` switch dispatches inbound `server.*` events; add a case.

### Add a new env var
1. Add to `.env.example` (with comment) and the schema in [`packages/shared/src/config.ts`](packages/shared/src/config.ts).
2. Update `turbo.json`'s `globalEnv` array — otherwise turbo's cache invalidation will miss it.
3. If renderer-side, add a `VITE_` var to `apps/renderer/.env.example` instead, and read with `import.meta.env.VITE_*`.

### Change the Claude model
- Edit `BEDROCK_MODEL_ID` in `.env`. Default is `anthropic.claude-3-sonnet-20240229-v1:0`. All agents use the same model — there is no per-agent model setting (this is intentional; see `pipeline.ts`'s `model = agent.model ?? this.cfg.bedrockModelId` — `agent.model` is never set in current agent specs).
- Make sure the new model id has access enabled in the AWS Bedrock console for `AWS_REGION`.

### Re-enable the cinematic Three.js scene
In [`apps/renderer/src/App.tsx`](apps/renderer/src/App.tsx) change:
```ts
import { SimpleBackdrop as Scene } from './scene/SimpleBackdrop';
```
to:
```ts
import { Scene } from './scene/Scene';
```
The Three.js files in [`apps/renderer/src/scene/`](apps/renderer/src/scene) (Core/Particles/Rings/Stars + shaders) are intentionally preserved.

### Switch to ElevenLabs TTS
- In `apps/renderer/.env`: `VITE_TTS_MODE=server`
- In `.env`: set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, ensure `FRIDAY_DISABLE_TTS=false`.

---

## Gotchas (learned in build)

### SDK version compatibility
- `@anthropic-ai/bedrock-sdk@0.29.1` requires `@anthropic-ai/sdk >= 0.57.0` (it expects an async `buildRequest`). We pin `0.60.0`. **Do not downgrade `@anthropic-ai/sdk` below 0.57** or every Claude call crashes with `Cannot read properties of undefined (reading 'method')`.
- `bedrock-sdk@0.12` was originally pinned and DOES NOT WORK — its `makeBetaResource` expected a SDK shape that doesn't exist anymore. Don't downgrade either.

### pnpm workspace cwd
- `pnpm --filter <pkg> <script>` sets `cwd` to the package directory. `import 'dotenv/config'` looks at cwd, so it misses the root `.env`. Both `apps/orchestrator/src/index.ts` and `packages/memory/src/migrate.ts` have a `loadWorkspaceEnv()` helper that walks up from `import.meta.url` to find `.env`. Use the same pattern if you add another Node entry point.

### tsconfig conventions
- Package tsconfigs have **no `rootDir`** and **no `composite`** / **no project references**. Cross-package imports resolve directly source-to-source via `paths` in [`tsconfig.base.json`](tsconfig.base.json). Adding `rootDir: "src"` to a package will break its typecheck (TS6059: imported file outside rootDir).
- The renderer alone sets `noUncheckedIndexedAccess: false` because Three.js shader uniforms are densely indexed.

### React 18 StrictMode
- The renderer uses StrictMode (in `main.tsx`). `useEffect` runs **twice** in dev — mount → synthetic unmount → mount. **Do not use a `mountedRef` guard to skip the second run** — `useRef` values persist across the synthetic unmount, so the guard would block the only effect run that creates a working Controller. The existing pattern in [`App.tsx`](apps/renderer/src/App.tsx) is correct: `cancelled` flag + idempotent `ctrl.stop()`.

### Zod inference + EventBus
- `EventBus<T extends Record<string, any>>` (not `Record<string, unknown>`). Strict `unknown` rejects literal-key interfaces like `UIEventMap`. Don't tighten the constraint.

### State machine race on rapid wake
- Multiple `client.wake` messages arriving within a few hundred ms used to throw `Illegal transition: idle -> transcribing`. Cause: `stt.open()` is async; the first turn's `endTurn` could fire (state → idle) while the second turn was still awaiting `stt.open`. Fix in `Pipeline.beginTurn`: state-reset before `transcribing`, and post-`stt.open` skip the `transcribing` transition if the turn was cancelled or state is no longer `listening`.

### Pipeline injectText required for typed input
- When `client.text` arrives, the WS handler **must** call `pipeline.injectText(text)`. Calling only `state.appendFinalTranscript(text)` leaves `pipeline.active.finalText` empty, so `handleEndpoint` declares "no-speech" and silently ends the turn with no LLM call.

### TTS error must null out `active.tts`
- See "Critical invariants — Pipeline" above. The TTS handler in `pipeline.ts` does this; don't remove it.

### `bedrock-sdk` types come from `@anthropic-ai/sdk`
- `AnthropicBedrock` is a class only — type aliases like `MessageParam` come from `@anthropic-ai/sdk`. Both `packages/llm/package.json` and `apps/orchestrator/package.json` need `@anthropic-ai/sdk` as a direct dep for the type imports to resolve under pnpm's strict tree.

### Postgres + pgvector dimension
- Cohere `embed-multilingual-v3` is **1024-dim**. `PGVECTOR_DIM` must equal this. If you swap embedding model, update `PGVECTOR_DIM` and re-run `pnpm migrate`. The `memories.embedding` column type is fixed at table-create time — you'll need to drop/recreate or `ALTER COLUMN ... TYPE vector(N)`.

### pgvector type-register race on first connect
- On a fresh database, the pool's `connect` listener fires `registerType` **before** the migration's `CREATE EXTENSION vector` runs. The warning is benign and self-heals on the next process restart. The handler in [`postgres.ts`](packages/memory/src/postgres.ts) logs at `debug` for the expected message and `warn` for anything else. Don't escalate.

### Wake word is optional
- `BrowserTTS.isSupported()` is checked at runtime. `WakeWord` (Picovoice) is only instantiated when `accessKey` is truthy. Both can be absent without breaking the rest of the system. Don't add `throw` paths that require either.

### Migration auto-creates DB
- `pnpm migrate` connects to the `postgres` default database first if the target db doesn't exist, runs `CREATE DATABASE`, then proceeds. The db name is sanitised against `[A-Za-z0-9_-]` before interpolation.

---

## How to verify your work

```powershell
pnpm typecheck         # tsc --noEmit across the workspace
pnpm test              # vitest run (currently 11 tests, all in orchestrator)
pnpm build             # full production build, sanity check
pnpm --filter <pkg> typecheck   # one workspace at a time
```

For runtime changes:
- Bring up Postgres: `pnpm db:up && pnpm migrate`
- Run: `pnpm dev`
- Watch orchestrator logs for `INFO: starting Friday orchestrator` then `INFO: ws server listening`
- Open `http://localhost:5174`, open DevTools Console
- Press Space or type text; trace `[ws] OPEN`, `client.text received`, `agent.route`, `text_delta` events

Critical paths to test manually after any pipeline change:
1. Typed input ("hi") with `VITE_TTS_MODE=browser` → see transcript + hear speech
2. Manual wake (Space) → speak → see transcript + reply
3. Interrupt mid-speech (Space again or Escape) → playback stops cleanly
4. Rapid double-wake (Space twice in 200ms) → no `Illegal transition` errors

---

## Don't touch unless you understand the implication

- **`mountedRef` / StrictMode guard in App.tsx** — adding any persistent flag to gate effect re-runs will break StrictMode dev mode.
- **`Pipeline.beginTurn` state reset + post-stt-open race guard** — protects against rapid retrigger.
- **Cancellation token wiring** — every per-turn op must accept it; bypass paths leak resources.
- **`Pipeline.injectText`** vs `state.appendFinalTranscript` — these are NOT interchangeable.
- **`registerType` warning at debug-level** — escalating to `warn` will spam fresh-install logs.
- **SDK version pins** for `@anthropic-ai/sdk` (0.60.0) and `@anthropic-ai/bedrock-sdk` (0.29.1) — see Gotchas.
- **`audio/browser` vs `audio/node`** — the renderer must import from `@friday/audio/browser` (uses DOM APIs); Node code must use `@friday/audio/node` or `@friday/audio` (pure helpers only).

---

## Code style

- TypeScript strict + `noUncheckedIndexedAccess` everywhere except the renderer.
- Default to no comments. Only annotate non-obvious WHY (hidden constraint, workaround for a specific issue).
- Errors thrown are surfaced via `log.warn`/`log.error` (pino, structured). Don't `console.log` in production paths.
- Logger naming: `getLogger('module:submodule')` — examples: `stt:deepgram`, `llm:claude`, `memory:vec`, `orchestrator:pipeline`.
- React: functional components only. State via `useState` for local, `zustand` for global (`useFridayStore`).
- Async: prefer `async/await`. The pipeline runs `runLLM` without awaiting from its caller; cleanup happens via the cancellation token.

---

## File index (alphabetical, important files only)

### Orchestrator
- [`apps/orchestrator/src/index.ts`](apps/orchestrator/src/index.ts) — entry; constructs every dependency, wires WS + Pipeline + memory + lifecycle
- [`apps/orchestrator/src/interruption.ts`](apps/orchestrator/src/interruption.ts) — `InterruptionManager`, one armed token per turn
- [`apps/orchestrator/src/lifecycle.ts`](apps/orchestrator/src/lifecycle.ts) — SIGINT/SIGTERM hooks
- [`apps/orchestrator/src/pipeline.ts`](apps/orchestrator/src/pipeline.ts) — **THE BIG FILE** — turn lifecycle, STT/LLM/TTS coordination
- [`apps/orchestrator/src/state-machine.ts`](apps/orchestrator/src/state-machine.ts) — phase transitions
- [`apps/orchestrator/src/ws-server.ts`](apps/orchestrator/src/ws-server.ts) — `WSServer`, message routing

### Renderer
- [`apps/renderer/src/App.tsx`](apps/renderer/src/App.tsx) — root; bootstraps Controller
- [`apps/renderer/src/lib/audio-bridge.ts`](apps/renderer/src/lib/audio-bridge.ts) — mic capture, wake word, PCM playback
- [`apps/renderer/src/lib/browser-tts.ts`](apps/renderer/src/lib/browser-tts.ts) — `speechSynthesis` wrapper, sentence-aware
- [`apps/renderer/src/lib/controller.ts`](apps/renderer/src/lib/controller.ts) — WS event router, owns audio + browserTts
- [`apps/renderer/src/lib/state-store.ts`](apps/renderer/src/lib/state-store.ts) — zustand store
- [`apps/renderer/src/lib/ws-client.ts`](apps/renderer/src/lib/ws-client.ts) — reconnecting client with logging
- [`apps/renderer/src/scene/SimpleBackdrop.tsx`](apps/renderer/src/scene/SimpleBackdrop.tsx) — current visual; CSS-only
- [`apps/renderer/src/scene/Scene.tsx`](apps/renderer/src/scene/Scene.tsx) — Three.js alternative; not currently used
- [`apps/renderer/src/ui/`](apps/renderer/src/ui/) — HUD components (StatusBar, Transcript, ToolFeed, Cards, Controls)

### Packages
- [`packages/audio/src/{browser,node}.ts`](packages/audio/src) — entry points; browser-only vs Node-safe split
- [`packages/llm/src/agents.ts`](packages/llm/src/agents.ts) — system prompts per agent
- [`packages/llm/src/claude-client.ts`](packages/llm/src/claude-client.ts) — streaming tool-use loop via `AnthropicBedrock`
- [`packages/llm/src/router.ts`](packages/llm/src/router.ts) — fast tool-forced classifier
- [`packages/llm/src/tool-registry.ts`](packages/llm/src/tool-registry.ts) — `defineTool`, Zod → JSON Schema, dispatch
- [`packages/memory/src/embeddings.ts`](packages/memory/src/embeddings.ts) — `BedrockCohereEmbeddings`
- [`packages/memory/src/migrate.ts`](packages/memory/src/migrate.ts) — db + extension + schema (idempotent)
- [`packages/memory/src/postgres.ts`](packages/memory/src/postgres.ts) — pg pool + vector type registration
- [`packages/memory/src/summarizer.ts`](packages/memory/src/summarizer.ts) — `ConversationSummariser`, rolling buffer compaction
- [`packages/memory/src/vector-store.ts`](packages/memory/src/vector-store.ts) — `VectorStore`, save/search/list
- [`packages/shared/src/cancellation.ts`](packages/shared/src/cancellation.ts) — `CancellationSource` / `CancellationToken`
- [`packages/shared/src/config.ts`](packages/shared/src/config.ts) — zod env schema
- [`packages/shared/src/event-bus.ts`](packages/shared/src/event-bus.ts) — in-process typed pub/sub
- [`packages/shared/src/events.ts`](packages/shared/src/events.ts) — WS protocol types
- [`packages/shared/src/logger.ts`](packages/shared/src/logger.ts) — pino factory
- [`packages/stt/src/deepgram-client.ts`](packages/stt/src/deepgram-client.ts) — `DeepgramSession`
- [`packages/tools/src/index.ts`](packages/tools/src/index.ts) — `buildToolRegistry`, the one place all tools register
- [`packages/tts/src/elevenlabs-client.ts`](packages/tts/src/elevenlabs-client.ts) — `ElevenLabsTTSSession`

---

## When the user reports a bug

1. Ask for the orchestrator log (terminal where `pnpm dev` runs).
2. Ask for the renderer's DevTools Console output.
3. Look for known patterns in the Gotchas section first.
4. If it's a fresh issue, trace through `pipeline.ts` for the turn lifecycle; add a `log.info` if the path is opaque.

When in doubt about a stack trace involving SDK internals, suspect version
mismatch first — that's bitten this project twice already.

---

## What was removed (in case the user asks)

- **Electron desktop wrapper** — used to be at `apps/electron/`. Deleted. The repo is browser-only now. Don't add it back without strong reason; everything works in a normal browser tab.
- **Three.js as default scene** — moved to opt-in (see "Re-enable cinematic scene" task). The lightweight `SimpleBackdrop` is what ships by default to keep low-end hardware happy.
- **Cinematic Three.js + bloom + chromatic aberration** — was crashing on integrated GPUs and washing the scene to white. The simplified `Scene.tsx` (~25% of original load) is still in the repo if needed.
- **OpenAI-compatible embeddings + local hash fallback** — replaced with Bedrock Cohere only. The `EMBEDDING_*` env vars are gone.
- **Multi-tier model selection** (`primaryModel` / `fastModel` / `deepModel`) — collapsed to one `BEDROCK_MODEL_ID` per user request.

---

## Last updated context window

The user is on Windows 11, uses pnpm, runs Postgres locally with `postgres:1212` credentials, has AWS Bedrock + Deepgram keys, no ElevenLabs (quota exhausted), no Picovoice key. Browser TTS is enabled. The cinematic Three.js scene is disabled. AWS_REGION is `ap-south-1`.
