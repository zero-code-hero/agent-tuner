import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState, Question, QuestionResult } from "./state.js";
import { freshAgentContext } from "./context_builder.js";
import { AgentRunner, type RunnerBackend } from "./agent_runner.js";
import { tryParseJsonArray } from "./json_parse.js";

// Files the fresh agent must NOT see — otherwise it bypasses the test by
// reading any doc file it can find. We:
//   1. Hide the well-known root files (AGENTS.md, CLAUDE.md, both casings).
//   2. Walk a curated set of doc directories (.claude/, docs/, .cursor/) up
//      to a shallow depth and hide any *.md / SKILL.md / runbook file there.
//   3. Truncate each to a placeholder string (not rename — earlier rename
//      approach was trivially bypassed by `ls` + Read).
//   4. Stash real contents in memory and restore in finally / signal handlers.
//
// Note: we deliberately do NOT hide README.md or per-package docstrings —
// those describe what the code is, not how to work in this codebase, and a
// fresh agent should be able to use them. The line we're drawing is "docs
// targeted at AI agents".
// AI-rules files: any file whose ENTIRE PURPOSE is to instruct AI agents.
// These tend to be near-duplicates of each other across tools (Cursor mirrors
// AGENTS.md, Windsurf mirrors that, etc.). They're what we're AUDITING, so
// they all need to be hidden together — otherwise the audit just measures
// "is this rule duplicated in another agent-rules file" and marks everything
// redundant trivially.
const HIDDEN_ROOT_DOCS = [
  "AGENTS.md", "CLAUDE.md", "agents.md", "claude.md",
  ".windsurfrules", ".clinerules", ".roomodes",
  ".aider.conf.yml", ".continuerc",
];
// Whole directories that are AI-rules stores (not just any markdown).
// .claude/ is INTENTIONALLY EXCLUDED — its skills/runbooks/agents are the
// actual workflow docs the working agent uses, and rules duplicating them
// can legitimately be considered redundant.
// .swm/ is Swimm — also a working doc store, intentionally excluded.
const HIDDEN_DOC_DIRS = [
  ".cursor",          // .cursor/rules/rules.mdc is literal "AGENTS.md for Cursor"
  ".github/copilot",  // Copilot instruction files
];
// Specific Copilot instruction file lives under .github/
const HIDDEN_SPECIFIC_PATHS = [
  ".github/copilot-instructions.md",
];
// Also hide nested AGENTS.md / CLAUDE.md anywhere in the tree (e.g.
// msfrontend/AGENTS.md). Bounded by MAX_TREE_DEPTH so we don't walk
// node_modules etc.
const NESTED_DOC_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"]);
const MAX_DEPTH = 4;
const MAX_TREE_DEPTH = 6;
const SKIP_DIRS = new Set([
  "node_modules", "vendor", ".git", ".next", "dist", "build",
  "coverage", "__pycache__", "target", ".venv", "venv", ".tox",
]);
const PLACEHOLDER = "<intentionally blank during agent-tuner evaluation>\n";

interface StashedDoc {
  path: string;
  content: string;
}

interface StashedDir {
  from: string;
  to: string;
}

interface StashState {
  files: StashedDoc[];
  dirs: StashedDir[];
}

function isHidableDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  // Within an AI-rules directory (e.g. .cursor/), grab markdown variants:
  //   .md   - generic
  //   .mdc  - Cursor's "markdown with config frontmatter"
  //   .yaml/.yml - rare but used by some tools
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".mdc") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml")
  );
}

function collectDocFiles(root: string): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (st.isFile() && isHidableDocFile(entry)) {
        found.push(full);
      }
    }
  }
  return found;
}

// Walk the repo (avoiding node_modules etc.) and collect any nested
// AGENTS.md / CLAUDE.md files. Per-package agent docs (e.g.
// msfrontend/AGENTS.md, packages/foo/CLAUDE.md) are common.
function collectNestedAgentDocs(root: string): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_TREE_DEPTH) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (st.isFile() && NESTED_DOC_NAMES.has(entry)) {
        found.push(full);
      }
    }
  }
  return found;
}

// ─── Worktree sandbox (preferred when the repo is a git checkout) ───
//
// Create a git worktree in a temp dir and use it as the agent's cwd. The
// worktree contains a checkout of HEAD; we delete the doc files in the
// worktree (real deletion, not placeholder — the agent can't even see them
// in `ls`). The original repo is completely untouched.
//
// On finish (or SIGINT) we `git worktree remove --force`, which detaches and
// deletes the worktree directory in one step. If the remove fails the user
// has a stray worktree under /tmp; we print the cleanup command.
//
// Falls back to in-place hiding if `git worktree add` fails (non-git repo,
// detached/dirty HEAD that won't check out, etc.).

