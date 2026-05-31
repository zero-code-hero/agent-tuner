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

// Hard cap on context string size to prevent blowing past model limits.
// Individual sections are already capped; this is a safety net for the total.
const MAX_CONTEXT_CHARS = 12_000;

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

// Full context — everything the generator/scoring agents need
export function infoToContext(info: RepoInfo, depthAnalysis: DepthAnalysis, state: TunerState): string {
  // Use depth for cache key so same iteration at different depths don't collide
  const key = cacheKey(info.path, state.currentDepth);
  const cached = contextCache.get(key);
  if (cached) return cached;

  const lines: string[] = [
    `Repository: ${info.path}`,
    `Language: ${info.topLanguages.join(", ") || "unknown"}`,
    `Files: ${info.numFiles}, Dirs: ${info.numDirs}`,
    `Iteration: ${state.currentIteration + 1}, Depth: ${state.currentDepth}`,
    "",
  ];

  if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`);
  if (info.testFramework) lines.push(`Test framework: ${info.testFramework}`);
  if (info.linter) lines.push(`Linter: ${info.linter}`);
  if (info.formatter) lines.push(`Formatter: ${info.formatter}`);
  if (info.ciSystem) lines.push(`CI: ${info.ciSystem}`);

  if (Object.keys(depthAnalysis.scripts).length > 0) {
    lines.push("\nAvailable scripts:");
    for (const [name, cmd] of Object.entries(depthAnalysis.scripts)) lines.push(`  ${name}: ${cmd}`);
  }

  if (info.configFiles.length > 0) lines.push(`\nConfig files: ${info.configFiles.slice(0, 15).join(", ")}`);
  if (info.namingPatterns) lines.push(`\nNaming: ${info.namingPatterns}`);
  if (info.projectStructure) lines.push(`\nStructure:\n${info.projectStructure}`);

  // Token budget per section — prevents context overflow on large repos
  const MAX_SECTION_ITEMS = 8; // keep analysis sections tight
  const MAX_SECTION_CHARS = 500; // hard char cap per section

  if (depthAnalysis.importPatterns.length > 0) {
    lines.push("\nImport patterns (sample):");
    for (const imp of depthAnalysis.importPatterns.slice(0, MAX_SECTION_ITEMS)) lines.push(`  ${imp}`);
  }
  if (depthAnalysis.errorPatterns.length > 0) {
    lines.push("\nError handling (sample):");
    const errText = depthAnalysis.errorPatterns.slice(0, MAX_SECTION_ITEMS).join("\n");
    lines.push(errText.length > MAX_SECTION_CHARS ? errText.slice(0, MAX_SECTION_CHARS) + "…" : errText);
  }
  if (depthAnalysis.codeStyle.length > 0) {
    lines.push("\nCode style:");
    const csText = depthAnalysis.codeStyle.slice(0, MAX_SECTION_ITEMS).join("\n");
    lines.push(csText.length > MAX_SECTION_CHARS ? csText.slice(0, MAX_SECTION_CHARS) + "…" : csText);
  }
  if (depthAnalysis.architecture.length > 0) {
    lines.push("\nArchitecture:");
    const archText = depthAnalysis.architecture.slice(0, MAX_SECTION_ITEMS).join("\n");
    lines.push(archText.length > MAX_SECTION_CHARS ? archText.slice(0, MAX_SECTION_CHARS) + "…" : archText);
  }
  if (depthAnalysis.envVars.length > 0) {
    lines.push("\nEnvironment:");
    const envText = depthAnalysis.envVars.slice(0, MAX_SECTION_ITEMS).join("\n");
    lines.push(envText.length > MAX_SECTION_CHARS ? envText.slice(0, MAX_SECTION_CHARS) + "…" : envText);
  }
  if (depthAnalysis.antiPatterns.length > 0) {
    lines.push("\nAnti-patterns / gotchas:");
    const apText = depthAnalysis.antiPatterns.slice(0, MAX_SECTION_ITEMS).join("\n");
    lines.push(apText.length > MAX_SECTION_CHARS ? apText.slice(0, MAX_SECTION_CHARS) + "…" : apText);
  }
  if (depthAnalysis.branching.length > 0) {
    lines.push("\nBranching:");
    for (const br of depthAnalysis.branching.slice(0, MAX_SECTION_ITEMS)) lines.push(`  ${br}`);
  }
  if (depthAnalysis.dependencies.length > 0) {
    lines.push("\nDependencies:");
    for (const dep of depthAnalysis.dependencies.slice(0, MAX_SECTION_ITEMS)) lines.push(`  ${dep}`);
  }
  if (depthAnalysis.readmeContent) lines.push(`\nREADME (excerpt):\n${depthAnalysis.readmeContent}`);
  if (info.existingAgentsMd) lines.push(`\nExisting agent doc:\n${info.existingAgentsMd.slice(0, 2000)}`);
  if (info.existingDocs.length > 0) lines.push(`\nDocumentation: ${info.existingDocs.slice(0, 10).join(", ")}`);

  // Previous iteration failures drive next questions
  if (state.allResults.length > 0) {
    const failures = state.allResults.filter((r) => !r.answered);
    if (failures.length > 0) {
      lines.push("\nPrevious iteration gaps (fresh agent couldn't answer these):");
      for (const f of failures.slice(-5)) {
        lines.push(`  ✗ ${f.failureReason || "unknown failure"}`);
        if (f.docsNeeded) lines.push(`    → Needs doc: ${f.docsNeeded.slice(0, 120)}`);
      }
    }
  }

  let result = lines.join("\n");

  // Safety cap: truncate if total context exceeds budget
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + "\n\n[truncated — context exceeded " + MAX_CONTEXT_CHARS + " char limit]";
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
