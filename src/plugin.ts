// The Poll plugin: a WebSandboxed plugin that posts a poll in the open
// conversation, posts votes as messages, and counts them from the
// conversation's messages, so everyone with the plugin sees the same tally.
// It remembers each conversation's poll in the host's store and shows the poll
// of the conversation it last ran in in its panel.

import {
  definePlugin,
  ErrorCode,
  HostRequestError,
  PluginError,
  type ChatMessage,
  type CommandContext,
  type CommandOutput,
  type Host,
  type Principal,
} from "@rim-platform/plugin-sdk";

import {
  countVotes,
  formatClosed,
  formatPoll,
  formatVote,
  matchChoice,
  noVotes,
  parseOptions,
  parsePollMessage,
  parseQuestion,
  PollInputError,
  summarize,
  type OptionCount,
  type Tally,
  type TallyMessage,
} from "./tally.ts";

export const PLUGIN_ID = "chat.rim.poll";
export const PANEL_ID = "results";
/** How often the panel's open poll is counted again. */
export const REFRESH_MS = 60 * 1000;
/** Messages per `listMessages` call, the most the host gives. */
export const PAGE_SIZE = 100;
/** The most pages one count reads back looking for the poll message. */
export const MAX_SCAN_PAGES = 20;
/** The pages read looking for a poll this device does not remember. */
export const DISCOVERY_PAGES = 3;
/** How far before the poll's recorded start a count still looks for its message. */
const SCAN_MARGIN_MS = 60 * 60 * 1000;
const STORAGE_PREFIX = "poll.";
const SAFE_KEY = /^[A-Za-z0-9._-]{1,120}$/;

/** The poll a conversation has, as this device remembers it. */
export interface StoredPoll {
  conversationId: string;
  messageId: string;
  /** The thread the poll was posted in, where votes go; `null` at the conversation's top. */
  threadId: string | null;
  question: string;
  options: string[];
  status: "open" | "closed";
  /** RFC 3339: when the poll was posted, or its message's time when it was found. */
  createdAt: string;
}

/** The panel's poll. */
export interface PanelPoll {
  question: string;
  status: "open" | "closed";
  options: OptionCount[];
  voters: number;
  /** The votes are counted; false while the poll message is not on this device. */
  counted: boolean;
}

/** What the panel shows; the plugin publishes it whole with `rim.ui.update_panel`. */
export interface PanelState {
  signedIn: boolean;
  /** A poll command ran in a conversation since the plugin started. */
  inConversation: boolean;
  poll: PanelPoll | null;
  notice: string | null;
}

/** A command's payload: the poll and its counts. */
export interface PollPayload {
  question: string;
  status: "open" | "closed";
  voters: number;
  options: OptionCount[];
}

export interface PluginOptions {
  now?: () => number;
  /** How often the panel's open poll is counted again; tests make it short. */
  refreshMs?: number;
}

export const ENCRYPTED_TEXT =
  "This conversation is end-to-end encrypted. Poll works in plaintext conversations only: it does not ask to read or post in encrypted DMs and groups.";
export const NOT_FOUND_TEXT =
  "The poll message is not on this device: it may not be stored here yet, or it was deleted. Try again shortly, or forget the poll with Poll: Clear.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A host's refusal of a chat call, as a message for the person. */
export function explainChatError(error: unknown): unknown {
  if (!(error instanceof HostRequestError)) return error;
  const reason = isRecord(error.data) ? error.data.reason : undefined;
  switch (error.code) {
    case ErrorCode.CAPABILITY_DENIED:
      return new PluginError(
        /\.encrypted\b/u.test(error.message)
          ? ENCRYPTED_TEXT
          : "Poll needs the permissions to read and post in your conversations. Allow them in Settings → Plugins.",
        { code: ErrorCode.CAPABILITY_DENIED },
      );
    case ErrorCode.RATE_LIMITED:
      return new PluginError("Poll made too many chat calls this minute. Try again in a minute.", {
        code: ErrorCode.RATE_LIMITED,
      });
    case ErrorCode.INTERNAL_ERROR:
      if (reason === "noCache") {
        return new PluginError(
          "This browser keeps no messages, so Poll cannot read or post here. Set it up as a linked device, or use the desktop app.",
        );
      }
      if (reason === "notCached") {
        return new PluginError(
          "This conversation is not fully stored on this device yet. Try again shortly.",
        );
      }
      if (reason === "noEncryption") return new PluginError(ENCRYPTED_TEXT);
      break;
  }
  const detail = error.message.replace(/^\S+ failed \(-?\d+\): /u, "");
  return new PluginError(`The app refused: ${detail}`, { code: error.code });
}

