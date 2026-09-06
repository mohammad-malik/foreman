/**
 * HTTP client for a running OpenCode server.
 *
 * Every endpoint translation lives here. The rest of the plugin talks in terms
 * of sessions, prompts and permissions, so when OpenCode moves an endpoint the
 * damage is contained to this file rather than spreading into command output
 * and job records.
 *
 * Verified against the /doc OpenAPI description served by OpenCode 1.18.16.
 * Prompts always travel in a JSON body, never in a command string, so nothing
 * a model produces can be reinterpreted by a shell.
 */

import { authHeader } from "./servers.mjs";
import { oneLine } from "./render.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(message, { status, body, code = "api_error" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export class OpencodeApi {
  /**
   * `timeout` sets this instance's default for every request. The Stop hook
   * passes a short one so a wedged server cannot stall the conversation.
   */
  constructor(server, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this.server = server;
    this.defaultTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async request(method, endpoint, { body, timeout = this.defaultTimeout, query } = {}) {
    const url = new URL(`${this.server.url}${endpoint}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: authHeader(this.server.password),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new ApiError(`${method} ${endpoint} timed out after ${timeout}ms.`, {
          code: "api_timeout"
        });
      }
      throw new ApiError(`${method} ${endpoint} failed: ${error.message}`, {
        code: "api_unreachable"
      });
    }

    const text = await response.text();
    let parsed = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new ApiError(
          "OpenCode rejected our credentials. The server was probably replaced; stop it and let the next command start a fresh one.",
          { status: 401, body: parsed, code: "api_unauthorized" }
        );
      }
      throw new ApiError(`${method} ${endpoint} returned ${response.status}.`, {
        status: response.status,
        body: parsed,
        code: "api_status"
      });
    }

    // Most endpoints wrap their payload in { data: ... }.
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  }

  /** Available agent definitions, including the ones this plugin injects. */
  agents() {
    return this.request("GET", "/api/agent");
  }

  /**
   * Create a session bound to one directory, agent and model.
   *
   * `directory` is what confines the agent's file access, so it is always the
   * canonical workspace root, never a caller-supplied string that skipped the
   * containment check.
   */
  createSession({ agent, providerID, modelID, directory }) {
    return this.request("POST", "/api/session", {
      body: {
        agent,
        model: { providerID, id: modelID },
        location: { directory }
      }
    });
  }

  getSession(sessionID) {
    return this.request("GET", `/api/session/${sessionID}`);
  }

  /**
   * Sessions this server knows about in a directory. Child sessions carry a
   * parentID, which is how nested agent activity is discovered rather than
   * taken on trust from the worker's own summary.
   */
  listSessions({ directory, limit = 100 } = {}) {
    return this.request("GET", "/api/session", { query: { directory, limit } });
  }

  /** Queue a prompt. Returns as soon as the server admits it, not when done. */
  prompt(sessionID, text) {
    return this.request("POST", `/api/session/${sessionID}/prompt`, {
      body: { prompt: { text } }
    });
  }

  /**
   * Whether the session has finished its current turn. One transcript fetch;
   * see `turnStateFrom` for the rules, and pass an already-fetched transcript
   * to that directly when you have one, so a poll does not download it twice.
   */
  async turnState(sessionID) {
    return turnStateFrom(await this.messages(sessionID));
  }

  messages(sessionID) {
    return this.request("GET", `/api/session/${sessionID}/message`);
  }

  /** Stop the session's current work. Edits already written stay written. */
  interrupt(sessionID) {
    return this.request("POST", `/api/session/${sessionID}/interrupt`, { body: {} });
  }

  pendingPermissions(sessionID) {
    return this.request("GET", `/api/session/${sessionID}/permission`);
  }

  /**
   * Answer one permission request.
   *
   * "always" is deliberately not offered. It writes a saved rule that outlives
   * the job and would quietly widen what future delegations may do, which is
   * not a decision any single prompt should be able to make.
   */
  replyPermission(sessionID, requestID, decision, message) {
    if (decision !== "once" && decision !== "reject") {
      throw new ApiError(`Refusing to send permission reply "${decision}".`, {
        code: "permission_reply_invalid"
      });
    }
    return this.request("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, {
      body: { reply: decision, ...(message ? { message } : {}) }
    });
  }
}

/**
 * Whether the session's current turn is over, and how it ended.
 *
 * There is a `/wait` endpoint, and in 1.18.16 it answers 503 with "Session
 * wait is not available yet", so polling is not a shortcut here: it is the
 * only thing that works.
 *
 * The signal is the newest assistant message's `finish` reason. Nothing else
 * is reliable. Completion timestamps are not: every message in a multi-step
 * turn carries one as soon as that step ends. Presence of text is not either,
 * and that mistake had teeth: a model that narrates before calling tools ("I'll
 * start by reading the relevant files") produces a completed message with text
 * on its very first step, so a real job was reported finished after eight
 * seconds with a preamble as its answer while the agent carried on working.
 *
 * `finish` is "tool-calls" while the model intends to continue and "stop" when
 * the turn is genuinely over. Anything else completed is also over, but it is
 * NOT a success: a turn that ended on "error", "length" or an abort did not do
 * the work, and a provider 429 from Moonshot or Fireworks is exactly how that
 * arrives. It used to read as completed with whatever text had been produced
 * so far. Now `error` carries the reason and the caller fails the job with it.
 */
export function turnStateFrom(messages) {
  const list = messageList(messages);
  const assistants = list.filter(isAssistant);

  if (assistants.length === 0) {
    return { state: "working", assistants: 0, finish: null, error: null };
  }

  // messageList puts these in conversation order, so the newest is last.
  const newest = assistants[assistants.length - 1];
  const completed = Boolean(newest?.time?.completed);
  const finish = newest?.finish ?? null;
  const reportedError = describeMessageError(newest?.error);

  // A message the server has marked as errored is over whatever its finish
  // reason says; the runner does not always get to write one.
  if (reportedError) {
    return { state: "idle", assistants: assistants.length, finish, error: reportedError };
  }

  const stillGoing = !completed || finish === null || finish === "tool-calls";
  if (stillGoing) {
    return { state: "working", assistants: assistants.length, finish, error: null };
  }

  return {
    state: "idle",
    assistants: assistants.length,
    finish,
    error: finish === "stop" ? null : `The model's turn ended with finish reason "${finish}" rather than completing.`
  };
}

/**
 * OpenCode records a failed step as `error: { name, data: { message } }` on
 * the assistant message. Shapes vary by provider, so anything string-like in
 * there is accepted and flattened to one line.
 */
function describeMessageError(error) {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return oneLine(error, 500);
  }
  const message = error?.data?.message ?? error?.message ?? error?.name ?? null;
  if (message) {
    return oneLine(`${error.name && error.name !== message ? `${error.name}: ` : ""}${message}`, 500);
  }
  return oneLine(JSON.stringify(error), 500);
}

