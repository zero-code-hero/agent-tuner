# Agent Tuner

Adversarial self-improvement loop for generating `AGENTS.md` files.

One agent generates questions about a codebase. A fresh agent (with no docs) tries to answer them. Failures become rules. Repeat until the score plateaus.

## How it works

```
Iteration N (depth N):

  1. Generator Agent: scan codebase → generate QUESTIONS
     ("How do I run tests?", "Where do new routes go?")

  2. Fresh Agent (NO AGENTS.md): tries to answer by exploring code

  3. Results:
     ✓ Answered  → no doc needed
     ✗ Failed    → gap → becomes a rule candidate

  4. LLM scores rules → keeps the valuable ones → writes AGENTS.md

  5. Next iteration: deeper scan, harder questions, learns from failures
```

**Depth progression:**

| Depth | What it scans |
|-------|---------------|
| 1 | file types, configs, package manager, structure |
| 2 | imports, error handling, commit patterns, npm scripts |
| 3 | code style, architecture, env vars, README |
| 4 | anti-patterns, pitfalls, branching strategy, dependencies |

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Full loop (default: 5 iterations)
npx tsx src/cli.ts ./my-project

# Single pass — scan and generate, no loop
npx tsx src/cli.ts ./my-project --once

# Dry run
npx tsx src/cli.ts ./my-project --dry-run

# Verbose — see questions, answers, failures
npx tsx src/cli.ts ./my-project -v

# Custom model
npx tsx src/cli.ts ./my-project -m openai/gpt-4o

# Custom OpenAI-compatible endpoint (e.g. local LLM, proxy)
npx tsx src/cli.ts ./my-project --base-url http://localhost:8080 -m custom/local-model

# Anthropic via OpenAI-compatible proxy
npx tsx src/cli.ts ./my-project --base-url https://api.anthropic.com/v1 -m anthropic/claude-sonnet-4-20250514

# Resume interrupted run
npx tsx src/cli.ts ./my-project --resume

# Merge with existing AGENTS.md
npx tsx src/cli.ts ./my-project --merge
```

## Env vars

```bash
export ANTHROPIC_API_KEY="..."   # for anthropic/* or claude* models
export OPENAI_API_KEY="..."      # for openai/* or gpt* models
export GOOGLE_API_KEY="..."      # for google/* or gemini* models
export LLM_API_KEY="..."         # fallback / custom endpoints
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <path>` | Output file | `AGENTS.md` |
| `-m, --model <model>` | LLM model (`provider/model`) | `anthropic/claude-sonnet-4-5-20250929` |
| `-t, --threshold <n>` | Min score to keep (1-10) | `6` |
| `-n, --iterations <n>` | Max iterations | `5` |
| `-b, --base-url <url>` | Custom API base URL | — |
| `-v, --verbose` | Show details | off |
| `--dry-run` | Print without writing | off |
| `--merge` | Merge with existing | off |
| `--once` | Single pass (no loop) | off |
| `--resume` | Resume from saved state | off |

## State

Saved to `.agent-tuner-state.json` in the repo root. Use `--resume` to continue. Delete it to start fresh.

## Architecture

| File | Role |
|------|------|
| `discover.ts` | Depth-aware codebase scanning |
| `questions.ts` | LLM generates questions from context |
| `test_agent.ts` | Fresh agent (no docs) tries to answer |
| `generate.ts` | Converts failures into rule candidates |
| `llm_score.ts` | LLM scores rules for actionable value |
| `state.ts` | Iteration state, persistence, plateau detection |
| `cli.ts` | Orchestrates the loop |
