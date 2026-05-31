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

