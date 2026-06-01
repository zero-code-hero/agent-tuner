import { spawn } from "child_process";
import { DEFAULT_MODEL } from "./constants.js";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";

// ThinkingLevel is internal to pi-agent-core and not re-exported.
// Mirror the SDK's union so we can type thinkingLevel without `as any`.
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type RunnerBackend = "pi" | "claude";

export interface RunnerResult {
  text: string;
  toolCalls: Array<{ name: string; args: any; result?: string }>;
  error?: string;
}

export interface RunnerOptions {
  cwd: string;
  model?: string; // provider/model
  thinkingLevel?: ThinkingLevel;
  noContextFiles?: boolean;
  customContext?: string;
  maxTurns?: number;
  backend?: RunnerBackend; // "pi" (SDK) or "claude" (CLI)
  baseUrl?: string; // custom OpenAI-compatible endpoint
}

export class AgentRunner {
  private cwd: string;
  private model: string;
  private thinkingLevel: ThinkingLevel;
  private noContextFiles: boolean;
  private customContext?: string;
  private maxTurns: number;
  private backend: RunnerBackend;
  private baseUrl?: string;

  constructor(opts: RunnerOptions) {
    this.cwd = opts.cwd;
    this.model = opts.model || DEFAULT_MODEL;
    this.thinkingLevel = (opts.thinkingLevel || "off") as ThinkingLevel;
    this.noContextFiles = opts.noContextFiles || false;
    this.customContext = opts.customContext;
    this.maxTurns = opts.maxTurns || 25;
    this.backend = opts.backend || "pi";
    this.baseUrl = opts.baseUrl;
  }

  async run(prompt: string): Promise<RunnerResult> {
    if (this.backend === "claude") {
      return this.runViaClaude(prompt);
    }
    return this.runViaPi(prompt);
  }

  // ─── Pi SDK backend ───

  private async runViaPi(prompt: string): Promise<RunnerResult> {
    // Resolve the model through the typed ModelRegistry — no internal API hacks
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.create(authStorage);
    const [provider, modelId] = this.model.split("/");
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      return { text: "", toolCalls: [], error: `Model not found: ${this.model}` };
    }

    // Build loader options using the public constructor — no `as any` hacks.
    // DefaultResourceLoader accepts noContextFiles and agentsFilesOverride natively.
    // agentsFilesOverride receives the resolved agents files config; we extend it
    // with a virtual context file. Type the callback param as the shape the SDK passes.
    type AgentsFilesEntry = { path: string; content: string };
    type AgentsFilesConfig = { agentsFiles: AgentsFilesEntry[] };
    type AgentsFilesOverride = (base: AgentsFilesConfig) => AgentsFilesConfig;

