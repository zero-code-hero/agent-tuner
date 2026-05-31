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

    if (this.noContextFiles) {
      (loader as any).agentsFilesOverride = () => ({ agentsFiles: [] });
    } else if (this.customContext) {
      const orig: any = (loader as any).agentsFilesOverride;
      (loader as any).agentsFilesOverride = (current: any) => ({
        agentsFiles: [
          ...(orig ? orig(current).agentsFiles : current.agentsFiles),
          { path: "/virtual/context.md", content: this.customContext },
        ],
      });
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

    const toolCalls: Array<{ name: string; args: any; result?: string }> = [];
    let turnCount = 0;

    const unsub = session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        toolCalls.push({ name: event.toolName, args: event.args });
      }
      if (event.type === "tool_execution_end") {
        const tc = toolCalls.find(
          (t) => t.name === event.toolName && JSON.stringify(t.args) === JSON.stringify(event.args)
        );
        if (tc) tc.result = event.result?.content?.[0]?.text || "";
      }
      if (event.type === "turn_start") {
        turnCount++;
        if (turnCount > this.maxTurns) session.abort();
      }
    });

    try {
      await session.prompt(prompt);
    } catch {}

    unsub();
    session.dispose();

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

    return { text, toolCalls };
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
