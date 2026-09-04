/**
 * Split one raw argument string into argv.
 *
 * Slash commands substitute `$ARGUMENTS` textually into a shell command line.
 * Unquoted, bash treats a Windows path's backslashes as escapes, so
 * `C:\Users\Me\Documents` arrives as `C:UsersMeDocuments` and then resolves
 * against the wrong directory. Quoting it as `"$ARGUMENTS"` preserves the
 * backslashes but delivers the whole thing as a single argv entry, so the
 * runtime has to split it back apart itself. This does that.
 *
 * Backslash is deliberately NOT an escape character here. On Windows it is a
 * path separator far more often than an escape, and treating it as an escape
 * is the entire bug this exists to fix. Quoting is the way to include a space.
 */
export function tokenize(raw) {
  if (typeof raw !== "string") {
    return [];
  }

  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;

  for (const char of raw) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      // An empty quoted string is still an argument, so remember that a token
      // has begun even if nothing lands in it.
      started = true;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Normalise argv from either calling convention.
 *
 * A command passes the whole argument string as one entry; a person running the
 * runtime directly passes ordinary argv. Splitting only in the single-entry
 * case keeps both working, and means a lone argument that genuinely contains
 * spaces (a path, a task) is still split on the caller's behalf, which is what
 * the shell would have done had it not mangled the backslashes.
 */
export function normalizeArgv(argv) {
  if (argv.length === 1 && /[\s]/.test(argv[0])) {
    return tokenize(argv[0]);
  }
  return argv;
}
