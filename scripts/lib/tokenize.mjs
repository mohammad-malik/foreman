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

/** The option a token names, or undefined: `--route=fast` names `--route`. */
function optionName(token) {
  if (!token.startsWith("--")) {
    return undefined;
  }
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
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
 * Flags are honoured at either end, never in the middle. A trailing `--force`
 * on a directory genuinely named `app --force` is ambiguous no matter what,
 * and resolving it toward "flag" is the reading a person almost always means.
 * A leading flag is not ambiguous at all, because no path begins with `--`.
 *
 * The leading form used to be swallowed into the path, so
 * `register --allow-external C:\repo` complained that
 * `C:\repo\--allow-external C:\repo` does not exist. Flag order is not
 * something to fail a registration over.
 */
export function extractPath(raw, knownFlags = [], argv = null) {
  const flags = new Set(knownFlags.map((flag) => (flag.startsWith("--") ? flag : `--${flag}`)));
  const found = new Set();

  // No raw string means the arguments arrived as real argv, where the shell
  // already established the boundaries correctly. Rescanning a reconstructed
  // string would destroy them, so the parsed form is used as-is: a quoted path
  // containing spaces is one entry and needs no reassembly.
  if (typeof raw !== "string") {
    const tokens = Array.isArray(argv) ? argv : [];
    let path;

    for (const token of tokens) {
      const named = token.startsWith("--") ? token : null;
      if (named && flags.has(named)) {
        found.add(named.slice(2));
      } else if (!named && path === undefined) {
        path = token;
      }
    }

    return { path: path === "" ? undefined : path, flags: found };
  }

  let rest = raw;

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

  // Now the same from the front. A leading flag must be followed by
  // whitespace or be the whole string, so `--forced-migrations\repo` stays a
  // path rather than being read as `--force` plus rubbish.
  for (;;) {
    const trimmed = rest.replace(/^\s+/u, "");
    const match = trimmed.match(/^(--[A-Za-z0-9][A-Za-z0-9-]*)(\s|$)/u);

    if (!match || !flags.has(match[1])) {
      rest = trimmed;
      break;
    }

    found.add(match[1].slice(2));
    rest = trimmed.slice(match[1].length);
  }

  // A quoted path is unquoted; an unquoted one is taken verbatim.
  const path = unquote(rest.replace(/^\s+/u, ""));

  return { path: path === "" ? undefined : path, flags: found };
}

/**
 * Pull one option's value out of a raw argument string, intact, and take the
 * option out of the parsed tokens.
 *
 * parseArgs stops an option value at its first space, which is fine for
 * --model and wrong for --dir: `--dir C:\Program Files\repo` parses as
 * `C:\Program` and strands `Files\repo` in positionals. The value is read
 * from the raw string for the same reason extractPath exists: a path is
 * sliced, never reassembled, so `C:\My  Projects` keeps both spaces and
 * `C:\Users\O'Brien\repo` keeps its apostrophe.
 *
 * The value runs from `--name` (or `--name=`) to the next recognised option,
 * `--`, or the end of the string: delegate's slash command puts `--dir`
 * first, so options after it must still parse as options. An unknown
 * `--whatever` does not end the value; it stays part of it rather than being
 * silently swallowed. The last `--name` wins, matching parseArgs.
 *
 * Returns the value exactly as written, unquoted if it was quoted, or
 * undefined when the option is absent or its value is empty or blank, so the
 * caller can default. `rest` is argv with the option and its value removed.
 */
export function extractOption(argv, raw, name, knownFlags = []) {
  // No raw string means real argv, whose boundaries the shell already got
  // right. Scanning a reconstructed string here dispatched a write job to the
  // wrong repository: a task describing the `--dir` option was one argv entry,
  // joining flattened it, and the option was read out of the prose. So when
  // there is no genuine single-string form, the parsed value is the only
  // reading, and the caller falls back to it.
  if (typeof raw !== "string") {
    return { value: undefined, rest: Array.isArray(argv) ? argv : [] };
  }

  const source = raw;
  const marker = `--${name}`;
  const known = new Set(knownFlags.map((flag) => (flag.startsWith("--") ? flag : `--${flag}`)));

  // Token boundaries and quotes follow tokenize's rules exactly, so the two
  // never disagree about where a token starts: a quote only opens at a token
  // start (an apostrophe mid-word stays literal) and a `--dir` inside a
  // quoted task is prose, not the option.
  let from = -1;
  let to = -1;
  let quote = null;
  let started = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (QUOTES.has(char) && !started) {
      quote = char;
      started = true;
      continue;
    }

    if (WHITESPACE.test(char)) {
      started = false;
      continue;
    }

    if (started) {
      continue;
    }

    // i is a token start. `--` ends option parsing, exactly as in parseArgs:
    // nothing after it is an option, so a value in progress ends here too.
    if (source.startsWith("--", i) && (i + 2 === source.length || WHITESPACE.test(source[i + 2]))) {
      if (from !== -1 && to === -1) {
        to = i;
      }
      break;
    }

    const token = source.slice(i).match(/^--[A-Za-z0-9][A-Za-z0-9-]*/u)?.[0];
    if (token !== undefined && known.has(token)) {
      if (token === marker) {
        from = i + marker.length + (source[i + marker.length] === "=" ? 1 : 0);
        to = -1;
      } else if (from !== -1 && to === -1) {
        to = i;
      }
    }

    started = true;
  }

  if (quote) {
    // Same refusal as tokenize: an error beats a garbage path with no
    // indication anything went wrong.
    throw new ArgumentError(
      `Unterminated ${quote === '"' ? "double" : "single"} quote. Close the quote, or drop it: a path does not need quoting unless it contains a space.`
    );
  }

  if (from === -1) {
    return { value: undefined, rest: argv };
  }

  // Surrounding whitespace came from the command line, not the path;
  // whitespace inside quotes stays, exactly as in extractPath.
  const text = unquote(source.slice(from, to === -1 ? source.length : to).trim());

  // Remove the option and its value from the parsed tokens as well, or
  // parseArgs would still cut the value at its first space and strand the
  // rest in positionals. Value tokens end where the raw value ended: at the
  // next recognised option, `--`, or the end.
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }

    // Both spellings consume the same run of tokens. `--task-file=C:\My
    // Tasks\h.md` used to drop only the first token, leaving `Tasks\h.md` in
    // positionals, where delegate read it as a second, inline task and refused
    // a command line that had named exactly one.
    if (token === marker || optionName(token) === marker) {
      while (i + 1 < argv.length && argv[i + 1] !== "--" && !known.has(optionName(argv[i + 1]))) {
        i += 1;
      }
      continue;
    }

    rest.push(token);
  }

  // An empty or blank value is the same as omitting the option. The check
  // runs after unquote because a quoted blank ("   ") survives it.
  const value = text.trim() === "" ? undefined : text;
  return { value, rest };
}
