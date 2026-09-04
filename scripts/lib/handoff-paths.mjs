/**
 * Checking that the files a handoff names actually exist.
 *
 * A handoff that says "start from src/foo.ts" when there is no src/foo.ts does
 * not fail fast. The agent goes looking, does not find it, improvises, and
 * twenty minutes later reports work against files it chose itself. That has
 * cost real money here, so the paths are checked before the job is dispatched.
 *
 * The check is deliberately conservative in what it treats as a path, because a
 * false positive blocks a legitimate dispatch. Only tokens that look
 * unambiguously like repository files count: a separator, a plausible
 * extension, no spaces, and not a URL.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Paths a handoff appears to name.
 *
 * Deduplicated, in the order they first appear, so a report reads the way the
 * handoff does.
 */
export function namedPaths(task) {
  const text = String(task ?? "");
  const found = new Map();

  // A path-like run: at least one separator, ending in a short alphanumeric
  // extension. Backticks, quotes and surrounding punctuation are not part of
  // the match, so `src/a.ts`, "src/a.ts" and (src/a.ts) all yield src/a.ts.
  //
  // The trailing guard is "not a path character" rather than a list of
  // punctuation: a sentence ending in a filename is the common case, and an
  // allowlist that forgot the full stop silently dropped every path written as
  // "edit src/a.ts." while keeping the ones written as "edit src/a.ts and".
  const pattern = /(?:^|[\s`"'(\[<])([A-Za-z0-9_.@+-]+(?:[/\\][A-Za-z0-9_.@+-]+)+\.[A-Za-z0-9]{1,10})(?=$|[^A-Za-z0-9_/\-])/g;

  for (const match of text.matchAll(pattern)) {
    const candidate = match[1];

    if (isNoise(candidate, text, match.index)) {
      continue;
    }

    const normalised = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!found.has(normalised)) {
      found.set(normalised, candidate);
    }
  }

  return [...found.keys()];
}

/**
 * Things that match the shape of a path but are not one.
 *
 * Each of these came from a real handoff written in this repository, which is
 * why the list is specific rather than a general cleverness.
 */
function isNoise(candidate, text, index) {
  // A URL, or the tail of one. Checked against the text before the match so
  // https://example.com/a.json does not read as a file called example.com/a.json.
  const before = text.slice(Math.max(0, index - 10), index + candidate.length);
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(before)) {
    return true;
  }

  // An absolute Windows or POSIX path is usually a machine-specific mention
  // rather than a repository file, and resolving one against the workspace root
  // would be wrong anyway.
  if (/^[A-Za-z]:[/\\]/.test(candidate) || candidate.startsWith("/")) {
    return true;
  }

  // A package or scope, not a file: @scope/name, node:fs, npm/some-package.
  if (candidate.startsWith("@") || candidate.includes(":")) {
    return true;
  }

  // A version or a decimal: 1.18.16, 5.3.
  if (/^[\d./\\]+$/.test(candidate)) {
    return true;
  }

  return false;
}

/**
 * Which of the paths a handoff names are missing from the workspace.
 *
 * `missing` is what the caller acts on. `checked` is reported alongside it so a
 * clean result is visible as "I looked at six paths and they all exist" rather
 * than as silence, which reads the same as not having looked.
 */
export function checkNamedPaths(root, task) {
  const named = namedPaths(task);
  const missing = [];

  for (const candidate of named) {
    // Contained by construction: the candidates carry no drive letter, no
    // leading separator, and resolve is checked against the root afterwards.
    const resolved = path.resolve(root, candidate);
    if (!resolved.startsWith(path.resolve(root))) {
      continue;
    }
    if (!fs.existsSync(resolved)) {
      missing.push(candidate);
    }
  }

  return { checked: named, missing };
}