async function chat<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw explainChatError(error);
  }
}

/** FNV-1a of `value`, as 8 hex digits. */
function fnv1a(value: string, seed: number): string {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The store key of a conversation's poll; ids the store cannot take as a key are hashed. */
export function storageKey(conversationId: string): string {
  if (SAFE_KEY.test(conversationId)) return `${STORAGE_PREFIX}${conversationId}`;
  return `${STORAGE_PREFIX}h${fnv1a(conversationId, 0x811c9dc5)}${fnv1a(conversationId, 0x050c5d1f)}`;
}

function readStoredPoll(value: unknown, conversationId: string): StoredPoll | null {
  if (!isRecord(value) || value.conversationId !== conversationId) return null;
  const { messageId, threadId, question, options, status, createdAt } = value;
  if (
    typeof messageId !== "string" ||
    (threadId !== null && typeof threadId !== "string") ||
    typeof question !== "string" ||
    !Array.isArray(options) ||
    !options.every((o) => typeof o === "string") ||
    (status !== "open" && status !== "closed") ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  return { conversationId, messageId, threadId, question, options, status, createdAt };
}

/** The conversation the host says the command runs in, and the thread when there is one. */
export function commandContext(args: Readonly<Record<string, unknown>>): {
  conversationId: string;
  threadId: string | null;
} {
  const conversationId = args.conversation_id;
  if (typeof conversationId !== "string" || conversationId === "") {
    throw new PluginError(
      "Open a conversation first: Poll runs in the conversation you have open.",
      {
        code: ErrorCode.INVALID_PARAMS,
      },
    );
  }
  const threadId = args.thread_id;
  if (threadId !== undefined && threadId !== null && typeof threadId !== "string") {
    throw new PluginError("thread_id must be a string.", { code: ErrorCode.INVALID_PARAMS });
  }
  return { conversationId, threadId: threadId || null };
}

function input<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PollInputError) {
      throw new PluginError(error.message, { code: ErrorCode.INVALID_PARAMS });
    }
    throw error;
  }
}

function payloadOf(poll: StoredPoll, tally: Tally): PollPayload {
  return {
    question: poll.question,
    status: poll.status,
    voters: tally.voters,
    options: [...tally.options],
  };
}

