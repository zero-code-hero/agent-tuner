import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type { RepoInfo, DepthAnalysis } from "./types.js";
import type { TunerState } from "./state.js";
import { scanFiles, detectLanguage, findDocs, summarizeStructure, clearScanCache } from "./file_scan.js";
import { detectTooling, readAgentDoc, extractScripts } from "./tool_detection.js";
import { sampleImports, sampleErrorPatterns, analyzeCodeStyle, detectAntiPatterns } from "./code_analysis.js";
import { getCommitPatterns, analyzeArchitecture, detectEnvVars, detectBranchingStrategy, analyzeDependencies, inferNaming } from "./architecture.js";

const contextCache = new Map<string, string>();

function cacheKey(path: string, depth: number): string {
  return `${path}:${depth}`;
}

// Total context budget — modern models handle large inputs easily.
// We build sections in priority order and drop low-priority ones when tight
// instead of truncating mid-section.
const MAX_CONTEXT_CHARS = 64_000;

// Sections are assigned a priority tier (1 = never drop, 4 = first to go).
// When budget is exceeded, tiers are dropped from highest number downward.
type SectionBuilder = () => string | undefined;

interface Section {
  priority: 1 | 2 | 3 | 4;
  label: string;
  build: SectionBuilder;
}

function sectionText(items: string[], maxItems: number, maxChars: number): string | undefined {
  const trimmed = items.slice(0, maxItems).join("\n");
  if (!trimmed) return undefined;
  if (trimmed.length > maxChars) {
    return trimmed.slice(0, maxChars) + "\n  … (truncated)";
  }
  return trimmed;
}

function listSection(items: string[], maxItems: number): string | undefined {
  if (items.length === 0) return undefined;
  return items.slice(0, maxItems).map((i) => `  ${i}`).join("\n");
}

