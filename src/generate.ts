import type { RepoInfo, DepthAnalysis, Rule } from "./types.js";

export function generateRulesFromGaps(
  info: RepoInfo,
  depthAnalysis: DepthAnalysis,
  gaps: Array<{ question: string; docsNeeded: string }>,
): Rule[] {
  const rules: Rule[] = [];

  for (const gap of gaps) {
    // Extract category from the docsNeeded text
    const category = inferCategory(gap.docsNeeded, info);
    const content = formatRule(gap.docsNeeded, category);

    if (content) {
      rules.push({
        category,
        content,
        confidence: 0.7, // Start high — these are from actual failures
      });
    }
  }

  return rules;
}

function inferCategory(text: string, info: RepoInfo): string {
  const lower = text.toLowerCase();
  if (lower.includes("install") || lower.includes("setup") || lower.includes("dependency")) return "setup";
  if (lower.includes("test")) return "testing";
  if (lower.includes("lint") || lower.includes("format") || lower.includes("style")) return "conventions";
  if (lower.includes("import") || lower.includes("naming") || lower.includes("convention")) return "conventions";
  if (lower.includes("architect") || lower.includes("structure") || lower.includes("module")) return "architecture";
  if (lower.includes("error") || lower.includes("catch") || lower.includes("handle")) return "error_handling";
  if (lower.includes("env") || lower.includes("config") || lower.includes("variable")) return "configuration";
  if (lower.includes("git") || lower.includes("commit") || lower.includes("branch")) return "git";
  if (lower.includes("docker") || lower.includes("deploy")) return "deployment";
  if (lower.includes("gotcha") || lower.includes("pitfall") || lower.includes("watch out")) return "gotchas";
  return "general";
}

function formatRule(text: string, category: string): string {
  // Clean up the text into a proper rule format
  let content = text.trim();

  // Remove common prefixes
  content = content.replace(/^(AGENTS\.md should say:|Document:|Rule:|Note:)\s*/i, "");

  // Format as a section
  const displayNames: Record<string, string> = {
    setup: "Setup",
    testing: "Testing",
    conventions: "Conventions",
    architecture: "Architecture",
    error_handling: "Error Handling",
    configuration: "Configuration",
    git: "Git",
    deployment: "Deployment",
    gotchas: "Gotchas",
    general: "General",
  };

  return `## ${displayNames[category] || category}\n- ${content}\n`;
}

// Legacy: keep for non-loop mode
export function generateRules(info: RepoInfo): Rule[] {
  const rules: Rule[] = [];

  if (info.existingDocs.length > 0) {
    rules.push({
      category: "docs",
      content: `## Documentation\n- Read these first: ${info.existingDocs.slice(0, 5).join(", ")}\n`,
      confidence: 0.7,
    });
  }

  if (info.existingAgentsMd) {
    rules.push({
      category: "existing_agent",
      content: "## Existing Agent Instructions\n- An agent doc already exists. Respect its conventions.\n",
      confidence: 0.9,
    });
  }

  if (info.packageManager) {
    const cmd = getInstallCmd(info.packageManager);
    rules.push({
      category: "setup",
      content: `## Setup\n- Uses ${info.packageManager}. Install deps with \`${cmd}\`.\n`,
      confidence: 0.8,
    });
  }

  if (info.testFramework) {
    const cmd = getTestCmd(info.testFramework);
    rules.push({
      category: "testing",
      content: `## Testing\n- Tests use ${info.testFramework}. Run \`${cmd}\` to execute.\n`,
      confidence: 0.8,
    });
  }

  if (info.linter) {
    const lintCmd = getLintCmd(info.linter);
    const fmtCmd = info.formatter ? getFormatCmdOrEmpty(info.formatter) : "";
    rules.push({
      category: "conventions",
      content: `## Code Style\n- Use ${info.linter} for linting. Run \`${lintCmd}\` before committing.${fmtCmd ? ` Format with \`${fmtCmd}\`.` : ""}\n`,
      confidence: 0.8,
    });
  }

  if (info.ciSystem) {
    rules.push({
      category: "ci",
      content: `## CI/CD\n- Uses ${info.ciSystem}. Check the CI config for pipeline details.\n`,
      confidence: 0.7,
    });
  }

  if (info.hasGit && info.commitPatterns.length > 0) {
    rules.push({
      category: "git",
      content: `## Git\n- Commit message patterns: ${info.commitPatterns.slice(0, 5).join(", ")}\n`,
      confidence: 0.6,
    });
  }

  if (info.namingPatterns && !info.namingPatterns.includes("No strong")) {
    rules.push({
      category: "conventions",
      content: `## Naming\n- ${info.namingPatterns}\n`,
      confidence: 0.5,
    });
  }

  return rules;
}

function getInstallCmd(pm: string): string {
  const map: Record<string, string> = {
    "npm/yarn": "npm install", npm: "npm install", yarn: "yarn install",
    pnpm: "pnpm install", cargo: "cargo build", "go modules": "go mod download",
    pip: "pip install -r requirements.txt", "pip/setuptools": "pip install -e .",
    poetry: "poetry install", pipenv: "pipenv install", bundler: "bundle install",
    uv: "uv sync",
  };
  return map[pm] || "install-deps";
}

function getTestCmd(tf: string): string {
  const map: Record<string, string> = {
    vitest: "npx vitest", jest: "npx jest", pytest: "pytest", mocha: "npx mocha",
  };
  return map[tf] || "run-tests";
}

function getLintCmd(linter: string): string {
  const map: Record<string, string> = {
    "eslint (flat)": "npx eslint .", eslint: "npx eslint .",
    ruff: "ruff check .", flake8: "flake8 .", "golangci-lint": "golangci-lint run",
    rubocop: "rubocop",
  };
  return map[linter] || "check-lint";
}

function getFormatCmd(formatter: string): string | null {
  const map: Record<string, string> = {
    prettier: "npx prettier --write .", biome: "npx biome format --write .",
    ruff: "ruff format .",
  };
  return map[formatter] || null;
}

function getFormatCmdOrEmpty(formatter: string): string {
  return getFormatCmd(formatter) || "";
}