/**
 * Normalise the message list.
 *
 * OpenCode returns messages newest first. Reversing here means every reader
 * below can think in conversation order, which is the source of a whole class
 * of off-by-one mistakes when it is left implicit.
 */
export function messageList(messages) {
  const raw = Array.isArray(messages) ? messages : (messages?.messages ?? messages?.data ?? []);
  return [...raw].reverse();
}

function contentParts(message) {
  // `content` is the 1.18 shape. `parts` is accepted too, so a future rename
  // degrades to an empty list rather than a crash.
  return message?.content ?? message?.parts ?? [];
}

function isAssistant(message) {
  return message?.type === "assistant" || message?.role === "assistant";
}

function isUser(message) {
  return message?.type === "user" || message?.role === "user";
}

/**
 * The external agent's final answer.
 *
 * Only `text` parts count. Reasoning and tool parts are deliberately excluded:
 * a model's private thinking is not its answer, and returning it would be both
 * noisy and misleading.
 *
 * Only the current turn is consulted: the assistant messages after the most
 * recent user message. Walking further back returned text from an earlier turn
 * as though it answered this one. Within the turn the newest text wins, so a
 * final step that says nothing (a model that ended on a tool call) yields the
 * last thing it did say rather than nothing at all. Returns null when the turn
 * produced no text, which is reported as such rather than papered over.
 */
export function finalAssistantText(messages) {
  const list = messageList(messages);

  let start = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isUser(list[i])) {
      start = i + 1;
      break;
    }
  }

  for (let i = list.length - 1; i >= start; i -= 1) {
    if (!isAssistant(list[i])) {
      continue;
    }

    const text = contentParts(list[i])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text !== "") {
      return text;
    }
  }

  return null;
}

/**
 * Every tool invocation in the session, in order, with its outcome.
 *
 * The input is summarised, not stored. An edit's input is the whole new file
 * body, and keeping every one of them in the job record made records grow by
 * megabytes and `status` slow to a crawl parsing them. Two hundred characters
 * is enough to see which file a call touched.
 */
export function toolCalls(messages) {
  const calls = [];

  for (const message of messageList(messages)) {
    for (const part of contentParts(message)) {
      if (part?.type !== "tool") {
        continue;
      }
      calls.push({
        tool: part.name ?? part.tool ?? "unknown",
        status: part.state?.status ?? "unknown",
        detail: summariseInput(part.state?.input)
      });
    }
  }

  return calls;
}

function summariseInput(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return oneLine(text, 200);
}

/**
 * Cost and token totals summed across messages.
 *
 * The session object reports zeroes in this version, so the per-message
 * figures are the only real numbers available.
 */
export function usageTotals(messages) {
  const totals = { cost: 0, input: 0, output: 0, reasoning: 0 };

  for (const message of messageList(messages)) {
    if (!isAssistant(message)) {
      continue;
    }
    totals.cost += Number(message.cost ?? 0);
    totals.input += Number(message.tokens?.input ?? 0);
    totals.output += Number(message.tokens?.output ?? 0);
    totals.reasoning += Number(message.tokens?.reasoning ?? 0);
  }

  return totals;
}
