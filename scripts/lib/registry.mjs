/**
 * The workspace allowlist.
 *
 * Nothing is delegated anywhere the user has not registered by hand, and
 * nothing leaves the machine unless that registration also carries the egress
 * flag. Two separate gates on purpose: registering a repo so you can read job
 * state is a much smaller decision than agreeing that its source code may be
 * sent to OpenCode Zen, Moonshot and Fireworks.
 */

import { loadConfig, saveConfig } from "./state.mjs";
import {
  canonicalize,
  containmentKey,
  findGitRoot,
  isInside,
  mainRepositoryRoot,
  workspaceSlug
} from "./workspace.mjs";

export function listWorkspaces() {
  const config = loadConfig();
  return Object.values(config.workspaces).sort((a, b) => a.root.localeCompare(b.root));
}

export function registerWorkspace(rawPath, { allowExternal = false } = {}) {
  const root = canonicalize(rawPath);
  const key = containmentKey(root);
  const config = loadConfig();
  const existing = config.workspaces[key];

  config.workspaces[key] = {
    root,
    slug: workspaceSlug(root),
    allowExternal: Boolean(allowExternal),
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveConfig(config);
  return config.workspaces[key];
}

export function unregisterWorkspace(rawPath) {
  const key = containmentKey(canonicalize(rawPath));
  const config = loadConfig();
  const existing = config.workspaces[key];

  if (!existing) {
    return null;
  }

  delete config.workspaces[key];
  saveConfig(config);
  return existing;
}

/**
 * Find the registered workspace containing `rawPath`, or null.
 *
 * When registrations nest, the deepest match wins, so registering a monorepo
 * root and one package inside it behaves the way you would expect.
 */
export function findWorkspaceFor(rawPath) {
  const target = canonicalize(rawPath);
  let best = null;

  for (const entry of listWorkspaces()) {
    if (!isInside(target, entry.root)) {
      continue;
    }
    if (!best || entry.root.length > best.root.length) {
      best = entry;
    }
  }

  return best;
}

/**
 * The entry for exactly this root, or null. Never a containing one.
 *
 * Containment is the right rule for "which workspace owns this file" and the
 * wrong one for "which checkout am I working in". A linked worktree lives
 * inside its main checkout on disk, so a containment lookup answered every
 * question about a worktree with the main repository: jobs dispatched at a
 * worktree ran in the main tree, against files that were only ever on the
 * worktree's branch.
 */
export function findWorkspaceExactly(rawPath) {
  const key = containmentKey(canonicalize(rawPath));
  return listWorkspaces().find((entry) => containmentKey(entry.root) === key) ?? null;
}

/**
 * The same fix written as a runtime call.
 *
 * A refusal is usually read by an agent, not a person, and an agent cannot run
 * a slash command: those carry `disable-model-invocation`, which is the whole
 * point of routing dispatch through them. Naming only the slash command left
 * agents retrying something that can never work. Both forms appear, so
 * whichever is reading knows what it can actually run.
 */
function runtimeForm(tail) {
  return ["", "Or, as a command:", `  node "\${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" ${tail}`];
}

/**
 * Resolve a path to the workspace that may act on it.
 *
 * There is no registration step any more. Pointing foreman at a repository is
 * the act of choosing it, and making that a separate command bought nothing:
 * it refused worktrees of repositories that were already approved, and the
 * answer to every refusal was to type the command it had just printed.
 *
 * One decision survives, because it is the only one with a consequence that
 * leaves the machine: whether this repository's source may be sent to OpenCode
 * Zen, Moonshot and Fireworks. That is asked once per repository and then
 * remembered, and a worktree inherits its main checkout's answer.
 */
export function requireWorkspaceFor(rawPath, { requireExternal = false } = {}) {
  const target = canonicalize(rawPath);

  // The workspace stays the checkout that was actually named, worktree and
  // all. Everything downstream depends on that: the server's directory, the
  // git baseline, revert, and the refusal to run two writers in one tree. Only
  // the approval is shared, so a `--write` job dispatched at a worktree edits
  // that worktree rather than the branch its main checkout happens to be on.
  //
  // The lookup is exact, not by containment. A linked worktree sits inside its
  // main checkout on disk, so a containment lookup found the main repository's
  // entry and every job dispatched from any worktree ran in the main tree.
  const root = findGitRoot(target) ?? target;
  const workspace = findWorkspaceExactly(root) ?? registerWorkspace(root, { allowExternal: false });

  if (!requireExternal) {
    return { workspace, target };
  }

  // Approval belongs to the main checkout and is read fresh, never copied onto
  // the worktree. Caching it there meant `deny` on the repository left every
  // worktree that had already run still approved, so revoking egress did not
  // revoke it. A worktree's own flag is deliberately not consulted.
  const owner = approvalOwner(root);

  if (owner?.allowExternal) {
    return { workspace, target };
  }

  const askAbout = owner?.root ?? mainRepositoryRoot(target) ?? root;

  throw new Error(
    [
      `Sending ${askAbout} to an external model has not been approved yet.`,
      "Delegating sends your handoff and whatever the agent reads to OpenCode Zen, Moonshot and Fireworks.",
      "Approve this repository once, and its worktrees are covered too:",
      `  /foreman:allow ${askAbout}`,
      ...runtimeForm(`allow "${askAbout}"`)
    ].join("\n")
  );
}

/**
 * The entry that holds the egress decision for a checkout: its main
 * repository, or itself when it is one.
 */
export function approvalOwner(root) {
  const main = mainRepositoryRoot(root) ?? root;
  return findWorkspaceExactly(main);
}
