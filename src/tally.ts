// The poll's text formats and its counting rules, without the host: parsing the
// question and options a person types, the messages the plugin posts, and the
// tally of the vote messages that follow a poll message.

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MAX_OPTION_LENGTH = 80;
export const MAX_QUESTION_LENGTH = 200;

const POLL_PREFIX = "📊 Poll: ";
const CLOSED_PREFIX = "📊 Poll closed: ";
const VOTE_PREFIX = "🗳️ vote: ";
const VOTE_FOOTER = "Vote in the Poll panel, or reply /vote <number>";
/** The footer polls were posted with before; they are still read. */
const OLD_VOTE_FOOTER = "Vote with /vote <number>";
/** `🗳` with or without the emoji presentation selector, then `vote:`. */
const VOTE_PATTERN = /^🗳️?\s*vote:/iu;
/** A vote typed by hand: `/vote` and the option's number or text. */
const TYPED_VOTE_PATTERN = /^\/vote\s+/iu;
const OPTION_LINE = /^(\d+)\. (.+)$/;

/** The part of a chat message the tally reads. */
export interface TallyMessage {
  readonly id: string;
  readonly author: { readonly principalId: string; readonly displayName: string };
  readonly text: string;
}

/** A poll's question and options, as posted. */
export interface PollText {
  readonly question: string;
  readonly options: readonly string[];
}

/** One option's count. */
export interface OptionCount {
  readonly number: number;
  readonly text: string;
  readonly votes: number;
}

/** The counted votes of one poll. */
export interface Tally {
  /** The poll message was among the messages counted. */
  readonly found: boolean;
  /** The poll message's author, when it was found. */
  readonly author: TallyMessage["author"] | null;
  /** The poll's author posted its closing message after it. */
  readonly closed: boolean;
  readonly options: readonly OptionCount[];
  /** People whose latest vote names an option. */
  readonly voters: number;
  /** Each voter's principal id and the index of the option of their latest vote. */
  readonly ballots: ReadonlyMap<string, number>;
}

/** Input a person typed that the poll cannot use; the message says what to change. */
export class PollInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollInputError";
  }
}

/** Whitespace runs, line breaks included, as single spaces, and trimmed. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Text compared without case and with whitespace collapsed. */
function key(value: string): string {
  return oneLine(value).toLowerCase();
}

/** The question on one line, 1 to {@link MAX_QUESTION_LENGTH} characters. */
export function parseQuestion(value: unknown): string {
  const question = typeof value === "string" ? oneLine(value) : "";
  if (!question) throw new PollInputError("question must say what the poll asks.");
  if ([...question].length > MAX_QUESTION_LENGTH) {
    throw new PollInputError(`question must be at most ${MAX_QUESTION_LENGTH} characters.`);
  }
  return question;
}

/**
 * The options from one string separated by `|` or `;`: 2 to 8, each trimmed to 1 to 80
 * characters, no two the same regardless of case.
 */
