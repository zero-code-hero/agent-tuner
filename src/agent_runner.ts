import { spawn } from "child_process";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, getModel } from "@earendil-works/pi-coding-agent";

export type RunnerBackend = "pi" | "claude";

export interface RunnerResult {
  text: string;
  toolCalls: Array<{ name: string; args: any; result?: string }>;
  error?: string;
}

export interface RunnerOptions {
  cwd: string;
  model?: string; // provider/model
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  noContextFiles?: boolean;
  customContext?: string;
  maxTurns?: number;
  backend?: RunnerBackend; // "pi" (SDK) or "claude" (CLI)
  baseUrl?: string; // custom OpenAI-compatible endpoint
}

export class AgentRunner {
  private cwd: string;
  private model: string;
  private thinkingLevel: string;
  private noContextFiles: boolean;
  private customContext?: string;
  private maxTurns: number;
  private backend: RunnerBackend;
  private baseUrl?: string;

  constructor(opts: RunnerOptions) {
    this.cwd = opts.cwd;
    this.model = opts.model || "anthropic/claude-sonnet-4-20250514";
    this.thinkingLevel = opts.thinkingLevel || "off";
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
    const [provider, modelId] = this.model.split("/");
    const model = getModel(provider, modelId);
    if (!model) {
      return { text: "", toolCalls: [], error: `Model not found: ${this.model}` };
    }

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });

    // ─── Context file override ───
    // agentsFilesOverride is an internal pi SDK hook. If it's missing or fails
    // and noContextFiles is set, the fresh-agent test is invalid — fail loud.
    const loaderAny = loader as any;
    const hasOverride = typeof loaderAny.agentsFilesOverride !== "undefined";

    if (this.noContextFiles) {
      if (!hasOverride) {
        return {
          text: "",
          toolCalls: [],
          error:
            "Cannot run fresh-agent test: Pi SDK does not expose agentsFilesOverride. " +
            "The test requires stripping AGENTS.md/CLAUDE.md but the SDK version doesn't support it.",
        };
      }
      try {
        loaderAny.agentsFilesOverride = () => ({ agentsFiles: [] });
      } catch (e: any) {
        return {
          text: "",
          toolCalls: [],
          error: `Failed to strip context files for fresh-agent test: ${e.message}`,
        };
      }
    } else if (this.customContext && hasOverride) {
      try {
        const orig = loaderAny.agentsFilesOverride;
        loaderAny.agentsFilesOverride = (current: any) => ({
          agentsFiles: [
            ...(orig ? orig(current).agentsFiles : current.agentsFiles),
            { path: "/virtual/context.md", content: this.customContext },
          ],
        });
      } catch (e: any) {
        if (process.env.DEBUG) console.warn(`⚠️  Failed to inject custom context: ${e.message}`);
      }
    } else if (this.customContext && !hasOverride) {
      if (process.env.DEBUG) console.warn("⚠️  Custom context requested but agentsFilesOverride not available — skipping injection");
    }

    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      thinkingLevel: this.thinkingLevel as any,
      tools: ["read", "bash", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    // Pending tool call queue — keyed by sequence ID to avoid race conditions
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
        // Match by finding the first unresolved pending call with matching name+args
        for (const [seq, pending] of pendingCalls.entries()) {
          if (!pending.resolved && pending.name === event.toolName && JSON.stringify(pending.args) === JSON.stringify(event.args)) {
            pending.resolved = true;
            const tc = toolCalls.find((t) => t.name === event.toolName && JSON.stringify(t.args) === JSON.stringify(event.args));
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

    let text = "";
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "assistant" && m.content) {
        const blocks = Array.isArray(m.content) ? m.content : [{ text: m.content }];
        for (const b of blocks) {
          if (b.type === "text" && b.text) { text = b.text; break; }
        }
        if (text) break;
      }
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
