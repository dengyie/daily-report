// Host-aware default paths for the Obsidian vault and the user-authored poster
// assets.
//
// Single source of truth for two consumers:
//   1. config.mjs's DEFAULT_* values, so a fresh clone on Windows no longer
//      resolves to a hardcoded macOS iCloud absolute path (the old default was
//      `$HOME/Library/Mobile Documents/iCloud~md~obsidian/...` verbatim, which on
//      Windows silently became a nonexistent `C:\Users\<u>\Library\...` tree and
//      wrote the daily note outside the vault).
//   2. validateRuntimePaths, whose "path does not exist" message now points the
//      operator at the host-correct location to create.
//
// `.env` (OBSIDIAN_DIR / IMAGE_PROMPT_FILE / IMAGE_REF_IMAGE / …) always wins
// over anything here — this is only the fallback for an unconfigured clone.
//
// Every path is derived from the home directory, never hardcoded to one host.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The vault's own root folder (`obsidian-note`), by platform convention:
//   darwin — the iCloud Drive / Mobile Documents nest Obsidian's iOS sync uses.
//   win32  — the same folder inside the Windows iCloud Drive mirror.
//   other  — a plain `~/obsidian-note`; a local vault must be named via .env.
function vaultRootFor(platform, home) {
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Mobile Documents",
      "iCloud~md~obsidian",
      "Documents",
      "obsidian-note",
    );
  }
  if (platform === "win32") {
    return path.join(home, "iCloudDrive", "iCloud~md~obsidian", "Documents", "obsidian-note");
  }
  return path.join(home, "obsidian-note");
}

// A `.env`-less clone must still resolve to a vault that EXISTS on the host, not
// to a convention that only holds on some machines (the old default was a macOS
// iCloud absolute path, silently dead on Windows). Probe the known layouts in
// order and return the first that exists; fall back to the platform convention
// when none match (e.g. the vault lives on another drive and is named via .env).
// `exists` is injectable so unit tests stay deterministic and offline.
function existingVaultRoot(platform, home, exists, candidateRoots) {
  for (const root of candidateRoots) {
    if (exists(root)) return root;
  }
  return vaultRootFor(platform, home);
}

// Pure: given a platform + home, produce the full set of default paths. Exposed
// for unit tests so the darwin/win32/linux branches are all exercised on any host
// (a test that only reads process.platform can only ever cover one of them).
export function hostPaths({ platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  const vaultRoot = existingVaultRoot(platform, home, exists, vaultCandidates(platform, home));
  const noteDir = path.join(vaultRoot, "Note");
  const promptDir = path.join(noteDir, "AI", "AI 提示词", "图片生成提示词");
  return {
    grokSearchDir: path.join(home, ".claude", "skills", "grok-search"),
    // The vault ROOT, not the DallyReport sub-folder. Wikilinks written into the
    // vault are resolved by the vault's own resolver, which is vault-root
    // relative (the vault's CLAUDE.md: "所有路径使用相对路径，从 vault 根目录开始").
    // A generator that only knows obsidianDir cannot emit a resolvable link, so
    // the root travels alongside it.
    vaultRoot,
    obsidianDir: path.join(noteDir, "AI", "DallyReport"),
    imagePromptFile: path.join(promptDir, "GitHub 日报海报提示词.md"),
    aiImagePromptFile: path.join(promptDir, "AI 日报海报提示词.md"),
    imageRefImage: path.join(vaultRoot, "OneNode", "assersts", "Pasted image 20260804185819.png"),
  };
}

// Known vault layouts to probe, most specific first. win32 tries the iCloud Drive
// mirror first (the convention), then the plain home dir; darwin the iCloud nest;
// other just the plain home dir.
function vaultCandidates(platform, home) {
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents", "obsidian-note"),
      path.join(home, "obsidian-note"),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(home, "iCloudDrive", "iCloud~md~obsidian", "Documents", "obsidian-note"),
      path.join(home, "obsidian-note"),
    ];
  }
  return [path.join(home, "obsidian-note")];
}

// Resolved once for the current host; config.mjs reads these as its defaults.
export const HOST_DEFAULTS = hostPaths();

// Derive the vault root from an arbitrary output directory.
//
// OBSIDIAN_DIR may be overridden in .env (the production value points at
// `<vault>/Note/AI/DallyReport`), so the root cannot simply be the host
// default — it must follow the EFFECTIVE output directory.
//
// Two markers, in order:
//   1. `.obsidian/` — Obsidian's own vault marker. Unambiguous, so it wins.
//   2. the `Note/` segment — the vault's convention (CLAUDE.md: paths are
//      vault-root relative, and the content tree lives under `Note/`).
//
// If neither is found the host default is returned: a wrong-but-stable root
// degrades to the previous (unresolvable) link form, while a wrong root would
// emit links that point at a DIFFERENT real file — strictly worse.
export function vaultRootForDir(obsidianDir, { exists = fs.existsSync } = {}) {
  if (!obsidianDir) return HOST_DEFAULTS.vaultRoot;
  let dir = path.resolve(obsidianDir);
  const parts = path.resolve(obsidianDir).split(path.sep);
  // Index of the `Note` segment, searched from the deepest end so a nested
  // folder that happens to be called "Note" cannot win over the real one.
  let noteIdx = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] === "Note") {
      noteIdx = i;
      break;
    }
  }
  const noteFallback = noteIdx > 0 ? parts.slice(0, noteIdx).join(path.sep) || path.sep : null;

  for (;;) {
    try {
      if (exists(path.join(dir, ".obsidian"))) return dir;
    } catch {
      /* unreadable dir: keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return noteFallback || HOST_DEFAULTS.vaultRoot;
}