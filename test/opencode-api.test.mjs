import assert from "node:assert/strict";
import test from "node:test";

import {
  OpencodeApi,
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

test("an assistant message with only tool parts yields null when nothing else in the turn spoke", () => {
  const onlyTools = [NEWEST_FIRST[1], NEWEST_FIRST[2]];
  assert.equal(finalAssistantText(onlyTools), null);
});

test("the answer comes from the current turn, never from an earlier one", () => {
  // A second user prompt starts a new turn. Text from before it answered the
  // previous question, and reporting it as this turn's answer misled the
  // caller into thinking a run that produced nothing had produced something.
  const twoTurns = [
    { id: "u2", type: "user", time: { created: 5 }, text: "Now do the other thing" },
    ...NEWEST_FIRST
  ];
  assert.equal(finalAssistantText(twoTurns), null);

  const withAnswer = [
    { id: "a3", type: "assistant", time: { created: 6, completed: 7 }, finish: "stop", content: [{ type: "text", text: "second" }] },
    ...twoTurns
  ];
  assert.equal(finalAssistantText(withAnswer), "second");
});

test("within a turn, a silent final step falls back to the last thing the model said", () => {
  const endedOnTool = [
    { id: "a9", type: "assistant", time: { created: 8, completed: 9 }, finish: "stop", content: [{ type: "tool", name: "read", state: { status: "completed" } }] },
    ...NEWEST_FIRST
  ];
  assert.equal(finalAssistantText(endedOnTool), "hello");
});

test("tool calls are extracted with name and status, and inputs are summarised not stored", () => {
  const calls = toolCalls(NEWEST_FIRST);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "read");
  assert.equal(calls[0].status, "completed");
  assert.equal(calls[0].input, undefined);
  assert.match(calls[0].detail, /README\.md/);

  // An edit's input is a whole file body. Storing every one made job records
  // grow by megabytes; the summary is capped.
  const huge = [{ type: "assistant", content: [{ type: "tool", name: "edit", state: { status: "completed", input: { content: "x".repeat(50_000) } } }] }];
  assert.ok(toolCalls(huge)[0].detail.length < 300);
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

/**
 * Turn-completion detection, pinned to the finish reason.
 *
 * These use a fake client because turnState is a method on OpencodeApi and the
 * shapes are what matter. Every one of them is taken from a real session.
 */
function fakeApi(messages) {
  return { messages: async () => messages, turnState: OpencodeApi.prototype.turnState };
}

test('a mid-turn message with narration and tool calls is still working', async () => {
  // The failure this exists to prevent: Kimi opened with 'I'll start by
  // reading the relevant files', which is a completed message WITH text on the
  // first step. The job was reported finished in eight seconds with that
  // preamble as its answer while the agent kept working.
  const messages = [
    {
      type: 'assistant',
      time: { created: 2, completed: 3 },
      finish: 'tool-calls',
      content: [
        { type: 'text', text: "I'll start by reading the relevant files." },
        { type: 'tool', name: 'read', state: { status: 'completed' } }
      ]
    },
    { type: 'user', time: { created: 1 }, text: 'go' }
  ];

  const state = await fakeApi(messages).turnState('ses_x');
  assert.equal(state.state, 'working');
  assert.equal(state.finish, 'tool-calls');
});

test('a finished turn reports idle', async () => {
  const messages = [
    {
      type: 'assistant',
      time: { created: 2, completed: 3 },
      finish: 'stop',
      content: [{ type: 'text', text: 'Here are the findings.' }]
    },
    { type: 'user', time: { created: 1 }, text: 'go' }
  ];

  assert.equal((await fakeApi(messages).turnState('ses_x')).state, 'idle');
});

test('a message still streaming is working', async () => {
  const messages = [
    { type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: 'partial' }] }
  ];

  assert.equal((await fakeApi(messages).turnState('ses_x')).state, 'working');
});

test('a turn that ended on a limit or error counts as over', async () => {
  // It will not produce more on its own, so waiting forever is worse than
  // reporting what there is.
  for (const finish of ['length', 'error', 'aborted']) {
    const messages = [
      { type: 'assistant', time: { created: 2, completed: 3 }, finish, content: [] }
    ];
    assert.equal((await fakeApi(messages).turnState('ses_x')).state, 'idle', finish);
  }
});

test("a session with no assistant reply yet is working", async () => {
  const state = await fakeApi([{ type: "user", time: { created: 1 }, text: "go" }]).turnState(
    "ses_x"
  );

  assert.equal(state.state, "working");
  assert.equal(state.assistants, 0);
});

test("a turn that ended on anything but stop carries an error, so the job fails rather than completes", async () => {
  // A Moonshot 429 or a Fireworks timeout mid-run ends the turn with finish
  // "error". This used to read as idle with no qualification, and the job was
  // reported completed with whatever preamble text had been produced.
  for (const finish of ["length", "error", "aborted"]) {
    const messages = [
      { type: "assistant", time: { created: 2, completed: 3 }, finish, content: [{ type: "text", text: "I'll start by..." }] }
    ];
    const state = await fakeApi(messages).turnState("ses_x");
    assert.equal(state.state, "idle", finish);
    assert.match(state.error, new RegExp(finish), finish);
  }

  const clean = [{ type: "assistant", time: { created: 2, completed: 3 }, finish: "stop", content: [] }];
  assert.equal((await fakeApi(clean).turnState("ses_x")).error, null);
});

test("a message the server marked as errored is over, with the provider's reason", async () => {
  const messages = [
    {
      type: "assistant",
      time: { created: 2 },
      error: { name: "APIError", data: { message: "429 rate limit exceeded\nretry later" } },
      content: []
    }
  ];
  const state = await fakeApi(messages).turnState("ses_x");
  assert.equal(state.state, "idle");
  assert.match(state.error, /429 rate limit/);
  assert.doesNotMatch(state.error, /\n/);
});
