/**
 * Commands a handoff tells the agent to run.
 *
 * The researcher agent's bash is denied outright, not asked: it has confined
 * read, glob, grep, list and lsp tools, and denying the shell means it can
 * never block waiting for a human who is asleep. That is the right trade, and
 * it is not going to change.
 *
 * What went wrong is upstream of it. A handoff was written asking the agent to
 * "run these commands and include their raw output", the agent could not, and
 * the job came back with a correct report plus an apology for the one section
 * it had been told was the proof. The verification the caller actually wanted
 * never happened, and nothing failed loudly enough to say so at dispatch time.
 *
 * So the check runs before the job starts, and only for an agent that cannot
 * run anything. The bar is an imperative: "run npm test" is an instruction,
 * while "the build is driven by npm test" is prose about a command and stays
 * out of the way.
 */

/** Verbs that turn a mention of a command into an instruction to run it. */
const IMPERATIVES = "run|execute|invoke|issue";

/**
 * A line telling the agent to run something, or one inside a block introduced
 * as commands to run.
 *
 * Two forms, because handoffs use both: the sentence ("run `npm test`") and
 * the labelled block ("Commands that prove the work:" followed by indented
 * lines). Both are quoted back verbatim so the caller can see exactly which
 * sentence to rewrite.
 */
