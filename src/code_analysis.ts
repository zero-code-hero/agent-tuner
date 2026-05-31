import { readFileSync } from "fs";
import { join } from "path";
import { SKIP_DIRS } from "./constants.js";

const EXT_MAP: Record<string, string[]> = {
  typescript: [".ts", ".tsx"], javascript: [".js", ".jsx"],
  python: [".py"], rust: [".rs"], go: [".go"], ruby: [".rb"],
  elixir: [".ex", ".exs"],
};

function sampleFiles(path: string, languages: string[], allFiles: string[], maxFiles: number): string[] {
  const matched: string[] = [];
  for (const lang of languages.slice(0, 2)) {
    const exts = EXT_MAP[lang] || [];
    let count = 0;
    for (const file of allFiles) {
      if (count >= maxFiles) break;
      if (!exts.some((e) => file.endsWith(e))) continue;
      if (file.split("/").some((p) => SKIP_DIRS.has(p))) continue;
      matched.push(file);
      count++;
    }
  }
  return matched;
}

// ─── Depth 2+ ───

export function sampleImports(path: string, languages: string[], allFiles: string[], maxFiles: number): string[] {
  const imports: string[] = [];
  const files = sampleFiles(path, languages, allFiles, maxFiles);

  for (const file of files) {
    try {
      const content = readFileSync(join(path, file), "utf-8");
      const lines = content.split("\n").slice(0, 80);
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("import ") || t.startsWith("from ") || t.startsWith("require(") ||
            (languages.includes("rust") && t.startsWith("use ")) ||
            (languages.includes("go") && t.startsWith("import ")) ||
            (languages.includes("ruby") && t.startsWith("require "))) {
          imports.push(t);
        }
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read ${file}: ${e.message}`);
    }
  }
  return [...new Set(imports)].slice(0, 20);
}

export function sampleErrorPatterns(path: string, languages: string[], allFiles: string[], maxFiles: number): string[] {
  const patterns: string[] = [];
  const errKeywords = [
    "try {", "catch", "throw ", "raise ", "except ",
    "Error", "panic", "unwrap()", "Result", "err != nil",
    "rescue", "begin", "ensure", ".catch(", "finally",
  ];
  const files = sampleFiles(path, languages, allFiles, maxFiles);

  for (const file of files) {
    try {
      const content = readFileSync(join(path, file), "utf-8");
      for (const line of content.split("\n")) {
        for (const kw of errKeywords) {
          if (line.includes(kw)) patterns.push(`${file}:${line.trim()}`);
        }
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read ${file}: ${e.message}`);
    }
  }
  return patterns.slice(0, 15);
}

// ─── Depth 3+ ───

export function analyzeCodeStyle(path: string, languages: string[], allFiles: string[]): string[] {
  const findings: string[] = [];
  const files = sampleFiles(path, languages, allFiles, 10);

  for (const file of files) {
    try {
      const content = readFileSync(join(path, file), "utf-8");
      const lines = content.split("\n");
      const funcStyles: Record<string, number> = { arrow: 0, traditional: 0, class: 0 };
      const indentStyles: Record<string, number> = { space2: 0, space4: 0, tab: 0 };

      for (const line of lines.slice(0, 50)) {
        if (line.trim().length === 0) continue;
        const leading = line.match(/^(\s*)/)?.[1] || "";
        if (leading.length > 0) {
          if (leading.includes("\t")) indentStyles.tab++;
          else if (leading.length % 4 === 0) indentStyles.space4++;
          else indentStyles.space2++;
        }
      }

      for (const lang of languages.slice(0, 2)) {
        if (lang === "typescript" || lang === "javascript") {
          if (content.includes("=>") && content.includes("const ")) funcStyles.arrow++;
          if (/\bfunction\s+\w+/.test(content)) funcStyles.traditional++;
          if (/\bclass\s+\w+/.test(content)) funcStyles.class++;
        }
        if (lang === "python") {
          if (content.includes("lambda ")) funcStyles.arrow++;
          if (/\bdef\s+\w+/.test(content)) funcStyles.traditional++;
          if (/\bclass\s+\w+/.test(content)) funcStyles.class++;
        }

        const maxFunc = Object.entries(funcStyles).sort((a, b) => b[1] - a[1])[0];
        if (maxFunc[1] > 0) findings.push(`${lang} prefers ${maxFunc[0]} function style`);
        const maxIndent = Object.entries(indentStyles).sort((a, b) => b[1] - a[1])[0];
        if (maxIndent[1] > 0) {
          const indentLabel = maxIndent[0] === "space2" ? "2-space" : maxIndent[0] === "space4" ? "4-space" : "tab";
          findings.push(`${lang} uses ${indentLabel} indentation`);
        }
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read ${file} for style analysis: ${e.message}`);
    }
  }
  return findings;
}

// ─── Depth 4+ ───

export function detectAntiPatterns(path: string, languages: string[], allFiles: string[]): string[] {
  const findings: string[] = [];
  const files = sampleFiles(path, languages, allFiles, 15);

  for (const file of files) {
    try {
      const content = readFileSync(join(path, file), "utf-8");
      const lines = content.split("\n");
      if (languages.includes("typescript") && content.includes(": any")) findings.push(`${file} uses \`any\` type`);
      for (const marker of ["TODO", "FIXME", "HACK", "XXX"]) {
        if (content.includes(marker)) findings.push(`${file} has ${marker} markers`);
      }
      if (lines.length > 500) findings.push(`${file} is ${lines.length} lines`);
      if ((languages.includes("typescript") || languages.includes("javascript")) && content.includes("console.log")) {
        if (!file.includes("test") && !file.includes("spec") && !file.includes("dev")) {
          findings.push(`${file} has console.log`);
        }
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read ${file} for anti-pattern detection: ${e.message}`);
    }
  }
  return findings.slice(0, 15);
}
