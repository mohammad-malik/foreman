import assert from "node:assert/strict";
import test from "node:test";

import {
  finalAssistantText,
  messageList,
  toolCalls,
  usageTotals
} from "../scripts/lib/opencode-api.mjs";

/**
 * Shapes copied from real OpenCode 1.18.16 responses. The details that broke
 * the first implementation: messages arrive newest first, the field is
 * `content` not `parts`, and the discriminator is `type` not `role`.
 */
const NEWEST_FIRST = [
  {
    id: "msg_c",
    type: "assistant",
    time: { created: 3, completed: 4 },
    content: [{ type: "text", id: "text-0", text: "hello" }],
    cost: 0.002,
    tokens: { input: 1949, output: 14, reasoning: 0 }
  },
  {
    id: "msg_b",
    type: "assistant",
    time: { created: 2, completed: 2 },
    content: [
      { type: "reasoning", id: "r-0", text: "I should read the file first." },
      { type: "tool", id: "read_0", name: "read", state: { status: "completed", input: { path: "README.md" } } }
    ],
    cost: 0.001,
    tokens: { input: 400, output: 20, reasoning: 5 }
  },
  { id: "msg_a", type: "user", time: { created: 1 }, text: "Read README.md" }
];

test("messageList puts messages in conversation order", () => {
  assert.deepEqual(
    messageList(NEWEST_FIRST).map((m) => m.id),
    ["msg_a", "msg_b", "msg_c"]
  );
});

test("the final answer is the newest assistant text", () => {
  assert.equal(finalAssistantText(NEWEST_FIRST), "hello");
});

test("reasoning and tool parts are excluded from the final answer", () => {
  // A model's private thinking is not its answer. Returning it would be both
  // noisy and misleading about what the agent actually reported.
  const text = finalAssistantText(NEWEST_FIRST);
  assert.doesNotMatch(text, /should read the file/);
  assert.doesNotMatch(text, /README/);
});

test("a session with no assistant reply yields null, not a guess", () => {
  assert.equal(finalAssistantText([NEWEST_FIRST[2]]), null);
  assert.equal(finalAssistantText([]), null);
});

test("an assistant message with only tool parts is skipped for older text", () => {
  const onlyTools = [NEWEST_FIRST[1], NEWEST_FIRST[2]];
  assert.equal(finalAssistantText(onlyTools), null);
});

test("tool calls are extracted with name and status", () => {
  const calls = toolCalls(NEWEST_FIRST);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "read");
  assert.equal(calls[0].status, "completed");
  assert.deepEqual(calls[0].input, { path: "README.md" });
});

test("usage totals sum across assistant messages only", () => {
  const totals = usageTotals(NEWEST_FIRST);
  assert.equal(totals.input, 2349);
  assert.equal(totals.output, 34);
  assert.equal(totals.reasoning, 5);
  assert.ok(Math.abs(totals.cost - 0.003) < 1e-9);
});

test("the wrapped {data: [...]} envelope is unwrapped", () => {
  assert.equal(finalAssistantText({ data: NEWEST_FIRST }), "hello");
});

test("a future rename to `parts` degrades rather than throwing", () => {
  const future = [{ type: "assistant", parts: [{ type: "text", text: "still works" }] }];
  assert.equal(finalAssistantText(future), "still works");
});