function checkGit(path: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: path, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───

export function discoverAtDepth(path: string, depth: number, state: TunerState): {
  info: RepoInfo;
  depthAnalysis: DepthAnalysis;
} {
  const { fileTypes, numFiles, numDirs, allFiles } = scanFiles(path);
  const topLanguages = detectLanguage(fileTypes);
  const tooling = detectTooling(path);
  const hasGit = checkGit(path);

  const info: RepoInfo = {
    path,
    language: topLanguages[0] || "unknown",
    packageManager: tooling.packageManager,
    testFramework: tooling.testFramework,
    linter: tooling.linter,
    formatter: tooling.formatter,
    ciSystem: tooling.ciSystem,
    hasGit,
    topLanguages,
    fileTypes,
    numFiles,
    numDirs,
    keyFiles: tooling.configFiles.filter((f) => !f.startsWith(".github")),
    existingAgentsMd: readAgentDoc(path),
    existingDocs: findDocs(path),
    commitPatterns: hasGit ? getCommitPatterns(path) : [],
    importPatterns: [],
    errorPatterns: [],
    namingPatterns: inferNaming(path),
    projectStructure: summarizeStructure(path),
    configFiles: tooling.configFiles,
  };

  const depthAnalysis: DepthAnalysis = {
    importPatterns: [],
    errorPatterns: [],
    codeStyle: [],
    architecture: [],
    antiPatterns: [],
    envVars: [],
    branching: [],
    dependencies: [],
    scripts: {},
    readmeContent: "",
  };

  // Depth >= 2
  if (depth >= 2) {
    const maxFiles = Math.min(15 + (depth - 2) * 10, 50);
    depthAnalysis.importPatterns = sampleImports(path, topLanguages, allFiles, maxFiles);
    depthAnalysis.errorPatterns = sampleErrorPatterns(path, topLanguages, allFiles, Math.min(maxFiles, 30));
    depthAnalysis.scripts = extractScripts(path);
  }

  // Depth >= 3
  if (depth >= 3) {
    depthAnalysis.codeStyle = analyzeCodeStyle(path, topLanguages, allFiles);
    depthAnalysis.architecture = analyzeArchitecture(path, topLanguages, allFiles);
    depthAnalysis.envVars = detectEnvVars(path);
    const readmePath = join(path, "README.md");
    if (existsSync(readmePath)) {
      try { depthAnalysis.readmeContent = readFileSync(readmePath, "utf-8").slice(0, 3000); } catch (e: any) {
        if (process.env.DEBUG) console.warn(`⚠️  Could not read README.md: ${e.message}`);
      }
    }
  }

  // Depth >= 4
  if (depth >= 4) {
    depthAnalysis.antiPatterns = detectAntiPatterns(path, topLanguages, allFiles);
    depthAnalysis.branching = detectBranchingStrategy(path);
    depthAnalysis.dependencies = analyzeDependencies(path, topLanguages);
  }

  info.importPatterns = depthAnalysis.importPatterns;
  info.errorPatterns = depthAnalysis.errorPatterns;

  return { info, depthAnalysis };
}

// Full context — everything the generator/scoring agents need.
// Sections are built in priority order; low-priority ones are dropped when
// the total exceeds the budget rather than slicing content in half.
export function infoToContext(info: RepoInfo, depthAnalysis: DepthAnalysis, state: TunerState): string {
  const key = cacheKey(info.path, state.currentDepth);
  const cached = contextCache.get(key);
  if (cached) return cached;

  const MAX_SECTION_ITEMS = 8;
  const MAX_SECTION_CHARS = 800;

  // Collect all sections with priority tiers
  const sections: Section[] = [];

  // ── Tier 1: always include ──
  sections.push({
    priority: 1,
    label: "header",
    build: () => [
      `Repository: ${info.path}`,
      `Language: ${info.topLanguages.join(", ") || "unknown"}`,
      `Files: ${info.numFiles}, Dirs: ${info.numDirs}`,
      `Iteration: ${state.currentIteration + 1}, Depth: ${state.currentDepth}`,
      "",
    ].join("\n"),
  });

  const toolingParts: string[] = [];
  if (info.packageManager) toolingParts.push(`Package manager: ${info.packageManager}`);
  if (info.testFramework) toolingParts.push(`Test framework: ${info.testFramework}`);
  if (info.linter) toolingParts.push(`Linter: ${info.linter}`);
  if (info.formatter) toolingParts.push(`Formatter: ${info.formatter}`);
  if (info.ciSystem) toolingParts.push(`CI: ${info.ciSystem}`);
  if (toolingParts.length > 0) {
    sections.push({ priority: 1, label: "tooling", build: () => toolingParts.join("\n") });
  }

  if (Object.keys(depthAnalysis.scripts).length > 0) {
    const scriptsText = Object.entries(depthAnalysis.scripts)
      .map(([name, cmd]) => `  ${name}: ${cmd}`)
      .join("\n");
    sections.push({ priority: 1, label: "scripts", build: () => `Available scripts:\n${scriptsText}` });
  }

  // ── Tier 2: structural info ──
  if (info.configFiles.length > 0) {
    sections.push({
      priority: 2,
      label: "config files",
      build: () => `Config files: ${info.configFiles.slice(0, 15).join(", ")}`,
    });
  }

  if (info.namingPatterns && info.namingPatterns !== "No strong naming convention detected") {
    sections.push({ priority: 2, label: "naming", build: () => `Naming: ${info.namingPatterns}` });
  }

  if (info.projectStructure) {
    sections.push({ priority: 2, label: "structure", build: () => `Structure:\n${info.projectStructure}` });
  }

  // ── Tier 3: analysis sections ──
  if (depthAnalysis.importPatterns.length > 0) {
    const text = sectionText(depthAnalysis.importPatterns, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "import patterns", build: () => `Import patterns (sample):\n${text}` });
  }

  if (depthAnalysis.errorPatterns.length > 0) {
    const text = sectionText(depthAnalysis.errorPatterns, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "error handling", build: () => `Error handling (sample):\n${text}` });
  }

  if (depthAnalysis.codeStyle.length > 0) {
    const text = sectionText(depthAnalysis.codeStyle, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "code style", build: () => `Code style:\n${text}` });
  }

  if (depthAnalysis.architecture.length > 0) {
    const text = sectionText(depthAnalysis.architecture, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "architecture", build: () => `Architecture:\n${text}` });
  }

  if (depthAnalysis.envVars.length > 0) {
    const text = sectionText(depthAnalysis.envVars, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "environment", build: () => `Environment:\n${text}` });
  }

  if (depthAnalysis.antiPatterns.length > 0) {
    const text = sectionText(depthAnalysis.antiPatterns, MAX_SECTION_ITEMS, MAX_SECTION_CHARS);
    if (text) sections.push({ priority: 3, label: "anti-patterns", build: () => `Anti-patterns / gotchas:\n${text}` });
  }

  if (depthAnalysis.branching.length > 0) {
    const text = listSection(depthAnalysis.branching, MAX_SECTION_ITEMS);
    if (text) sections.push({ priority: 3, label: "branching", build: () => `Branching:\n${text}` });
  }

  if (depthAnalysis.dependencies.length > 0) {
    const text = listSection(depthAnalysis.dependencies, MAX_SECTION_ITEMS);
    if (text) sections.push({ priority: 3, label: "dependencies", build: () => `Dependencies:\n${text}` });
  }

  // ── Tier 4: supplementary (drop first) ──
  if (depthAnalysis.readmeContent) {
    // Cap README at 15% of total budget to prevent it from swallowing everything
    const readmeMax = Math.floor(MAX_CONTEXT_CHARS * 0.15);
    const content = depthAnalysis.readmeContent.length > readmeMax
      ? depthAnalysis.readmeContent.slice(0, readmeMax) + "\n… (truncated)"
      : depthAnalysis.readmeContent;
    sections.push({ priority: 4, label: "README", build: () => `README (excerpt):\n${content}` });
  }

  if (info.existingAgentsMd) {
    const content = info.existingAgentsMd.slice(0, 2000);
    sections.push({ priority: 4, label: "existing agent doc", build: () => `Existing agent doc:\n${content}` });
  }

  if (info.existingDocs.length > 0) {
    sections.push({
      priority: 4,
      label: "documentation",
      build: () => `Documentation: ${info.existingDocs.slice(0, 10).join(", ")}`,
    });
  }

  // Previous iteration failures — high value for iteration, but drop if tight
  if (state.allResults.length > 0) {
    const failures = state.allResults.filter((r) => !r.answered);
    if (failures.length > 0) {
      const failText = failures.slice(-5).map((f) => {
        const lines = [`  ✗ ${f.failureReason || "unknown failure"}`];
        if (f.docsNeeded) lines.push(`    → Needs doc: ${f.docsNeeded.slice(0, 120)}`);
        return lines.join("\n");
      }).join("\n");
      sections.push({
        priority: 3,
        label: "previous gaps",
        build: () => `Previous iteration gaps (fresh agent couldn't answer these):\n${failText}`,
      });
    }
  }

  // ── Assemble: build all, then drop from lowest priority if over budget ──
  const built = new Map<number, string>();
  for (const sec of sections) {
    const content = sec.build();
    if (content) built.set(built.size, content);
  }

  let result = Array.from(built.values()).join("\n\n");

  // If over budget, iteratively drop the lowest-priority sections
  if (result.length > MAX_CONTEXT_CHARS) {
    const dropped: string[] = [];
    // Sort sections by priority descending (drop tier 4 first, then 3, etc.)
    const sorted = [...sections].sort((a, b) => b.priority - a.priority);

    for (const sec of sorted) {
      if (result.length <= MAX_CONTEXT_CHARS) break;
      const content = sec.build();
      if (content && result.includes(content)) {
        result = result.replace("\n\n" + content + "\n\n", "\n\n");
        result = result.replace(content + "\n\n", "");
        result = result.replace("\n\n" + content, "");
        result = result.replace(content, "");
        dropped.push(sec.label);
      }
    }

    // Clean up any double-blank lines from removal
    result = result.replace(/\n{3,}/g, "\n\n").trim();

    if (dropped.length > 0) {
      result += `\n\n[context trimmed: dropped ${dropped.join(", ")} to stay within budget]`;
    }

    // Last resort: if still over (shouldn't happen with tier 1 being header+tooling), hard cut
    if (result.length > MAX_CONTEXT_CHARS) {
      result = result.slice(0, MAX_CONTEXT_CHARS) + "\n\n[hard-truncated at character limit]";
    }
  }

  contextCache.set(key, result);
  return result;
}

// Surface-only context — what a truly fresh agent would see by browsing the repo
// No deep analysis, no code samples, no architecture insights
export function freshAgentContext(info: RepoInfo): string {
  const lines: string[] = [
    `Repository: ${info.path}`,
    `Language: ${info.topLanguages.join(", ") || "unknown"}`,
    `Files: ${info.numFiles}, Dirs: ${info.numDirs}`,
    "",
  ];

  if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`);
  if (info.testFramework) lines.push(`Test framework: ${info.testFramework}`);
  if (info.linter) lines.push(`Linter: ${info.linter}`);
  if (info.formatter) lines.push(`Formatter: ${info.formatter}`);
  if (info.ciSystem) lines.push(`CI: ${info.ciSystem}`);

  if (info.configFiles.length > 0) lines.push(`\nConfig files: ${info.configFiles.slice(0, 15).join(", ")}`);
  if (info.projectStructure) lines.push(`\nStructure:\n${info.projectStructure}`);

  if (info.existingDocs.length > 0) lines.push(`\nDocumentation: ${info.existingDocs.slice(0, 10).join(", ")}`);

  return lines.join("\n");
}

export function clearCaches(): void {
  clearScanCache();
  contextCache.clear();
}
