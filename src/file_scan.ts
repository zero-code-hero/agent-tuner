import { readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";
import { SKIP_DIRS, DOC_PATTERNS, LANG_MAP } from "./constants.js";

// ─── Cache ───

export interface FileScanResult {
  fileTypes: Record<string, number>;
  numFiles: number;
  numDirs: number;
  allFiles: string[];
}

const scanCache = new Map<string, FileScanResult>();

export function clearScanCache(): void {
  scanCache.clear();
}

// ─── Core scanning ───

export function scanFiles(path: string): FileScanResult {
  const cached = scanCache.get(path);
  if (cached) return cached;

  const fileTypes: Record<string, number> = {};
  let numFiles = 0;
  let numDirs = 0;
  const allFiles: string[] = [];

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          numDirs++;
          walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          numFiles++;
          const full = join(dir, entry.name);
          const rel = full.replace(path + "/", "");
          allFiles.push(rel);
          const ext = extname(entry.name).toLowerCase() || "(no ext)";
          fileTypes[ext] = (fileTypes[ext] || 0) + 1;
        }
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read directory ${dir}: ${e.message}`);
    }
  }

  walk(path);

  const sorted = Object.entries(fileTypes)
    .sort((a, b) => b[1] - a[1])
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>);

  const result = { fileTypes: sorted, numFiles, numDirs, allFiles };
  scanCache.set(path, result);
  return result;
}

export function detectLanguage(fileTypes: Record<string, number>): string[] {
  const langs: Record<string, number> = {};
  for (const [ext, count] of Object.entries(fileTypes)) {
    const lang = LANG_MAP[ext];
    if (lang && !["markdown", "json", "yaml", "toml", "xml", "html", "css", "scss", "less", "shell"].includes(lang)) {
      langs[lang] = (langs[lang] || 0) + count;
    }
  }
  return Object.entries(langs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);
}

// ─── Docs ───

export function findDocs(path: string): string[] {
  const docs: string[] = [];
  const docsDir = join(path, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    try {
      for (const entry of readdirSync(docsDir)) {
        if (entry.endsWith(".md")) docs.push("docs/" + entry);
      }
    } catch (e: any) {
      if (process.env.DEBUG) console.warn(`⚠️  Could not read docs directory: ${e.message}`);
    }
  }
  for (const name of DOC_PATTERNS) {
    if (existsSync(join(path, name))) docs.push(name);
  }
  return docs;
}

export function summarizeStructure(path: string): string {
  const lines: string[] = [];
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        let count = 0;
        function countFiles(dir: string) {
          try {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                countFiles(join(dir, e.name));
              } else { count++; }
            }
          } catch (e: any) {
            if (process.env.DEBUG) console.warn(`⚠️  Could not count files in ${dir}: ${e.message}`);
          }
        }
        countFiles(join(path, entry.name));
        lines.push(`  ${entry.name}/ (${count} files)`);
      } else {
        lines.push(`  ${entry.name}`);
      }
    }
  } catch (e: any) {
    if (process.env.DEBUG) console.warn(`⚠️  Could not summarize structure: ${e.message}`);
  }
  return lines.join("\n");
}
