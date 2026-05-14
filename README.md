# Project Friday

> A realtime, browser-based AI assistant. Wake word → streaming speech-to-text → multi-agent Claude reasoning with tool use → speech-to-speech response. Persistent long-term memory backed by pgvector.

Friday is a small, opinionated platform for building a voice-first assistant on top of **AWS Bedrock Claude** + **Deepgram** + your browser's microphone and speakers. Open `http://localhost:5174`, press **Space**, talk. The orb reacts; Friday listens, thinks, runs tools, and replies.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Architecture](#architecture)
3. [Quick start](#quick-start)
4. [API keys & costs](#api-keys--costs)
5. [How a turn flows](#how-a-turn-flows)
6. [Repository layout](#repository-layout)
7. [Configuration reference](#configuration-reference)
8. [State machine](#state-machine)
9. [Multi-agent system](#multi-agent-system)
10. [Tools the LLM can call](#tools-the-llm-can-call)
11. [Memory system](#memory-system)
12. [Cancellation & interruption](#cancellation--interruption)
13. [TTS modes](#tts-modes)
14. [Wake word (optional)](#wake-word-optional)
15. [Development workflow](#development-workflow)
16. [Building for production](#building-for-production)
17. [Troubleshooting](#troubleshooting)
18. [Tech stack](#tech-stack)
19. [License](#license)

---

## What you get

- **Voice in, voice out** — Deepgram for streaming STT; the OS's built-in `speechSynthesis` (or optionally ElevenLabs) for TTS.
- **Multi-agent orchestration** — a fast Haiku-style router classifies each request and dispatches to one of five agent specialisations (orchestrator / intelligence / memory / voice / ui), each with its own system prompt, temperature and tool subset. All backed by the same Bedrock-hosted Claude.
- **Native tool use** — Claude can call local functions (system info, math, HTTP fetch, UI cards, memory read/write) via the Anthropic SDK's tool API.
- **Persistent semantic memory** — every turn is summarised into facts and embedded with Cohere Multilingual v3 via Bedrock; relevant facts are surfaced into Claude's context on subsequent turns.
- **Real interruption** — start speaking while Friday is talking and the LLM stream, the speech synth and the audio playback all stop within milliseconds.
- **A single-file CSS "presence"** — a pulsing orb that reacts to the audio level and phase. Zero GPU work. The original Three.js cinematic scene is still in the repo and can be re-enabled by changing one import.
- **Hard requirements only on what matters** — AWS + Deepgram. Everything else (ElevenLabs, Picovoice, custom voices) is optional and degrades gracefully.

---

## Architecture

Two processes talk over one WebSocket.

```
            ┌───────────────────────────────────────────┐
            │  Browser  (http://localhost:5174)         │
            │  • Mic capture (AudioWorklet → 16k PCM)   │
            │  • Wake word (Porcupine — optional)       │
            │  • Browser TTS (speechSynthesis API)      │
            │  • Reactive UI + state store (zustand)    │
            └────────────────┬──────────────────────────┘
                             │ WebSocket  (typed events)
            ┌────────────────▼──────────────────────────┐
            │  Orchestrator  (Node, ws://127.0.0.1:8787)│
            │  • Pipeline + state machine + interrupt   │
            │  • Deepgram streaming STT (server-side WS)│
            │  • Claude (Bedrock) streaming + tools     │
            │  • Agent router (fast Haiku-style call)   │
            │  • Memory: pgvector + Cohere embeddings   │
            │  • ElevenLabs streaming TTS (optional)    │
            └───────────────────────────────────────────┘
```

The browser holds **no API keys**. All third-party credentials live in the orchestrator's environment. The orchestrator never speaks directly to the user's mic or speakers — it only sees JSON event frames over WebSocket.

---

## Quick start

**Prerequisites**

- Node ≥ 20.11
- pnpm ≥ 9
- PostgreSQL (local install **or** Docker Desktop — `docker-compose.yml` includes pgvector)
- A modern Chromium/Firefox/Safari browser
- A microphone

**Steps**

```powershell
# 1. Install deps + bring up Postgres + create schema
pnpm install
pnpm db:up        # docker compose up -d postgres
pnpm migrate      # auto-creates the friday database + pgvector extension + tables

# 2. Copy env templates and fill in keys
Copy-Item .env.example .env
Copy-Item apps/renderer/.env.example apps/renderer/.env
# Edit both files — see "API keys & costs" below for which ones are required.

# 3. Run everything
pnpm dev
```

`pnpm dev` starts:
- **Vite** dev server at <http://localhost:5174>
- **Orchestrator** on `ws://127.0.0.1:8787`

Open <http://localhost:5174>, grant microphone permission, and press **Space** (or click **WAKE**). Type into the **TEXT** box for keyboard-only mode.

---

## API keys & costs

| Service | Required? | What it costs | Env var(s) |
|---|---|---|---|
| **AWS Bedrock** (Claude + Cohere embeddings) | **Yes** | Pay-per-token. Sonnet 3: ~$3 / $15 per 1M input/output tokens. Cohere embeddings ~$0.10 / 1M tokens. | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| **Deepgram** (streaming STT) | **Yes** | $200 free credit on signup, then ~$0.0043/min of audio for Nova 2. | `DEEPGRAM_API_KEY` |
| **ElevenLabs** (premium TTS) | Optional | Free tier = 10k chars/month. Premium plans from $5/month. | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| **Picovoice Porcupine** (wake word) | Optional | Free for personal use. | `VITE_PICOVOICE_ACCESS_KEY` (renderer env) |

> **Bedrock model access**: before first use, open the AWS Bedrock console → **Model access** in your chosen `AWS_REGION` and request access to `anthropic.claude-3-sonnet-20240229-v1:0` and `cohere.embed-multilingual-v3`. Approval is usually instant.

**Want it fully free?**
- Skip ElevenLabs → leave `VITE_TTS_MODE=browser` (default). The OS's `speechSynthesis` does TTS locally.
- Skip Picovoice → leave the access key empty. Press **Space** or click **WAKE** instead of saying "Jarvis".
- AWS Bedrock and Deepgram are the only true costs. Both have generous free credit at signup.

---

## How a turn flows

```
   user                renderer                orchestrator              external
    │                     │                         │                       │
    │ press Space ───────►│ client.wake             │                       │
    │                     │────────────────────────►│ beginTurn()           │
    │                     │                         │ open Deepgram WS ────►│ STT
    │                     │ client.audio.frame ────►│ forward frames ──────►│
    │ "what time is it?"  │  (16k PCM, 20ms)        │                       │
    │                     │                         │◄──── transcript ──────│
    │                     │  utterance_end ◄────────│                       │
    │                     │                         │ AgentRouter.route()   │
    │                     │                         │ → orchestrator agent  │
    │                     │                         │ memory.search()       │
    │                     │                         │ messages.stream() ───►│ Bedrock
    │                     │◄── assistant.delta ─────│◄── tool_use blocks ───│
    │ "it's 4:13 PM"      │ browserTts.feed()       │ tool.run() (parallel) │
    │  (spoken)           │                         │◄── continued stream ──│
    │                     │◄── assistant.message ───│                       │
    │                     │                         │ summariser.compact()  │
    │                     │◄── server.phase: idle ──│                       │
```

1. **Wake** — Renderer detects the wake word OR receives a manual trigger. Sends `client.wake` over WS.
2. **Listen** — Orchestrator opens a Deepgram WebSocket. State: `idle → listening → transcribing`.
3. **Capture** — Renderer streams 16 kHz mono PCM frames (20 ms each, base64). Orchestrator pipes them straight to Deepgram.
4. **Endpoint** — Deepgram fires `utterance_end` when the user pauses. Orchestrator closes STT; state → `thinking`.
5. **Route** — A short Claude call (`AgentRouter`) with forced tool use picks the best specialist.
6. **Retrieve** — Orchestrator embeds the user text and finds the top-K most relevant long-term memories from pgvector. These get injected into the agent's system prompt.
7. **Stream** — Agent's `messages.stream()` runs through `ClaudeClient.run()`. Each text delta is fanned out: to the renderer (for transcript + browser TTS) and, if enabled, to ElevenLabs. Tool-use blocks are dispatched to local handlers, results appended back into the conversation, and the loop continues until `end_turn`.
8. **Speak** — Browser's `speechSynthesis` speaks each completed sentence as it arrives (or the renderer plays ElevenLabs PCM frames in server mode).
9. **Interrupt** — If the user starts speaking again, an energy-based VAD on the mic stream fires `client.interrupt`. The orchestrator's `InterruptionManager` cancels the Claude stream, kills the TTS socket, ramps playback gain to zero, and snaps back to `idle`.
10. **Persist** — A background `ConversationSummariser` compacts older turns into 1–3 declarative facts and writes them to the vector store. Older raw history is dropped from the in-memory buffer so context stays bounded.

---

## Repository layout

```
friday/
├── apps/
│   ├── orchestrator/        Node process — owns API keys, runs the pipeline
│   │   └── src/
│   │       ├── index.ts             entry, wires everything together
│   │       ├── state-machine.ts     allowed-transition table per turn phase
│   │       ├── interruption.ts      cancellation tokens, one per turn
│   │       ├── pipeline.ts          turn lifecycle (STT → LLM → TTS)
│   │       ├── ws-server.ts         WebSocket server, message routing
│   │       └── lifecycle.ts         graceful shutdown
│   └── renderer/            Vite + React frontend (the browser app)
│       └── src/
│           ├── App.tsx               root component
│           ├── lib/
│           │   ├── controller.ts     glues WS, audio bridge, browser TTS
│           │   ├── ws-client.ts      reconnecting WebSocket client
│           │   ├── audio-bridge.ts   mic + wake word + playback
│           │   ├── browser-tts.ts    speechSynthesis wrapper
│           │   └── state-store.ts    zustand UI state
│           ├── scene/                Visual presence
│           │   ├── SimpleBackdrop.tsx   CSS-only orb (default)
│           │   └── Scene.tsx + Core/Particles/Rings/Stars
│           │                            Three.js cinematic version
│           │                            (swap in App.tsx to enable)
│           └── ui/                   HUD components
│
├── packages/
│   ├── shared/              Types, event bus, cancellation, logger, config
│   ├── audio/               Browser (wake/mic/playback) + node-safe PCM/VAD
│   ├── stt/                 Deepgram streaming client
│   ├── llm/                 Bedrock-Claude client + tool registry + router
│   ├── tts/                 ElevenLabs streaming WebSocket client
│   ├── memory/              Postgres + pgvector + Bedrock-Cohere embeddings
│   └── tools/               Concrete tool implementations
│
├── scripts/
│   ├── setup.ps1            One-shot Windows setup
│   ├── setup.sh             POSIX equivalent
│   └── dev-all.ps1          Convenience launcher
│
├── docker-compose.yml       Postgres 16 with pgvector preinstalled
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .env.example             Server-side keys (Bedrock, Deepgram, etc.)
└── apps/renderer/.env.example    Browser-side config (WS URL, TTS mode)
```

---

## Configuration reference

All server-side env vars live in `.env` (repo root). Browser-exposed vars live in `apps/renderer/.env` and are prefixed `VITE_`.

### Server (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | _required_ | Bedrock auth (Claude + Cohere). |
| `AWS_SECRET_ACCESS_KEY` | _required_ | |
| `AWS_REGION` | `us-east-1` | Bedrock region. Must match the region where you enabled model access. |
| `AWS_SESSION_TOKEN` | _optional_ | For temporary STS credentials. |
| `BEDROCK_MODEL_ID` | `anthropic.claude-3-sonnet-20240229-v1:0` | Claude model used by every agent. |
| `BEDROCK_EMBEDDING_MODEL_ID` | `cohere.embed-multilingual-v3` | 1024-dim embeddings for memory. |
| `FRIDAY_MAX_TOKENS` | `4096` | Per-turn output cap. |
| `DEEPGRAM_API_KEY` | _required_ | Streaming STT. |
| `DEEPGRAM_MODEL` | `nova-2` | |
| `DEEPGRAM_LANGUAGE` | `en-US` | |
| `ELEVENLABS_API_KEY` | _optional_ | Set to enable server-rendered TTS. Leave blank for text-only / browser TTS. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | Default "Rachel" voice. |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | |
| `FRIDAY_DISABLE_TTS` | `false` | Force-disable server TTS even if the key is set. |
| `DATABASE_URL` | `postgres://postgres:1212@localhost:5432/friday` | Memory store. |
| `PGVECTOR_DIM` | `1024` | Must match the embedding model's dimension. |
| `ORCHESTRATOR_HOST` | `127.0.0.1` | WS bind address. |
| `ORCHESTRATOR_PORT` | `8787` | |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`. |

### Renderer (`apps/renderer/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ORCHESTRATOR_URL` | `ws://127.0.0.1:8787` | WebSocket URL the renderer connects to. Set to `wss://...` for production. |
| `VITE_TTS_MODE` | `browser` | `browser` = free `speechSynthesis`; `server` = play ElevenLabs PCM frames from the orchestrator. |
| `VITE_TTS_VOICE` | _optional_ | Specific OS voice URI. Discover via DevTools: `speechSynthesis.getVoices()`. |
| `VITE_PICOVOICE_ACCESS_KEY` | _optional_ | Enables hands-free wake word. Empty = manual triggers only. |
| `VITE_PORCUPINE_KEYWORD` | `jarvis` | Any of Picovoice's built-ins: `jarvis`, `computer`, `alexa`, `hey google`, etc. |

---

## State machine

```
                       ┌─────────────────┐
       ┌──────────────►│      idle       │◄──────────────┐
       │               └─────────┬───────┘               │
       │                         │ wake / text           │
       │                         ▼                       │
       │               ┌─────────────────┐               │
       │               │   listening     │               │
       │               └─────────┬───────┘               │
       │                         │ stt open              │
       │                         ▼                       │
       │               ┌─────────────────┐               │
       │               │ transcribing    │               │
       │               └─────────┬───────┘               │
       │                         │ endpoint              │
       │                         ▼                       │
       │               ┌─────────────────┐               │
       │               │    thinking     │◄────┐         │
       │               └─────┬───────┬───┘     │         │
       │                     │       │ tool_use         │
       │                     │       ▼         │         │
       │                     │ ┌─────────────┐ │         │
       │                     │ │tool_calling │─┘         │
       │                     │ └─────────────┘           │
       │                     ▼ first text_delta          │
       │               ┌─────────────────┐               │
       │               │    speaking     ├──── end_turn ─┘
       │               └─────────┬───────┘
       │  user barge-in /        │
       │  manual stop  ──────────┴──────────┐
       │                                    │
       │               ┌─────────────────┐  │
       └───────────────┤  interrupted    │◄─┘
                       └─────────────────┘
```

The allowed-transition table lives in `apps/orchestrator/src/state-machine.ts`. Illegal transitions throw — caught defensively in a few places where the timing can race (e.g. rapid wake-word retriggers).

---

## Multi-agent system

Friday isn't "five different models" — it's one Bedrock-hosted Claude wearing different hats. The `AgentRouter` makes a quick tool-forced call to a Claude model with the schema:

```json
{ "agent": "orchestrator | intelligence | memory | voice | ui",
  "reason": "...",
  "confidence": 0.0 - 1.0 }
```

Then the chosen agent receives a tailored **system prompt** + **tool subset** + **temperature/max_tokens** override:

| Agent | When it's picked | Tools available |
|---|---|---|
| `orchestrator` | Default. General conversation, light Q&A, casual commands. | `memory_*`, `compute`, `get_current_time`, `system_info`, `http_get`, `ui_*` |
| `intelligence` | Multi-step reasoning, code questions, planning, research. Lower temperature, bigger token budget. | `http_get`, `compute`, `memory_*` |
| `memory` | Explicit "remember this" / "what did I tell you about X" / "forget X". | `memory_*` |
| `voice` | Reserved for rewriting text for spoken delivery (rarely picked by the router). | none |
| `ui` | Explicit dashboard / display / chart requests. | `ui_*` |

All agent specs live in [`packages/llm/src/agents.ts`](packages/llm/src/agents.ts). Adding a new agent is ~15 lines.

---

## Tools the LLM can call

| Tool | Purpose |
|---|---|
| `get_current_time` | Local time (optionally in a given IANA timezone). |
| `compute` | Safe arithmetic expressions with `Math.*`. |
| `system_info` | CPU count, total/free memory, uptime, OS. |
| `http_get` | Read-only HTTP fetch with body cap, abort signal, no mutation. |
| `memory_remember` | Store a fact in the vector store. |
| `memory_recall` | Semantic search over stored facts. |
| `memory_forget` | Delete a memory by id. |
| `memory_list_recent` | List the N most recent memories for the current session. |
| `ui_show_card` | Render a card on the renderer (info / warn / success / error tones). |
| `ui_show_list` | Render a bullet list. |
| `ui_show_image` | Render an image at a URL. |
| `ui_set_scene` | Switch the orb mood (calm / alert / focused / celebrate). |
| `ui_clear` | Dismiss cards. |

Tools are defined in [`packages/tools/src/`](packages/tools/src). Each tool declares a Zod schema for its input — that schema is auto-converted to JSON Schema and shipped to Claude's tool-use API. Adding a new tool is a single `defineTool({ ... })` block.

---

## Memory system

Two layers:

**Short-term (in-process)**
- The orchestrator keeps a rolling array of `AgentMessage` turns.
- Once it exceeds `bufferTurns * 1.5` (~18 turns by default), the `ConversationSummariser` takes the oldest half, asks Claude to extract 1–3 declarative facts, writes them to the vector store, and drops them from the buffer.

**Long-term (Postgres + pgvector)**
- Cohere Multilingual v3 produces 1024-dim embeddings via Bedrock.
- Cosine distance over an IVFFlat index (`lists=100`) for sub-millisecond retrieval at millions of rows.
- Each retrieval surfaces up to 5 facts that get inserted into the agent's system prompt as a "Relevant memories" block.

Schema is in [`packages/memory/src/migrate.ts`](packages/memory/src/migrate.ts). Migrations are idempotent and auto-create the database if it's missing.

---

## Cancellation & interruption

Every long-running per-turn operation receives a `CancellationToken` from the `InterruptionManager` (one armed turn at a time):

- Claude SDK calls → token's `AbortSignal`
- Deepgram WebSocket → `requestClose()` on cancel
- ElevenLabs WebSocket → hard close on cancel
- Tool executors → `ToolContext.signal`
- Browser audio playback → gain ramps to 0 over 8ms
- Browser TTS → `speechSynthesis.cancel()`

Calling `pipeline.interrupt(reason)` returns synchronously (from the caller's POV) once every component has been notified. Subsequent interrupt calls are no-ops on the same armed turn.

Tested in [`apps/orchestrator/src/interruption.test.ts`](apps/orchestrator/src/interruption.test.ts).

---

## TTS modes

Two modes, switched via `VITE_TTS_MODE` in `apps/renderer/.env`:

**`browser` (default, free)**
- Uses `window.speechSynthesis` directly in the browser.
- Sentence-aware buffering: as soon as Claude emits a complete sentence (`.`, `!`, `?`, `:`, `\n`), it's queued to the synthesizer. Playback starts within ~50 ms of the first sentence.
- Voice quality depends on the OS. Windows 11 has "Natural" voices (Aria, Eric, Jenny) — install them via *Settings → Time & language → Speech*. macOS and Linux have decent built-ins.
- Set `VITE_TTS_VOICE` to a `voiceURI` from `speechSynthesis.getVoices()` to pick a specific one.

**`server` (paid, premium quality)**
- Orchestrator opens a streaming WebSocket to ElevenLabs.
- PCM (24 kHz, mono, Int16) frames stream back; renderer plays them gaplessly via Web Audio scheduling.
- Sub-300 ms first-byte latency with the `eleven_turbo_v2_5` model.
- Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.

If `ELEVENLABS_API_KEY` is empty OR `FRIDAY_DISABLE_TTS=true`, the orchestrator silently runs text-only and the renderer falls back to browser TTS — no broken state.

---

## Wake word (optional)

The default flow is **manual trigger**: press `Space` or click `WAKE`. Hands-free wake word requires a free [Picovoice](https://console.picovoice.ai) access key.

When the key is set:
- The renderer loads Porcupine (WASM, ~1.7 MB) and the chosen keyword model in a Web Worker.
- Mic frames are tapped via `WebVoiceProcessor` (separate from the main capture path) and scanned continuously.
- On detection, the renderer sends `client.wake` to the orchestrator and starts forwarding mic audio for STT.

Supported keywords: `jarvis`, `computer`, `alexa`, `hey google`, `ok google`, `picovoice`, `porcupine`, `bumblebee`, `terminator`, and several more. Set via `VITE_PORCUPINE_KEYWORD`.

To disable wake word entirely, leave `VITE_PICOVOICE_ACCESS_KEY` empty.

---

## Development workflow

```powershell
pnpm dev              # turbo --parallel: orchestrator, renderer
pnpm typecheck        # tsc --noEmit across all workspaces
pnpm test             # vitest run
pnpm build            # production builds in each workspace's dist/
pnpm clean            # remove dist + .turbo
pnpm db:up            # docker compose up -d postgres
pnpm db:down
pnpm migrate          # idempotent: db + extension + tables
```

**Adding a tool**

1. Open one of [`packages/tools/src/system-tools.ts`](packages/tools/src/system-tools.ts) (or write a new file).
2. Call `defineTool({ name, description, tags, input: zodSchema, run })`.
3. The agent whose `toolTags` includes one of your tags will see it automatically.

**Adding an agent**

1. Add an entry to `AGENTS` in [`packages/llm/src/agents.ts`](packages/llm/src/agents.ts) with `systemPrompt`, `toolTags`, and any temperature/maxTokens overrides.
2. Add the new agent id to the router's `enum` in [`packages/llm/src/router.ts`](packages/llm/src/router.ts).

**Re-enabling the cinematic Three.js scene**

In [`apps/renderer/src/App.tsx`](apps/renderer/src/App.tsx) change:
```ts
import { SimpleBackdrop as Scene } from './scene/SimpleBackdrop';
```
to:
```ts
import { Scene } from './scene/Scene';
```
The full Three.js scene (orb with GLSL noise shader, particles, rings, bloom) lives in [`apps/renderer/src/scene/Scene.tsx`](apps/renderer/src/scene/Scene.tsx).

---

## Building for production

```powershell
pnpm build
```

- **Renderer** → `apps/renderer/dist/` is a plain static SPA. Deploy to Vercel / Netlify / S3+CloudFront / nginx / Cloudflare Pages. **At build time** set `VITE_ORCHESTRATOR_URL=wss://orchestrator.your-domain` so the bundled JS points at the right WebSocket.
- **Orchestrator** → `apps/orchestrator/dist/index.js` is a plain Node app. Run under Node ≥ 20 with all `.env` values set in the process environment. Front it with a TLS-terminating reverse proxy (Caddy, nginx, Fly.io's edge) so the renderer can connect via `wss://`.

**Never** put `AWS_*`, `DEEPGRAM_API_KEY`, or `ELEVENLABS_API_KEY` into the renderer environment. Those belong to the orchestrator only.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Reconnecting…` never goes away | Orchestrator isn't listening, or wrong `VITE_ORCHESTRATOR_URL`. | Check the orchestrator's terminal for `ws server listening`. Open DevTools → Console; the WS client logs `[ws] connecting to ...`. |
| `payment_required` in TTS logs | ElevenLabs quota exhausted. | Set `FRIDAY_DISABLE_TTS=true` or switch to `VITE_TTS_MODE=browser`. |
| `password authentication failed for user "friday"` on migrate | Default `DATABASE_URL` doesn't match your Postgres. | Edit `DATABASE_URL` in `.env` to match (e.g. `postgres://postgres:yourpass@localhost:5432/friday`). |
| `database "friday" does not exist` | First-run migration not done. | `pnpm migrate` (it auto-creates the DB). |
| `vector type not found in the database` (one-time warning) | Migration hadn't run yet at startup; the warning is benign and disappears next startup. | Just run `pnpm migrate` once. |
| `Cannot read properties of undefined (reading 'method')` from Bedrock | `@anthropic-ai/sdk` / `bedrock-sdk` version mismatch. | Make sure `pnpm-lock.yaml` matches the committed versions; run `pnpm install`. |
| `Illegal transition: idle -> transcribing` | Pre-fix bug from rapid wake-button mashing. | Already handled — pipeline aborts the late STT-open. If you still see it, share the full log. |
| Wake word not firing | Missing `apps/renderer/public/porcupine_params.pv` OR empty `VITE_PICOVOICE_ACCESS_KEY`. | Run the setup script, or click `WAKE` instead. |
| Mic permission silently denied | Browser remembered a "no" from a previous session. | Click the lock icon in the address bar, set Microphone → Allow, reload. |
| Voice quality is robotic | OS doesn't have neural voices installed. | Windows 11: *Settings → Time & language → Speech → Manage voices* → add "Microsoft Aria (Natural)". |

---

## Tech stack

| Layer | Tech |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Language | TypeScript (strict, ES2022) |
| Server | Node 20+, `ws`, `pino`, `zod` |
| Browser | React 18, Vite, zustand |
| LLM | AWS Bedrock — `anthropic.claude-3-sonnet-20240229-v1:0` via `@anthropic-ai/bedrock-sdk` |
| Embeddings | AWS Bedrock — `cohere.embed-multilingual-v3` |
| STT | Deepgram Nova 2 (streaming) |
| TTS | `speechSynthesis` (default) or ElevenLabs (streaming WS) |
| Wake word | Picovoice Porcupine (WASM, optional) |
| Memory | PostgreSQL 16 + `pgvector` |
| Audio I/O | Web Audio API + AudioWorklet (browser-side) |
| 3D (optional) | Three.js + react-three-fiber + custom GLSL shaders |

---

## License

MIT. See [LICENSE](LICENSE) for details. Copy and adapt freely.