interface Worktree {
  path: string;             // /tmp/agent-tuner-worktree-XXXXXX
  originalRepo: string;     // the user's repo
}

function tryCreateWorktree(repoPath: string): Worktree | null {
  if (!existsSync(join(repoPath, ".git"))) return null;
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "agent-tuner-worktree-"));
    // rmSync the empty tempdir — git worktree add wants a non-existing path
    rmSync(tempDir, { recursive: true, force: true });
  } catch (e: any) {
    console.error(`⚠️  Could not create temp dir for worktree: ${e.message}`);
    return null;
  }
  try {
    // --detach: don't create a branch, just check out HEAD detached.
    // No -b/-B to avoid polluting branch state.
    execFileSync("git", ["-C", repoPath, "worktree", "add", "--detach", tempDir, "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { path: tempDir, originalRepo: repoPath };
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() || e.message;
    console.error(`⚠️  git worktree add failed: ${stderr.trim()}`);
    console.error("   Falling back to in-place doc hiding (still effective but riskier).");
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}

function removeWorktree(wt: Worktree): void {
  // Just rm -rf the worktree dir and prune the main repo's worktree refs.
  // We can't use `git worktree remove` because we deleted the worktree's
  // .git pointer file during sanitize, and git refuses to remove a worktree
  // without that pointer (it considers it "not a worktree").
  // `worktree prune` cleans up dangling refs in the main .git/worktrees/.
  try {
    rmSync(wt.path, { recursive: true, force: true });
  } catch (e: any) {
    console.error(`❌ Failed to remove worktree dir at ${wt.path}: ${e.message}`);
    console.error(`   Manually clean: rm -rf "${wt.path}"`);
  }
  try {
    execFileSync("git", ["-C", wt.originalRepo, "worktree", "prune"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() || e.message;
    console.error(`⚠️  git worktree prune failed in ${wt.originalRepo}: ${stderr.trim()}`);
    console.error(`   Run manually: git -C "${wt.originalRepo}" worktree prune`);
  }
}

// Delete AGENTS.md / CLAUDE.md (root + nested) from the worktree. We
// deliberately do NOT delete .claude/skills, .swm, README, docs/ — those
// are legitimate alternative doc sources the working agent uses anyway. If
// a rule in AGENTS.md is also documented in .claude/skills, that's evidence
// the AGENTS.md rule may be redundant, which is what we want to surface.
//
// Also remove the worktree's `.git` pointer file. A worktree's .git is a
// small text file like "gitdir: /main/.git/worktrees/xxx" that connects it
// back to the main repo's history. Deleting that file disconnects the
// worktree from git entirely, so the agent cannot run `git show HEAD:AGENTS.md`
// to recover doc content from history. The MAIN repo's .git is untouched.
//
// All destructive ops are on the WORKTREE only. The worktree itself gets
// removed at the end of the run.
function sanitizeWorktree(worktreePath: string): number {
  let count = 0;
  const candidates = new Set<string>();
  // AI-rules files at the repo root
  for (const name of HIDDEN_ROOT_DOCS) candidates.add(join(worktreePath, name));
  // Known specific paths (e.g. .github/copilot-instructions.md)
  for (const rel of HIDDEN_SPECIFIC_PATHS) candidates.add(join(worktreePath, rel));
  // AI-rules directories — recursively collect all files within
  for (const docDir of HIDDEN_DOC_DIRS) {
    const dirPath = join(worktreePath, docDir);
    if (existsSync(dirPath)) {
      for (const f of collectDocFiles(dirPath)) candidates.add(f);
    }
  }
  // Nested AGENTS.md / CLAUDE.md anywhere in the tree
  for (const f of collectNestedAgentDocs(worktreePath)) candidates.add(f);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      count++;
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not delete ${path} from worktree: ${e.message}`);
    }
  }

  // Disconnect from git history.
  const gitPointer = join(worktreePath, ".git");
  if (existsSync(gitPointer)) {
    try {
      // In a worktree, .git is a file (pointer), not a directory.
      const st = statSync(gitPointer);
      if (st.isFile()) {
        unlinkSync(gitPointer);
      } else if (st.isDirectory()) {
        // Defensive — shouldn't happen for a worktree, but if it does,
        // a recursive remove is safe because we're inside the worktree only.
        rmSync(gitPointer, { recursive: true, force: true });
      }
    } catch (e: any) {
      console.error(`⚠️  Could not disconnect worktree from git: ${e.message}`);
      console.error("   Agent may still bypass doc hiding via git history.");
    }
  }

  return count;
}

function hideDocs(repoPath: string): StashedDoc[] {
  const stashed: StashedDoc[] = [];
  // De-duplicate by inode (statSync().ino). On case-insensitive filesystems
  // AGENTS.md and agents.md share an inode; realpath alone wasn't reliable
  // here. statSync().ino is the authoritative same-file check on any FS.
  const byInode = new Map<string, string>();
  const addCandidate = (p: string) => {
    if (!existsSync(p)) return;
    let key: string;
    try {
      const st = statSync(p);
      // Combine dev + ino so paths on different volumes don't collide.
      key = `${st.dev}:${st.ino}`;
    } catch { key = p; }
    if (!byInode.has(key)) byInode.set(key, p);
  };

  // Well-known root files
  for (const name of HIDDEN_ROOT_DOCS) addCandidate(join(repoPath, name));

  // Agent-targeted doc directories
  for (const docDir of HIDDEN_DOC_DIRS) {
    const dirPath = join(repoPath, docDir);
    if (!existsSync(dirPath)) continue;
    for (const f of collectDocFiles(dirPath)) addCandidate(f);
  }

  // Nested AGENTS.md / CLAUDE.md anywhere in the tree
  for (const f of collectNestedAgentDocs(repoPath)) addCandidate(f);

  const toHide = Array.from(byInode.values());
  for (const path of toHide) {
    try {
      const content = readFileSync(path, "utf-8");
      // Safety: if the file ALREADY contains only the placeholder, a previous
      // run crashed without restoring. Refuse to stash this — otherwise we'd
      // "restore" the placeholder as the real content, corrupting the file
      // permanently. Skip it (it's already hidden, that's fine for this run)
      // and warn loudly so the user can `git checkout` to recover.
      if (content.trim() === PLACEHOLDER.trim()) {
        console.error(`⚠️  ${path} contains only the agent-tuner placeholder — a previous run did not restore properly.`);
        console.error(`   Run: git checkout -- "${path}"   to restore from git, then re-run.`);
        continue;
      }
      writeFileSync(path, PLACEHOLDER);
      stashed.push({ path, content });
    } catch (e: any) {
      restoreDocs(stashed);
      throw new Error(`Could not stash ${path} before fresh-agent run: ${e.message}`);
    }
  }
  return stashed;
}

function restoreDocs(stashed: StashedDoc[]): void {
  for (const { path, content } of stashed) {
    try {
      writeFileSync(path, content);
    } catch (e: any) {
      console.error(`❌ FAILED to restore ${path}: ${e.message}`);
      console.error(`   Content was stashed in memory and is now lost. Recover via:`);
      console.error(`   git checkout -- ${path}`);
    }
  }
}

import { DEFAULT_MODEL } from "./constants.js";

const TEST_AGENT_PROMPT = `You are a completely FRESH AI agent dropped into this codebase.

You have NO prior knowledge. No AGENTS.md, no CLAUDE.md, no onboarding docs.
You have tools to explore: read files, run bash commands, grep, find, ls.

Your task: answer these questions by exploring the codebase. Use your tools.
- Read files to understand conventions, architecture, patterns
- Use grep/find to locate relevant code
- Be honest about what you can and cannot find

CRITICAL: Return a COMPLETE valid JSON array as your ONLY output. No explanation. No markdown. Just raw JSON.

[{"questionId":"iter0_q0","answered":true,"answer":"answer text","confidence":0.9,"evidence":["file1.ts"],"docsNeeded":null},{"questionId":"iter0_q1","answered":false,"answer":null,"confidence":0.2,"evidence":[],"failureReason":"couldn't find X","docsNeeded":"..."}]

Questions:
{questions}

Codebase info:
{context}`;

export async function testFreshAgent(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  state: TunerState,
  questions: Question[],
  model: string = DEFAULT_MODEL,
  baseUrl?: string,
  backend: RunnerBackend = "pi",
): Promise<QuestionResult[]> {
  const questionsText = questions
    .map((q) => `  - [${q.id}] (${q.category}, difficulty ${q.difficulty}) ${q.text}`)
    .join("\n");

  // Sandbox the fresh agent so it can't read AGENTS.md / CLAUDE.md from the
  // working tree OR from git history. Preferred path: git worktree to a
  // temp dir, delete the doc files there, disconnect from git history by
  // removing the worktree's .git pointer file. Worktree gets removed in
  // finally / signal handler. Original repo is never touched.
  //
  // Fallback path (used when the repo isn't git-backed or worktree creation
  // fails): in-place hide via truncate-to-placeholder + restore. Less clean
  // but works on non-git checkouts.
  const worktree = tryCreateWorktree(info.path);
  let runCwd = info.path;
  let stashedFiles: StashedDoc[] = [];

  if (worktree) {
    const deleted = sanitizeWorktree(worktree.path);
    if (process.env.DEBUG) console.log(`🛡  Sandbox: worktree at ${worktree.path}, ${deleted} doc file(s) removed`);
    runCwd = worktree.path;
  } else {
    // Fallback — in-place hide of root AGENTS.md/CLAUDE.md + nested.
    stashedFiles = hideDocs(info.path);
    if (process.env.DEBUG) console.log(`🛡  Sandbox: in-place hide of ${stashedFiles.length} doc file(s)`);
  }

  // Build the fresh-agent context using the SANDBOX path so the agent never
  // sees the original repo path in its prompt. Without this, the agent
  // happily reads absolute paths like /Users/.../multisite/AGENTS.md and
  // bypasses our worktree entirely. --dangerously-skip-permissions lets it
  // read anywhere; the prompt is its only signpost to where the code is.
  const sandboxInfo = { ...info, path: runCwd };
  const freshContext = freshAgentContext(sandboxInfo);

  const prompt = TEST_AGENT_PROMPT
    .replace("{questions}", questionsText)
    .replace("{context}", freshContext);

  const restoreOnce = (() => {
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      if (worktree) {
        removeWorktree(worktree);
      } else {
        restoreDocs(stashedFiles);
      }
    };
  })();
  const sigHandler = () => { restoreOnce(); process.exit(130); };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  let lastError: unknown;
  const maxRetries = 2;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const runner = new AgentRunner({
        cwd: runCwd, // worktree path when sandboxed, else info.path (fallback in-place hide)
        model,
        thinkingLevel: "off",
        noContextFiles: true, // CRITICAL: strip AGENTS.md / CLAUDE.md
        maxTurns: 50,
        baseUrl,
        backend,
      });

      const result = await runner.run(prompt);
      if (result.error && !result.text) {
        lastError = new Error(`Fresh agent failed: ${result.error}`);
        if (attempt < maxRetries) {
          if (process.env.DEBUG) console.warn(`⚠️  Fresh agent attempt ${attempt + 1} failed (${result.error}), retrying...`);
          continue;
        }
        throw lastError;
      }

      const parsed = tryParseJsonArray(result.text);
      if (!parsed) {
        lastError = new Error("Fresh agent returned non-JSON");
        if (attempt < maxRetries) {
          if (process.env.DEBUG) console.warn(`⚠️  Fresh agent attempt ${attempt + 1} returned non-JSON, retrying...`);
          continue;
        }
        throw lastError;
      }

    const results: QuestionResult[] = [];
    const parsedSet = new Map(parsed.map((r: any) => [r.questionId, r]));

    for (const q of questions) {
      const r = parsedSet.get(q.id);
      if (r) {
        // Tighten the "answered" criterion. The model is biased to report
        // answered: true even when it hedges. Treat as failed if:
        //   - confidence is below a real-knowledge threshold, OR
        //   - docsNeeded is populated (the model itself is telling us a
        //     doc is missing — that's literally a gap).
        const confidence = Math.min(1, Math.max(0, r.confidence || 0));
        const docsNeeded = r.docsNeeded || undefined;
        const modelClaimsAnswered = Boolean(r.answered);
        const reallyAnswered = modelClaimsAnswered && confidence >= 0.75 && !docsNeeded;
        results.push({
          questionId: r.questionId,
          answered: reallyAnswered,
          answer: r.answer || undefined,
          confidence,
          evidence: r.evidence || [],
          failureReason: r.failureReason || (reallyAnswered ? undefined : `low confidence (${confidence.toFixed(2)})${docsNeeded ? " + docs-needed" : ""}`),
          docsNeeded: docsNeeded || (reallyAnswered ? undefined : `Clarify: ${q.text}`),
        });
      } else {
        results.push({
          questionId: q.id,
          answered: false,
          confidence: 0,
          evidence: [],
          failureReason: "Test agent did not respond to this question",
          docsNeeded: `Document: ${q.text}`,
        });
      }
    }

    if (process.env.DEBUG) {
      console.log(`🔧 Fresh agent made ${result.toolCalls.length} tool calls`);
      for (const tc of result.toolCalls) {
        const preview = (tc.result || "(no result)").slice(0, 80);
        console.log(`   ${tc.name}(${JSON.stringify(tc.args).slice(0, 60)}) → ${preview}`);
      }
    }

    return results;
    }
    throw lastError;
  } finally {
    process.off("SIGINT", sigHandler);
    process.off("SIGTERM", sigHandler);
    restoreOnce();
  }
}
