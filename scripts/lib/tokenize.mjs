/**
 * Split one raw argument string into argv, and pull a path out of it intact.
 *
 * Slash commands substitute `$ARGUMENTS` textually into a shell command line.
 * Unquoted, bash treats a Windows path's backslashes as escapes, so
 * `C:\Users\Me\Documents` arrives as `C:UsersMeDocuments` and then resolves
 * against the wrong directory. Quoting it as `"$ARGUMENTS"` preserves the
 * backslashes but delivers the whole thing as a single argv entry, so the
 * runtime has to take it apart itself.
 *
 * A delegated review of this file found eight defects in the first version.
 * The three that shaped this rewrite:
 *
 *   - An apostrophe opened a quote that never closed, so
 *     `C:\Users\O'Brien\repo --allow-external` became ONE token with the
 *     apostrophe deleted and the flag swallowed. O'Brien is a legal directory
 *     name and this corrupted the allowlist's own input, silently.
 *   - Splitting on whitespace and rejoining with a single space cannot
 *     reconstruct `C:\My  Projects`, so a path with a double space became a
 *     different, possibly existing, directory.
 *   - A quoted value was only unquoted when it happened to contain a space,
 *     so `"C:\repo"` kept its quote characters while `"C:\a b"` did not.
 *
 * Hence two separate jobs, and `extractPath` is the one that matters for
 * anything security-relevant: it never reassembles a path from pieces.
 */

const QUOTES = new Set(['"', "'"]);

/** One definition of whitespace, shared by everything here. */
const WHITESPACE = /\s/u;

export class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
    this.code = "argument_error";
  }
}

/**
 * Split a raw string into argv.
 *
 * Backslash is deliberately NOT an escape character: on Windows it is a path
 * separator far more often, and treating it as an escape is the original bug
 * this file exists to fix.
 *
 * A quote only quotes when it OPENS a token. `'` inside a word is a literal
 * apostrophe, so O'Brien survives. An opening quote that never closes is an
 * error rather than a silent swallow, because the alternative is a garbage
 * path and a dropped flag with no indication either happened.
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

    // Only at the start of a token, so an apostrophe mid-word stays literal.
    if (QUOTES.has(char) && !started) {
      quote = char;
      started = true;
      continue;
    }

    if (WHITESPACE.test(char)) {
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

  if (quote) {
    throw new ArgumentError(
      `Unterminated ${quote === '"' ? "double" : "single"} quote. Close the quote, or drop it: a path does not need quoting unless it contains a space.`
    );
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/** Strip one matched pair of surrounding quotes, whatever the contents. */
function unquote(value) {
  if (value.length >= 2 && QUOTES.has(value[0]) && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Normalise argv from either calling convention.
 *
 * A command passes the whole argument string as one entry; a person running
 * the runtime directly passes ordinary argv. A single entry is split, and a
 * single entry that is merely quoted is unquoted, so `"C:\repo"` and
 * `"C:\a b"` behave the same way instead of differing on whether the value
 * happens to contain a space.
 */
export function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }

  const only = argv[0];
  if (WHITESPACE.test(only)) {
    return tokenize(only);
  }

  return [unquote(only)];
}

/**
 * Pull a path and its flags out of a raw argument string, without ever
 * reassembling the path from split pieces.
 *
 * Recognised flags are removed from the end of the string, and whatever
 * remains is the path exactly as written: internal double spaces, tabs and
 * apostrophes all survive, because nothing was taken apart. This is the
 * difference between registering `C:\My  Projects\repo` and registering some
 * other directory that happens to exist.
 *
 * Flags are only honoured at the end. A trailing `--force` on a directory
 * genuinely named `app --force` is ambiguous no matter what, and resolving it
 * toward "flag" is the reading a person almost always means.
 */
export function extractPath(raw, knownFlags = []) {
  const flags = new Set(knownFlags.map((flag) => (flag.startsWith("--") ? flag : `--${flag}`)));
  const found = new Set();

  let rest = typeof raw === "string" ? raw : "";

  for (;;) {
    const trimmed = rest.replace(/\s+$/u, "");
    const match = trimmed.match(/(^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*)$/u);

    if (!match || !flags.has(match[2])) {
      rest = trimmed;
      break;
    }

    found.add(match[2].slice(2));
    rest = trimmed.slice(0, trimmed.length - match[2].length);
  }

  // A quoted path is unquoted; an unquoted one is taken verbatim.
  const path = unquote(rest.replace(/^\s+/u, ""));

  return { path: path === "" ? undefined : path, flags: found };
}
