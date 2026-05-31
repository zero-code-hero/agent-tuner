import { spawn } from "child_process";
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
    this.model = opts.model || "anthropic/claude-sonnet-4-20250514";
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
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const [provider, modelId] = this.model.split("/");
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      return { text: "", toolCalls: [], error: `Model not found: ${this.model}` };
    }

    // Build loader options using the public constructor — no `as any` hacks.
    // DefaultResourceLoader accepts noContextFiles and agentsFilesOverride natively.
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
      noContextFiles: this.noContextFiles,
      ...(this.customContext ? {
        agentsFilesOverride: (base: any) => ({
          agentsFiles: [
            ...base.agentsFiles,
            { path: "/virtual/context.md", content: this.customContext },
          ],
        }),
      } : {}),
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
    // between execution_start and execution_end events. Avoids fragile
    // JSON.stringify arg matching that breaks on unordered keys or functions.
    const pendingCalls = new Map<number, { name: string; args: any; resolved: boolean }>();
    let nextSeq = 0;
    const toolCalls: Array<{ name: string; args: any; result?: string }> = [];
    let turnCount = 0;

    const unsub = session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        const seq = nextSeq++;
        pendingCalls.set(seq, { name: event.toolName, args: event.args, resolved: false });
        toolCalls.push({ name: event.toolName, args: event.args });
      }
      if (event.type === "tool_execution_end") {
        // Match by sequence: pop the oldest unresolved pending call.
        // The SDK emits start/end in strict order per tool invocation,
        // so FIFO correlation is safe and immune to duplicate args.
        for (const [seq, pending] of pendingCalls.entries()) {
          if (!pending.resolved) {
            pending.resolved = true;
            const tc = toolCalls.find((t) => !t.result);
            if (tc) tc.result = event.result?.content?.[0]?.text || "";
            pendingCalls.delete(seq);
            break;
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
        // SDK content blocks are a union (TextContent | ThinkingContent | ToolCall).
        // Only TextContent has a .text field. Check the type tag safely.
        const textBlock = m.content.find((b: any) => b.type === "text" && typeof b.text === "string");
        if (textBlock) { text = (textBlock as any).text; break; }
      }
      if (text) break;
    }

    return { text, toolCalls, error: promptError };
  }

  // ─── Claude Code CLI backend ───

  private runViaClaude(prompt: string): Promise<RunnerResult> {
    return new Promise((resolve) => {
      const args: string[] = ["-p", "--no-continue"];
      if (this.noContextFiles) args.push("--no-context-files");

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
        // Parse tool calls from claude output (it prints tool usage)
        const lines = stdout.split("\n");
        for (const line of lines) {
          const toolMatch = line.match(/^(read|bash|grep|find|ls)\s+(.*)/);
          if (toolMatch) {
            toolCalls.push({ name: toolMatch[1], args: { command: toolMatch[2] }, result: "" });
          }
        }

        // Clean up the output — remove claude's decorative chars
        let text = stdout
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "") // strip ANSI
          .replace(/^[\s❯▶▸►→·•-]+/gm, "") // strip bullet chars
          .trim();

        if (code !== 0 && !text) {
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
