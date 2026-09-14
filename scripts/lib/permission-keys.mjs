/**
 * Which permission keys the running OpenCode knows about, and which of them we
 * forgot to decide.
 *
 * OpenCode defaults an unlisted tool to "ask", and a headless agent has nobody
 * to ask: the job parks in awaiting_permission until a person notices. That is
 * what `todowrite` did, three times in one builder job.
 *
 * Listing the keys in a constant fixes today and guards nothing: the plugin
 * accepts any OpenCode 1.x, so the next release can add a tool and the
 * constant still matches itself while every agent leaves the new key at "ask".
 * The server states the truth in its own OpenAPI document, which `health`
 * already fetches, so that is what this reads.
 */

/**
 * Permission keys named by a server's OpenAPI document, or null when the
 * document is not shaped the way this expects.
 *
 * Null rather than an empty list, deliberately: an empty list would read as
 * "no keys exist" and report every configured key as an invention. A shape
 * this does not recognise means the check cannot run, which is a different
 * thing from the check passing.
 */
export function permissionKeysFromDoc(doc) {
  const schema = doc?.components?.schemas?.PermissionConfig;
  if (!schema) {
    return null;
  }

  // PermissionConfig is an anyOf: a bare action ("allow"), or an object whose
  // properties are the per-tool keys. Only the object branch names tools.
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];

  for (const branch of branches) {
    const keys = Object.keys(branch?.properties ?? {});
    if (keys.length > 0) {
      return keys;
    }
  }

  return null;
}

/**
 * Keys the server knows that an agent has not decided, per agent.
 *
 * Only absence counts. A key set to "ask" on purpose, as bash is on the
 * builder, is a policy, and this has no business second-guessing it.
 */
export function undecidedPermissions(doc, agents) {
  const keys = permissionKeysFromDoc(doc);
  if (!keys) {
    return null;
  }

  const gaps = [];

  for (const [name, agent] of Object.entries(agents ?? {})) {
    const permission = agent?.permission;
    if (!permission || typeof permission !== "object") {
      continue;
    }
    const missing = keys.filter((key) => !(key in permission));
    if (missing.length > 0) {
      gaps.push({ agent: name, missing });
    }
  }

  return gaps;
}

/**
 * Lines ready to print.
 *
 * `null` means the check could not run, and that gets its own line rather than
 * silence. Printing nothing would make an unreachable server, a timeout or a
 * moved schema look exactly like a clean result, which is the failure mode
 * this whole check exists to avoid, one level up.
 */
export function describeUndecided(gaps) {
  if (gaps === null || gaps === undefined) {
    return [
      "could not check this OpenCode's permission list, so an undecided tool would not be reported here. The job may park on one."
    ];
  }

  return gaps.map(({ agent, missing, stale }) =>
    stale
      ? "this server is running an older permission policy than this plugin: it was started before the config changed and keeps it until it restarts. Stop it with `foreman server-stop <repo>` and the next job starts a fresh one."
      : `${agent} does not decide ${missing.join(", ")}; OpenCode treats those as "ask" and a job would park on the first call.`
  );
}
