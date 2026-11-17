// New projects: a new folder with a starter main.py (no geometry yet), opened trusted because the
// app wrote the only script in it. The user describes the model to the agent or writes build123d.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Error keys the renderer translates (i18n `new.err.*`). */
export type NewProjectError = "name" | "parent" | "exists";

/**
 * A project name becomes a folder and file name on every platform: no path separators, no
 * characters Windows refuses, no leading/trailing dots or spaces, at most 64 characters.
 */
export function projectNameValid(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name === name.trim() && !/[<>:"/\\|?*\u0000-\u001f]/.test(name)
    && !/^\.|\.$/.test(name) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name);
}

/** Validates a new project location; returns the folder to create or an error key. */
export function newProjectDir(parent: string, name: string): { dir: string } | { error: NewProjectError } {
  if (!projectNameValid(name)) return { error: "name" };
  if (!parent || !isAbsolute(parent) || (existsSync(parent) && !statSync(parent).isDirectory())) return { error: "parent" };
  const dir = join(parent, name);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) return { error: "exists" };
  return { dir };
}

/** First free "<base>", "<base> 2", … under parent. */
export function freeProjectName(parent: string, base: string): string {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    if (!existsSync(join(parent, name))) return name;
  }
  return base;
}

function starterScript(name: string): string {
  return `"""${name.replace(/"""/g, "")}

Describe what you want to build in the agent panel, or write build123d code here.
Every save rebuilds the model and updates the view.
"""
from build123d import *  # noqa: F401,F403
from slashcad import show

# Each part you show appears in the view, for example:
# show(Box(40, 30, 10), name="block", color="steelblue")
`;
}

/** Creates the folder and main.py; returns the folder. Never overwrites. */
export function createCadProject(parent: string, name: string): { dir: string } | { error: NewProjectError } {
  const r = newProjectDir(parent, name);
  if ("error" in r) return r;
  mkdirSync(r.dir, { recursive: true });
  writeFileSync(join(r.dir, "main.py"), starterScript(name), { flag: "wx" });
  return { dir: r.dir };
}