    const customCtx = this.customContext;
    const overrideFn: AgentsFilesOverride | undefined = customCtx
      ? (base: AgentsFilesConfig) => ({
          agentsFiles: [
            ...base.agentsFiles,
            { path: "/virtual/context.md", content: customCtx },
          ],
        })
      : undefined;

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
      noContextFiles: this.noContextFiles,
      ...(overrideFn ? { agentsFilesOverride: overrideFn } : {}),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      thinkingLevel: this.thinkingLevel,
      tools: ["read", "bash", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    // Pending tool call queue — keyed by sequence ID for 1:1 correlation
    // between execution_start and execution_end events. The SDK emits a
    // `toolCallId` on both events when available; fall back to strict FIFO
    // when it doesn't. This handles both sequential and parallel tool calls.
    const pendingCalls = new Map<string, { name: string; args: any; resolved: boolean }>();
    let nextSeq = 0;
    const toolCalls: Array<{ name: string; args: any; result?: string }> = [];
    let turnCount = 0;

    const unsub = session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        // Prefer the SDK's own toolCallId; synthesize a sequence key as fallback.
        const key = event.toolCallId ?? `seq:${nextSeq++}`;
        pendingCalls.set(key, { name: event.toolName, args: event.args, resolved: false });
        toolCalls.push({ name: event.toolName, args: event.args });
      }
      if (event.type === "tool_execution_end") {
        // Match by toolCallId if the SDK provides it, otherwise pop the oldest
        // unresolved pending call (FIFO — safe for sequential invocations).
        const endKey = event.toolCallId ?? null;
        let targetKey: string | null = endKey ?? null;

        if (targetKey && pendingCalls.has(targetKey)) {
          // direct match
        } else {
          // FIFO fallback: find oldest unresolved
          for (const [k, pending] of pendingCalls.entries()) {
            if (!pending.resolved) { targetKey = k; break; }
          }
        }

        if (targetKey) {
          const pending = pendingCalls.get(targetKey);
          if (pending && !pending.resolved) {
            pending.resolved = true;
            const tc = toolCalls.find((t) => !t.result);
            if (tc) tc.result = event.result?.content?.[0]?.text || "";
            pendingCalls.delete(targetKey);
          }
        }
      }
      if (event.type === "turn_start") {
        turnCount++;
        if (turnCount > this.maxTurns) session.abort();
      }
    });

    let promptError: string | undefined;
    try {
      await session.prompt(prompt);
    } catch (e: any) {
      promptError = e.message || String(e);
    }

    unsub();
    try {
      session.dispose();
    } catch (e: any) {
      // dispose can throw if session is already disposed or in bad state
      if (process.env.DEBUG) console.warn(`⚠️  Error disposing session: ${e.message}`);
    }

    // Extract last assistant text. Handle both array content blocks and
    // plain string content. Prefer the last assistant message in order.
    let text = "";
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role !== "assistant" || !m.content) continue;
      if (typeof m.content === "string") {
        text = m.content;
        break;
      }
      if (Array.isArray(m.content)) {
        // Collect text and thinking blocks. The Pi SDK content union is
        // "text" | "thinking" | "toolCall" — there is no "reasoning" type,
        // so we don't check for it.
        const allTexts: string[] = [];
        for (const b of m.content) {
          if (b.type === "text" && typeof b.text === "string") allTexts.push(b.text);
          if (b.type === "thinking" && typeof b.thinking === "string") allTexts.push(b.thinking);
        }
        text = allTexts.join("\n\n").trim();
        if (text) break;
      }
    }

    return { text, toolCalls, error: promptError };
  }

  // ─── Claude Code CLI backend ───

  private runViaClaude(prompt: string): Promise<RunnerResult> {
    return new Promise((resolve) => {
      // -p: non-interactive print mode (claude CLI requires this for stdin prompts)
      // --output-format stream-json + --verbose: emit NDJSON events for
      //         assistant messages, tool_use blocks, tool_result blocks, and
      //         the final result. This is the only reliable way to recover
      //         tool calls — the prior regex over plain text was matching
      //         "(read|bash|grep|find|ls)\s+", but claude's real tool names
      //         are "Bash" / "Read" / "Edit" (PascalCase) and the default
      //         text format doesn't print them in a parseable way at all.
      // --bare: skip hooks, LSP, plugin sync, auto-memory, CLAUDE.md auto-discovery
      //         (this is how we starve the fresh agent of AGENTS.md / CLAUDE.md context)
      // --dangerously-skip-permissions: required for tool use in -p mode. Without
      //         this the agent has no tools, so the "fresh agent explores the
      //         codebase" premise collapses into hallucinated answers from training
      //         data + the prompt. The test-agent prompt explicitly tells the agent
      //         to use tools, so we MUST grant them.
      // Note: there is no `--no-continue` flag — continuation is opt-in via `-c`,
      // so omitting `-c` is sufficient.
      const args: string[] = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (this.noContextFiles) {
        args.push("--bare");
        // Block the obvious bypass: even with on-disk docs hidden, the agent
        // can run `git show HEAD:AGENTS.md` and pull the real content from
        // git history. Deny git via the Bash tool. Pass exactly ONE pattern —
        // passing multiple patterns as separate args confuses the variadic
        // parser and ends up denying way more than intended.
        // Pattern syntax: "Bash(<cmd> *)" matches that command + any args.
        args.push("--disallowedTools", "Bash(git *)");
      }

      // Map our model to claude's format
      const [provider, modelId] = this.model.split("/");
      if (provider === "anthropic") {
        args.push("--model", modelId || "sonnet");
      } else {
        args.push("--model", this.model);
      }

      const proc = spawn("claude", args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_NO_UPDATE: "1" },
      });

      let stdout = "";
      let stderr = "";
      const toolCalls: Array<{ name: string; args: any; result?: string }> = [];

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        // Parse stream-json NDJSON events. Each line is a JSON object with
        // {type, ...}. Pull tool_use blocks from "assistant" events, match
        // them to tool_result blocks in following "user" events, take final
        // text from the terminal "result" event.
        const pendingToolIds = new Map<string, number>(); // tool_use_id -> toolCalls index
        let finalText = "";
        let lastAssistantText = "";
        let claudeError: string | undefined;

        for (const rawLine of stdout.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block?.type === "tool_use" && typeof block.id === "string") {
                const idx = toolCalls.length;
                toolCalls.push({ name: block.name, args: block.input, result: "" });
                pendingToolIds.set(block.id, idx);
              }
              if (block?.type === "text" && typeof block.text === "string") {
                lastAssistantText = block.text;
              }
            }
          }

          if (event.type === "user" && event.message?.content) {
            for (const block of event.message.content) {
              if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
                const idx = pendingToolIds.get(block.tool_use_id);
                if (idx !== undefined) {
                  let resultText = "";
                  if (typeof block.content === "string") {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    for (const c of block.content) {
                      if (c?.type === "text" && typeof c.text === "string") resultText += c.text;
                    }
                  }
                  toolCalls[idx].result = resultText;
                  pendingToolIds.delete(block.tool_use_id);
                }
              }
            }
          }

          if (event.type === "result") {
            if (event.is_error && typeof event.result === "string") {
              claudeError = event.result;
            } else if (typeof event.result === "string") {
              finalText = event.result;
            }
          }
        }

        // Prefer the terminal "result" event's text; fall back to the last
        // assistant text block if the result event was missing or empty.
        const text = (finalText || lastAssistantText).trim();

        if (claudeError) {
          resolve({ text, toolCalls, error: claudeError });
        } else if (code !== 0 && !text) {
          resolve({ text: "", toolCalls, error: `claude exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ text, toolCalls });
        }
      });

      proc.on("error", (e) => {
        resolve({ text: "", toolCalls, error: `Failed to spawn claude: ${e.message}` });
      });

      // Send the prompt
      proc.stdin.write(prompt + "\n");
      proc.stdin.end();
    });
  }
}
