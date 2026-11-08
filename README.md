# dsh-orchestrator

[![ci](https://github.com/anthony1x6000/dsh-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-orchestrator/actions/workflows/ci.yml)

Caveman orchestrator mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One job: plan in very simple words, then send the work to worker agents. Two
worker models are picked beside the composer's main model seat: **Media** for
creative work and **Text** for code work. The orchestrator can also send a task
to any model the user names.

## Install

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-orchestrator#main"
```

Local development uses a linked checkout instead:

```sh
pnpm install
dsh plugin --profile web add link:$PWD
```

The bundle adds:

- Agent preset **Orchestrator** (pick it in New Session or the preset picker).
- Composer controls **Media** and **Text**, left of the main model seat.
- Host tools `media_agent`, `text_agent`, `subagent_model`, and `list_models`,
  visible only inside the Orchestrator preset.

## Use

1. Start a chat and pick the **Orchestrator** mode.
2. Pick the **Media** worker model and the **Text** worker model in the composer.
3. Ask for work. The orchestrator writes a short numbered plan, calls the
   matching worker, ends its turn, and reports when the worker finishes.

The user can say which worker to use:

- `use media for the Blender scene`
- `use text for the Java test`
- `use hy4 for this one` (the orchestrator calls `subagent_model` with the
  exact provider and model it sees in its live model list)

The orchestrator speaks caveman: short sentences, simple words, every technical
fact kept. Worker prompts stay normal technical English.

## Model memory

The last main model used in an Orchestrator chat is remembered for the next
Orchestrator chat only. Other modes keep their own behavior. The Media and Text
worker picks are global and last until changed.

## Config

The Loader row `orchestrator` stores the picks. The composer writes them through
the settings service; manual edits are also valid:

| Field | Meaning |
|---|---|
| `mediaProvider` / `mediaModel` | Media worker route |
| `textProvider` / `textModel` | Text worker route |
| `mainProvider` / `mainModel` / `mainEffort` | Remembered orchestrator main model |
| `childPreset` | Preset given to worker children (default `standard`, full toolset) |

All fields except `childPreset` are volatile: a picker change applies without
remounting the plugin.

## Design notes

- Worker routes are plugin Config, not session state. The approved durable store
  is the config editor, and volatile fields update in place.
- The Media/Text controls register in the `conversation.input.right` slot, which
  renders immediately before `conversation.input.model` in the composer toolbar.
- The Host gate checks the live Agent preset, so the worker tools and the worker
  prompt block never appear in Standard, PTC, Minimal, or worker children.
- Delegation uses the in-process `spawn` provider, `delivery: 'parent'`, and the
  configured child preset. The orchestrator gets completion notices; it does not
  block a turn waiting.