export function commandInstructions(task) {
  const text = String(task ?? "");
  const lines = text.split(/\r?\n/u);
  const found = [];
  const seen = new Set();

  const add = (line) => {
    const trimmed = line.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    found.push(trimmed);
  };

  // "Commands that prove the work:", "Commands to run:", "Verify by running:".
  //
  // Three things together, not any one of them: the word command, a colon, and
  // a word about running or proving. "Document the supported commands:
  // describe their arguments" has the first two and is a writing task, so the
  // third is what keeps it out.
  const blockHeading = new RegExp(
    `(^|[^A-Za-z])(commands?|verify)\\b[^\\n]*\\b(${IMPERATIVES}|running|prove|proof|proves)\\b[^\\n]*:|(^|[^A-Za-z])commands?\\s+to\\s+(${IMPERATIVES})\\b[^\\n]*:`,
    "iu"
  );
  let inBlock = false;
  let inFence = false;

  for (const line of lines) {
    // A fenced block is source material, not instruction. A handoff that
    // quotes a README saying "Run npm test" and then asks whether the README
    // is accurate is a perfectly good read-only job, and reading the excerpt
    // as the instruction refused it.
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      inBlock = false;
      continue;
    }
    if (inFence) {
      continue;
    }

    // A blockquote is quoted source material for the same reason a fence is.
    // Its marker used to be stripped as though it were a list bullet, which
    // turned a quoted "> Run npm test" into this handoff's own instruction.
    if (/^\s*>/u.test(line)) {
      continue;
    }

    // Exemptions apply per clause, not per line. "Do not run npm test. Run git
    // status instead." is one line carrying a prohibition and a request, and
    // letting the first suppress the second turned any handoff that mentioned
    // something forbidden into a free pass.
    const clauses = splitClauses(line);
    const asked = clauses.filter((clause) => !exempt(clause));

    if (asked.length === 0) {
      inBlock = false;
      continue;
    }

    // Quoted spans are stripped first. A handoff asking about a README's own
    // "Commands to run:" heading is a reading task, and treating the quotation
    // as this handoff's heading refused it.
    const heading = asked.find((clause) => blockHeading.test(withoutQuotedSpans(clause)));
    if (heading) {
      inBlock = true;
      add(line);
      continue;
    }

    if (inBlock) {
      // The block ends at the first line that is neither blank nor indented
      // or fenced: prose resumes at the left margin.
      if (line.trim() === "") {
        continue;
      }
      if (/^\s+\S/u.test(line) || /^\s*[`-]/u.test(line)) {
        add(line);
        continue;
      }
      inBlock = false;
    }

    for (const clause of asked) {
      if (isInstruction(clause)) {
        // The whole line is quoted back, because a clause on its own reads as
        // a fragment and the caller has to find it in the handoff to fix it.
        add(line);
        break;
      }
    }
  }

  return found;
}

/**
 * Whether the imperative on this line is being forbidden rather than asked for.
 *
 * A good read-only handoff says "do not run the test suite" out loud, so
 * reading that as a request to run it would refuse exactly the handoffs that
 * got this right.
 */
function negated(line) {
  // Inflections count here and nowhere else: "without executing anything" is a
  // prohibition, while "executing" on its own instructs nobody. They are spelt
  // out by stem because "executing" does not begin with "execute".
  const inflected = "run(?:s|ning)?|execut(?:e|es|ed|ing)|invok(?:e|es|ed|ing)|issu(?:e|es|ed|ing)";

  return new RegExp(
    `\\b(?:do\\s+not|don't|never|without|no\\s+need\\s+to|cannot|can't|must\\s+not|avoid)\\b[^.;:]{0,40}\\b(?:${inflected})\\b`,
    "iu"
  ).test(line);
}

/**
 * One line split into clauses, with any list marker dropped.
 *
 * A full stop or semicolon ends a clause. The marker goes because "- Run npm
 * test." is the commonest shape a handoff uses, and matching against the raw
 * line missed every one of them.
 */
function splitClauses(line) {
  const text = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/u, "");
  const clauses = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    // A quoted excerpt is one unit however many sentences it contains.
    // Splitting through it separated `"Run npm ci. Then run npm test."` into
    // two clauses, each of which had lost the quotation that made it someone
    // else's instruction.
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    current += char;

    if ((char === "." || char === ";") && /\s/u.test(text[i + 1] ?? " ")) {
      clauses.push(current);
      current = "";
    }
  }

  clauses.push(current);

  return clauses.map((clause) => clause.trim()).filter((clause) => clause !== "");
}

/** A clause that asks for nothing runnable, whatever verbs it contains. */
function exempt(clause) {
  if (negated(clause) || callerOwned(clause) || descriptive(clause)) {
    return true;
  }

  // A reporting request excuses only itself. "List the changed files and run
  // git status" opens as a reporting task and ends as an execution request,
  // and exempting the whole clause on its first half let the second half
  // through to an agent with no shell.
  return suggestionOnly(clause) && !isInstruction(afterConjunction(clause));
}

/** Whatever follows the first "and" or "then", or an empty string. */
function afterConjunction(clause) {
  const match = clause.match(/[,;]?\s+(?:and|then)\s+/iu);
  return match ? clause.slice(match.index + match[0].length) : "";
}

/**
 * Whether the clause describes what some other thing does.
 *
 * "The CI will install dependencies and run npm test" is a fact about a build
 * system. The subject is what settles it, and without this the "and" that
 * opens the second half read as a fresh instruction to the agent.
 */
function descriptive(clause) {
  return /^\s*(?:the|a|an|this|that|it|they|its|our|their)\b[^.;:]{0,60}?\b(?:will|shall|does|do|runs|executes|invokes|issues)\b/iu.test(
    clause
  );
}

/**
 * Whether the clause asks for commands to be written down rather than run.
 *
 * "Suggest commands to run" and "document the commands that verify this" are
 * report content. The agent produces the text; nothing executes.
 */
function suggestionOnly(clause) {
  return /^\s*(?:please\s+)?(suggest|list|document|describe|recommend|propose|name|identify|explain)\b/iu.test(
    clause
  );
}

/**
 * Whether the line assigns the commands to someone other than the agent.
 *
 * The delegating guidance tells the orchestrator to run verification itself
 * after a read-only job lands, and a good handoff says so. Reading
 * "commands the caller runs after your report" as an instruction to the agent
 * would refuse the handoffs that followed the advice.
 */
function callerOwned(line) {
  // "by the caller" assigns the work; "for the reviewer" only names who reads
  // the result, and treating that as an exemption let an explicit "run npm
  // test for the reviewer" through to an agent with no shell.
  // "you" is deliberately absent: in a handoff the second person is the agent,
  // so "you should run npm test" is the request this check exists to catch.
  return /\b(by|from)\s+(the\s+)?(caller|orchestrator|reviewer)\b|\b(caller|orchestrator|i|we)\s+(will|shall|can|should)\s+\w*\s*(run|execute)\b|\brun\s+(by|myself|locally\s+by)\b/iu.test(
    line
  );
}

/**
 * Blank out every quoted span.
 *
 * Used for the heading check only, where quoted content never carries the
 * handoff's own instruction: a heading this handoff writes is written plainly.
 */
function withoutQuotedSpans(clause) {
  return clause.replace(/(["`])[^"`]*\1/gu, " ");
}

/**
 * Blank out quoted spans that contain an imperative.
 *
 * `Review the README: "First run npm test"` quotes an instruction addressed to
 * somebody else and asks for a reading of it. A span holding only a command,
 * as in "then run `npm test`", is left alone: there the instruction is the
 * handoff's own and the quotes are just formatting.
 */
function withoutQuotedInstructions(clause) {
  // The imperative has to open the quoted span. "npm run build" carries `run`
  // as a subcommand, and blanking that span removed the very command an
  // explicit "Run `npm run build`" was asking for.
  // The same forms isInstruction recognises, or a quoted "You should run npm
  // test" survives the filter and is then read as this handoff's own request.
  const imperative = new RegExp(
    [
      "^\\s*(?:(?:first|then|also|next|finally|please)\\s+)?",
      "(?:you\\s+(?:(?:should|must|can|will|need\\s+to|are\\s+to|have\\s+to)\\s+){1,3})?",
      `(?:${IMPERATIVES})\\b`
    ].join(""),
    "iu"
  );

  return clause.replace(/(["`])([^"`]*)\1/gu, (span, _quote, inner) =>
    imperative.test(inner) ? " " : span
  );
}

/** Programs a handoff plausibly asks to be run. */
const COMMANDS =
  "npm|npx|pnpm|yarn|node|git|python3?|pytest|cargo|go|make|dotnet|mvn|gradle|bash|sh|pwsh|powershell|tsc|eslint|jest|vitest|rg|grep|ls|cat";

/**
 * Whether the clause tells the agent to run a named command.
 *
 * Two conditions in one pattern, because checking them separately produced
 * false positives both ways round. The imperative has to open a clause, so
 * `npm run build` is not read as an instruction to run something. And the
 * command has to come straight after that imperative, so "run through the git
 * authentication flow" is not read as a git command: what follows "run" there
 * is "through".
 *
 * Quote characters are deliberately not clause openers. A handoff quoting
 * documentation, `Review the README: "Run npm test"`, is asking for a reading
 * of that text, not for the command in it.
 */
function isInstruction(clause) {
  const opener = [
    "^",
    "|[.;:,)\\]}]\\s*",
    "|\\b(?:then|and|also|next|finally|please|first|afterwards?)\\s+",
    // "You should run npm test" is addressed to the agent, and the second
    // person is who a handoff is written for. The subject has to be there:
    // "the CI job will run npm test" describes what something else does, and
    // reading that as an instruction refused handoffs about a build system.
    // Repeated because modals chain: "you will need to run npm test".
    "|\\byou\\s+(?:(?:should|must|can|will|need\\s+to|are\\s+to|have\\s+to)\\s+){1,3}"
  ].join("");

  // Only a determiner may sit between the verb and the command. Anything
  // longer is prose that happens to contain both words.
  const filler = "(?:the|a|these|those|following)\\s+";

  return new RegExp(
    `(?:${opener})(?:${IMPERATIVES})\\s+[\`'"(]?(?:${filler})?[\`'"(]?(?:${COMMANDS})\\b`,
    "iu"
  ).test(withoutQuotedInstructions(clause));
}
