#!/usr/bin/env node
/**
 * Stop hook: tell the user when a background delegation lands.
 *
 * This is the answer to the hard part of an asynchronous design. Without it,
 * a backgrounded job finishes into silence and the only way to find out is to
 * remember to ask. Polling in a loop is worse: it burns turns and blocks the
 * conversation on work the user did not ask to wait for.
 *
 * Two rules keep this from becoming an annoyance:
 *
 * It never blocks. The hook only ever prints; it does not return a decision
 * that forces another turn. Being dragged back into a finished job you have
 * moved on from is worse than reading about it a moment later.
 *
 * It never throws. A hook that fails on every turn would make the whole
 * session unpleasant for the sake of a status line, so any failure here exits
 * quietly. The information is available from `/external-agents:status` anyway.
 */

import process from "node:process";

import { notify } from "./lib/cmd/notify.mjs";

async function main() {
  let message = "";

  try {
    message = await notify();
  } catch {
    // Deliberately silent. See above.
    return;
  }

  if (!message) {
    return;
  }

  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

await main();
