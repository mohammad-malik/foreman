#!/usr/bin/env node
/**
 * SessionEnd hook: clean up, but never kill work in flight.
 *
 * The whole point of spawning servers detached is that a delegation survives
 * the conversation that started it. So this deliberately does not stop
 * servers; it runs the ordinary sweep, which leaves anything with active jobs
 * alone and only clears what is already dead or has been idle past its TTL.
 *
 * Silent by design. Nobody wants cleanup chatter as they close a session, and
 * a failure here must never delay session teardown.
 */

import { listWorkspaces } from "./lib/registry.mjs";
import { hasActiveJobs } from "./lib/jobs.mjs";
import { sweep } from "./lib/servers.mjs";

try {
  await sweep(listWorkspaces(), { hasRunningJobs: hasActiveJobs });
} catch {
  // Nothing to say and nowhere useful to say it.
}
