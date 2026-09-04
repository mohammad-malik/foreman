/**
 * Minimal argv parser. No dependencies, no magic.
 *
 * Long options only (`--name`, `--name=value`, `--name value`). Anything not
 * consumed as an option value lands in `positionals`. `--` stops parsing and
 * dumps the rest into positionals verbatim, which matters because task text
 * routinely contains things that look like flags.
 */

export function parseArgs(argv, { valueOptions = [], boolOptions = [] } = {}) {
  const values = new Set(valueOptions);
  const bools = new Set(boolOptions);
  const options = Object.create(null);
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");

    if (eq !== -1) {
      const name = body.slice(0, eq);
      assertKnown(name, values, bools);
      options[name] = body.slice(eq + 1);
      continue;
    }

    assertKnown(body, values, bools);

    if (bools.has(body)) {
      options[body] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next === "--") {
      throw new Error(`Option --${body} needs a value.`);
    }
    options[body] = next;
    i += 1;
  }

  return { options, positionals };
}

function assertKnown(name, values, bools) {
  if (!values.has(name) && !bools.has(name)) {
    throw new Error(`Unknown option --${name}.`);
  }
}