export function parseOptions(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    throw new PollInputError("options must list 2 to 8 options separated by | or ;.");
  }
  const options = value.split(/[|;]/u).map(oneLine);
  options.forEach((option, i) => {
    if (!option) throw new PollInputError(`Option ${i + 1} is empty.`);
    if ([...option].length > MAX_OPTION_LENGTH) {
      throw new PollInputError(`Option ${i + 1} is longer than ${MAX_OPTION_LENGTH} characters.`);
    }
  });
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new PollInputError(
      `A poll has ${MIN_OPTIONS} to ${MAX_OPTIONS} options; this one has ${options.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(key(option))) throw new PollInputError(`"${option}" is listed twice.`);
    seen.add(key(option));
  }
  return options;
}

/** The index of the option `choice` names: its number from 1, or its text in any case. */
export function matchChoice(choice: unknown, options: readonly string[]): number | null {
  if (typeof choice !== "string") return null;
  const wanted = key(choice);
  if (/^\d+$/u.test(wanted)) {
    const n = Number(wanted);
    if (n >= 1 && n <= options.length) return n - 1;
  }
  const index = options.findIndex((option) => key(option) === wanted);
  return index === -1 ? null : index;
}

/** The poll message. */
export function formatPoll(poll: PollText): string {
  return [
    `${POLL_PREFIX}${poll.question}`,
    ...poll.options.map((option, i) => `${i + 1}. ${option}`),
    VOTE_FOOTER,
  ].join("\n");
}

/** A vote message for `option`. */
export function formatVote(option: string): string {
  return `${VOTE_PREFIX}${option}`;
}

/** The message that closes a poll, with its final counts. */
export function formatClosed(question: string, options: readonly OptionCount[]): string {
  return [
    `${CLOSED_PREFIX}${question}`,
    ...options.map((o) => `${o.number}. ${o.text} — ${o.votes}`),
  ].join("\n");
}

/** The question and options of a poll message, or null when `text` is not one. */
export function parsePollMessage(text: string): PollText | null {
  const lines = text.split("\n").map((line) => line.trim());
  const footer = lines.at(-1);
  if (
    !lines[0]?.startsWith(POLL_PREFIX) ||
    (footer !== VOTE_FOOTER && footer !== OLD_VOTE_FOOTER)
  ) {
    return null;
  }
  const question = oneLine(lines[0].slice(POLL_PREFIX.length));
  const optionLines = lines.slice(1, -1);
  if (!question || optionLines.length < MIN_OPTIONS || optionLines.length > MAX_OPTIONS) {
    return null;
  }
  const options: string[] = [];
  for (const [i, line] of optionLines.entries()) {
    const match = OPTION_LINE.exec(line);
    if (!match || Number(match[1]) !== i + 1) return null;
    options.push(oneLine(match[2]));
  }
  return { question, options };
}

/** Whether `text` closes the poll asking `question`. */
export function isClosedMessage(text: string, question: string): boolean {
  const first = text.split("\n", 1)[0] ?? "";
  return (
    first.startsWith(CLOSED_PREFIX) && key(first.slice(CLOSED_PREFIX.length)) === key(question)
  );
}

/**
 * The index of the option a vote message names, or null when it is not a vote for one: the
 * plugin's `🗳️ vote: <option>`, or `/vote <number or option>` as a person types it.
 */
export function parseVote(text: string, options: readonly string[]): number | null {
  const typed = TYPED_VOTE_PATTERN.exec(text);
  if (typed) return matchChoice(text.slice(typed[0].length), options);
  const match = VOTE_PATTERN.exec(text);
  if (!match) return null;
  const named = key(text.slice(match[0].length));
  const index = options.findIndex((option) => key(option) === named);
  return index === -1 ? null : index;
}

/**
 * Count the votes for the poll posted as message `pollMessageId`, from `messages` oldest
 * first. A vote counts when it comes after the poll message and before its author's
 * closing message, and names one of the options; each author's latest such vote is theirs.
 */
export function countVotes(
  messages: readonly TallyMessage[],
  pollMessageId: string,
  poll: PollText,
): Tally {
  const start = messages.findIndex((m) => m.id === pollMessageId);
  const author = start === -1 ? null : messages[start].author;
  const latest = new Map<string, number>();
  let closed = false;
  for (const message of start === -1 ? [] : messages.slice(start + 1)) {
    if (message.author.principalId === author?.principalId) {
      if (isClosedMessage(message.text, poll.question)) {
        closed = true;
        break;
      }
    }
    const vote = parseVote(message.text, poll.options);
    if (vote !== null) latest.set(message.author.principalId, vote);
  }
  const counts = poll.options.map(() => 0);
  for (const vote of latest.values()) counts[vote] += 1;
  return {
    found: start !== -1,
    author,
    closed,
    options: poll.options.map((text, i) => ({ number: i + 1, text, votes: counts[i] })),
    voters: latest.size,
    ballots: latest,
  };
}

/** The tally of a poll nobody voted in yet. */
export function noVotes(poll: PollText): Tally {
  return {
    found: true,
    author: null,
    closed: false,
    options: poll.options.map((text, i) => ({ number: i + 1, text, votes: 0 })),
    voters: 0,
    ballots: new Map(),
  };
}

/** The tally as one line: each option's count and the number of voters. */
export function summarize(question: string, tally: Tally): string {
  const counts = tally.options.map((o) => `${o.text} ${o.votes}`).join(", ");
  const voters = `${tally.voters} voter${tally.voters === 1 ? "" : "s"}`;
  return `${question}: ${counts} (${voters}${tally.closed ? ", closed" : ""})`;
}