/** A fresh plugin. Tests pass a clock and a short refresh. */
export function createPlugin(options: PluginOptions = {}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  let panel: PanelState = { signedIn: false, inConversation: false, poll: null, notice: null };
  let current: string | null = null;
  let panelDenied = false;
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Commands and refreshes run one at a time, so no two change a stored poll at once.
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function publish(host: Host, next: Partial<PanelState>): Promise<void> {
    panel = { ...panel, ...next, signedIn: host.principal !== null };
    if (panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, panel);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the panel needs the ui.panel permission");
        return;
      }
      host.log.warn(`could not update the panel: ${(error as Error).message}`);
    }
  }

  async function showPoll(
    host: Host,
    poll: StoredPoll,
    tally: Tally,
    notice: string | null = null,
  ): Promise<void> {
    await publish(host, {
      inConversation: true,
      notice,
      poll: {
        question: poll.question,
        status: poll.status,
        options: [...tally.options],
        voters: tally.voters,
        counted: tally.found,
      },
    });
  }

  async function load(host: Host, conversationId: string): Promise<StoredPoll | null> {
    return readStoredPoll(await host.storage.get(storageKey(conversationId)), conversationId);
  }

  async function save(host: Host, poll: StoredPoll): Promise<void> {
    await host.storage.set(storageKey(poll.conversationId), poll);
  }

  /**
   * Read the conversation back from its newest message, page by page, until `find` picks a
   * message of a page, the start of the conversation, `maxPages`, or a page older than
   * `floor`. Answers the picked message and the messages from it on, oldest first.
   */
  async function readBack(
    host: Host,
    conversationId: string,
    maxPages: number,
    find: (messages: readonly ChatMessage[]) => number,
    floor = -Infinity,
  ): Promise<{ found: ChatMessage | null; messages: ChatMessage[] }> {
    const pages: (readonly ChatMessage[])[] = [];
    let before: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await chat(() =>
        host.chat.listMessages(conversationId, {
          limit: PAGE_SIZE,
          ...(before === undefined ? {} : { before }),
        }),
      );
      const at = find(page.messages);
      if (at !== -1) {
        pages.unshift(page.messages.slice(at));
        return { found: page.messages[at], messages: pages.flat() };
      }
      pages.unshift(page.messages);
      const oldest = page.messages[0];
      if (!page.hasOlder || !oldest || Date.parse(oldest.sentAt) < floor) break;
      before = oldest.id;
    }
    return { found: null, messages: pages.flat() };
  }

  /** The conversation's messages from the poll message on, reading back to well before it began. */
  async function scan(host: Host, poll: StoredPoll): Promise<ChatMessage[]> {
    const read = await readBack(
      host,
      poll.conversationId,
      MAX_SCAN_PAGES,
      (messages) => messages.findIndex((m) => m.id === poll.messageId),
      Date.parse(poll.createdAt) - SCAN_MARGIN_MS,
    );
    return read.messages;
  }

  /** The latest poll message among the conversation's recent messages, with what follows it. */
  async function discover(
    host: Host,
    conversationId: string,
  ): Promise<{ poll: StoredPoll; messages: ChatMessage[] } | null> {
    const read = await readBack(host, conversationId, DISCOVERY_PAGES, (messages) => {
      for (let at = messages.length - 1; at >= 0; at--) {
        if (parsePollMessage(messages[at].text)) return at;
      }
      return -1;
    });
    const text = read.found && parsePollMessage(read.found.text);
    if (!read.found || !text) return null;
    const message = read.found;
    const poll: StoredPoll = {
      conversationId,
      messageId: message.id,
      threadId: message.threadId,
      question: text.question,
      options: [...text.options],
      status: countVotes(read.messages, message.id, text).closed ? "closed" : "open",
      createdAt: message.sentAt,
    };
    return { poll, messages: read.messages };
  }

  /**
   * The conversation's poll: the open one this device remembers, else the latest poll message
   * in the conversation, remembered from now on, else the closed one this device remembers.
   * `messages` are the ones read on the way, from the poll message on, when there were any.
   */
  async function resolve(
    host: Host,
    conversationId: string,
  ): Promise<{ poll: StoredPoll | null; messages: ChatMessage[] | null }> {
    const stored = await load(host, conversationId);
    if (stored?.status === "open") return { poll: stored, messages: null };
    const found = await discover(host, conversationId);
    if (found && found.poll.messageId !== stored?.messageId) {
      await save(host, found.poll);
      return found;
    }
    return { poll: stored, messages: found?.messages ?? null };
  }

  /** Count `poll`'s votes, and remember it closed when its author closed it. */
  async function count(
    host: Host,
    poll: StoredPoll,
    read: readonly TallyMessage[] | null,
  ): Promise<{ poll: StoredPoll; tally: Tally; messages: readonly TallyMessage[] }> {
    const messages = read ?? (await scan(host, poll));
    const tally = countVotes(messages, poll.messageId, poll);
    if (tally.closed && poll.status === "open") {
      poll = { ...poll, status: "closed" };
      await save(host, poll);
    }
    return { poll, tally, messages };
  }

  function signedIn(context: CommandContext): Principal {
    const person = context.invoker ?? context.host.principal;
    if (!person) throw new PluginError("Sign in to use polls.");
    return person;
  }

  async function start(context: CommandContext): Promise<CommandOutput> {
    const { host, args } = context;
    const { conversationId, threadId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const question = input(() => parseQuestion(args.question));
    const options = input(() => parseOptions(args.options));
    const stored = await load(host, conversationId);
    if (stored?.status === "open") {
      throw new PluginError(
        `A poll is already open in this conversation: "${stored.question}". Close it with Poll: Close first.`,
      );
    }
    const { id } = await chat(() =>
      host.chat.postMessage(
        conversationId,
        formatPoll({ question, options }),
        threadId ? { threadId } : {},
      ),
    );
    const poll: StoredPoll = {
      conversationId,
      messageId: id,
      threadId,
      question,
      options,
      status: "open",
      createdAt: new Date(now()).toISOString(),
    };
    await save(host, poll);
    const tally = noVotes(poll);
    await showPoll(host, poll, tally);
    return { payload: payloadOf(poll, tally), message: `Poll posted: ${question}` };
  }

  async function vote(context: CommandContext): Promise<CommandOutput> {
    const { host, args } = context;
    const { conversationId, threadId } = commandContext(args);
    const person = signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll) {
      await publish(host, { inConversation: true, poll: null, notice: null });
      throw new PluginError("There is no open poll in this conversation. Start one with /poll.");
    }
    const counted = await count(host, resolved.poll, resolved.messages);
    const { poll, tally } = counted;
    if (poll.status === "closed") {
      await showPoll(host, poll, tally);
      throw new PluginError(`The poll "${poll.question}" is closed.`);
    }
    const choice = matchChoice(args.choice, poll.options);
    if (choice === null) {
      throw new PluginError(
        `choice must be a number from 1 to ${poll.options.length} or one of the options: ${poll.options.join(", ")}.`,
        { code: ErrorCode.INVALID_PARAMS },
      );
    }
    const option = poll.options[choice];
    const text = formatVote(option);
    // A plugin cannot open a thread; votes go to the poll's thread, else where the person is.
    const target = poll.threadId ?? threadId;
    const { id } = await chat(() =>
      host.chat.postMessage(conversationId, text, target ? { threadId: target } : {}),
    );
    // This device may not hold the new message yet, so the vote is counted as posted.
    const after = tally.found
      ? countVotes([...counted.messages, { id, author: person, text }], poll.messageId, poll)
      : tally;
    await showPoll(
      host,
      poll,
      after,
      tally.found
        ? null
        : "Your vote is posted. The votes show once the poll message is on this device.",
    );
    return { payload: payloadOf(poll, after), message: `Voted for "${option}"` };
  }

  async function results(context: CommandContext): Promise<CommandOutput> {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll) {
      await publish(host, { inConversation: true, poll: null, notice: null });
      return { payload: null, message: "There is no poll in this conversation." };
    }
    const { poll, tally } = await count(host, resolved.poll, resolved.messages);
    if (!tally.found) {
      await showPoll(host, poll, tally, NOT_FOUND_TEXT);
      throw new PluginError(NOT_FOUND_TEXT);
    }
    await showPoll(host, poll, tally);
    return { payload: payloadOf(poll, tally), message: summarize(poll.question, tally) };
  }

  async function close(context: CommandContext): Promise<CommandOutput> {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    const person = signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll || resolved.poll.status === "closed") {
      throw new PluginError("There is no open poll in this conversation.");
    }
    const { poll, tally } = await count(host, resolved.poll, resolved.messages);
    if (!tally.found) throw new PluginError(NOT_FOUND_TEXT);
    if (poll.status === "closed") {
      await showPoll(host, poll, tally);
      throw new PluginError(`The poll "${poll.question}" is already closed.`);
    }
    if (tally.author?.principalId !== person.principalId) {
      throw new PluginError(
        `Only ${tally.author?.displayName ?? "the person who started the poll"}, who started the poll, can close it. Poll: Clear forgets it on this device.`,
      );
    }
    await chat(() =>
      host.chat.postMessage(
        conversationId,
        formatClosed(poll.question, tally.options),
        poll.threadId ? { threadId: poll.threadId } : {},
      ),
    );
    const closed: StoredPoll = { ...poll, status: "closed" };
    await save(host, closed);
    const final: Tally = { ...tally, closed: true };
    await publish(host, {
      inConversation: true,
      poll: null,
      notice: `Closed "${poll.question}". The final tally is in the conversation.`,
    });
    return { payload: payloadOf(closed, final), message: summarize(poll.question, final) };
  }

  async function clear(context: CommandContext): Promise<CommandOutput> {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const stored = await load(host, conversationId);
    await host.storage.set(storageKey(conversationId), null);
    const message = stored
      ? `Forgot the poll "${stored.question}" on this device.`
      : "This device remembered no poll in this conversation.";
    await publish(host, { inConversation: true, poll: null, notice: message });
    return { message };
  }

  /** Count the panel's poll again while it is open. */
  async function refresh(host: Host): Promise<void> {
    const conversationId = current;
    if (conversationId === null || host.principal === null) return;
    const stored = await load(host, conversationId);
    if (stored?.status !== "open") return;
    const { poll, tally } = await count(host, stored, null);
    if (current !== conversationId) return;
    await showPoll(host, poll, tally, tally.found ? null : NOT_FOUND_TEXT);
  }

  function tick(host: Host): void {
    if (refreshing) return;
    refreshing = true;
    void serial(() => refresh(host))
      .catch(async (error: unknown) => {
        const explained = explainChatError(error);
        await publish(host, {
          notice: explained instanceof Error ? explained.message : String(explained),
        });
      })
      .finally(() => {
        refreshing = false;
      });
  }

  const command = (run: (context: CommandContext) => Promise<CommandOutput>) => ({
    run: (context: CommandContext) => serial(() => run(context)),
  });

  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      poll: command(start),
      vote: command(vote),
      "poll.results": command(results),
      "poll.close": { dangerous: true, ...command(close) },
      "poll.clear": { dangerous: true, ...command(clear) },
    },
    async onReady(host) {
      await publish(host, {});
      timer = setInterval(() => tick(host), refreshMs);
    },
    async onPrincipalChanged(_principal, host) {
      current = null;
      await publish(host, { inConversation: false, poll: null, notice: null });
    },
    onShutdown() {
      if (timer !== null) clearInterval(timer);
    },
  });
}
