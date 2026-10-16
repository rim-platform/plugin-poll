// Tests the Poll plugin over a MessageChannel, as its frame runs, with a
// pretend conversation behind rim.chat.* and the host's store: no RIM app needed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ErrorCode, HostRequestError } from "@rim-platform/plugin-sdk";
import { startTestHost, TEST_PRINCIPAL, validateManifest } from "@rim-platform/plugin-sdk/testing";

import {
  createPlugin,
  ENCRYPTED_TEXT,
  explainChatError,
  NOT_FOUND_TEXT,
  PANEL_ID,
  storageKey,
  type PanelState,
  type StoredPoll,
} from "./plugin.ts";
import { formatClosed, formatPoll, formatVote } from "./tally.ts";

const MANIFEST = `${import.meta.dirname}/../rim-plugin.json`;
const ME = { principalId: TEST_PRINCIPAL.principalId as string, displayName: "Test User" };
const ADA = { principalId: "rimp1_ada", displayName: "Ada" };
const BOB = { principalId: "rimp1_bob", displayName: "Bob" };
const EVE = { principalId: "rimp1_eve", displayName: "Eve" };
const CONVERSATION = "conv-1";
const T0 = Date.parse("2026-10-16T12:00:00Z");

interface Message {
  id: string;
  conversationId: string;
  threadId: string | null;
  author: { principalId: string; displayName: string };
  text: string;
  sentAt: string;
  editedAt: null;
  encrypted: boolean;
  attachments: never[];
}

/** A conversation store answering rim.chat.* as the app's message service does. */
function fakeChat() {
  const conversations = new Map<string, Message[]>();
  const threads = new Set<string>(["thread-1"]);
  const encrypted = new Set<string>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let seq = 0;

  function add(
    author: Message["author"],
    text: string,
    options: { conversationId?: string; threadId?: string | null } = {},
  ): Message {
    seq += 1;
    const conversationId = options.conversationId ?? CONVERSATION;
    const message: Message = {
      id: `msg-${seq}`,
      conversationId,
      threadId: options.threadId ?? null,
      author,
      text,
      sentAt: new Date(T0 + seq * 1000).toISOString(),
      editedAt: null,
      encrypted: false,
      attachments: [],
    };
    conversations.set(conversationId, [...(conversations.get(conversationId) ?? []), message]);
    return message;
  }

  function handle(method: string, params: Record<string, unknown>): unknown {
    calls.push({ method, params });
    const conversationId = String(params.conversationId);
    if (encrypted.has(conversationId)) {
      const capability = method.endsWith("post_message") ? "chat.write" : "chat.read";
      throw {
        code: ErrorCode.CAPABILITY_DENIED,
        message: `capability denied: ${capability}.encrypted`,
      };
    }
    const list = conversations.get(conversationId) ?? [];
    if (method === "rim.chat.list_messages") {
      const limit = Number(params.limit ?? 50);
      const end =
        params.before === undefined ? list.length : list.findIndex((m) => m.id === params.before);
      if (end === -1) throw { code: ErrorCode.INVALID_PARAMS, message: "unknown message" };
      const begin = Math.max(0, end - limit);
      return { messages: list.slice(begin, end), hasOlder: begin > 0 };
    }
    if (method === "rim.chat.post_message") {
      const threadId = (params.threadId as string | undefined) ?? null;
      if (threadId !== null && !threads.has(threadId)) {
        throw { code: ErrorCode.INVALID_PARAMS, message: `unknown thread: ${threadId}` };
      }
      return { id: add(ME, String(params.body), { conversationId, threadId }).id };
    }
    throw { code: ErrorCode.METHOD_NOT_FOUND, message: method };
  }

  return {
    conversations,
    encrypted,
    calls,
    add,
    handle,
    messages: (conversationId = CONVERSATION) => conversations.get(conversationId) ?? [],
    posts: () => calls.filter((c) => c.method === "rim.chat.post_message"),
    lists: () => calls.filter((c) => c.method === "rim.chat.list_messages"),
  };
}

interface StartOptions {
  principal?: null;
  grantedCapabilities?: string[];
  refreshMs?: number;
}

function start(options: StartOptions = {}) {
  const chat = fakeChat();
  const store = new Map<string, unknown>();
  const panels: PanelState[] = [];
  const host = startTestHost(
    createPlugin({ now: () => T0, refreshMs: options.refreshMs ?? 60_000 }),
    {
      transport: "port",
      manifestPath: MANIFEST,
      grantedCapabilities: options.grantedCapabilities ?? ["ui.panel", "chat.read", "chat.write"],
      ...(options.principal === null ? { principal: null } : {}),
      onRequest(method, params) {
        const p = params as Record<string, unknown>;
        if (method === "rim.storage.get") return { value: store.get(String(p.key)) ?? null };
        if (method === "rim.storage.set") {
          if (p.value === null) store.delete(String(p.key));
          else store.set(String(p.key), p.value);
          return { ok: true };
        }
        if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) {
          panels.push(p.state as PanelState);
          return { ok: true };
        }
        if (method.startsWith("rim.chat.")) return chat.handle(method, p);
        return { ok: true };
      },
    },
  );
  const run = (
    command: string,
    args: Record<string, unknown> = {},
    confirmed = false,
    conversation_id: string | null = CONVERSATION,
  ) =>
    host.execute(command, conversation_id === null ? args : { conversation_id, ...args }, {
      confirmed,
    });
  const stored = (conversationId = CONVERSATION) =>
    store.get(storageKey(conversationId)) as StoredPoll | undefined;
  return { host, chat, store, panels, run, stored, panel: () => panels.at(-1) as PanelState };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 5));
  expect(check()).toBe(true);
}

const LUNCH = { question: "Lunch?", options: "Pizza | Sushi | Tacos" };

describe("poll plugin", () => {
  it("has a manifest the host installs once bundled", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(() =>
      validateManifest(manifest, { forbiddenOrigins: ["https://rim.example"] }),
    ).not.toThrow();
    expect(manifest.capabilities).toEqual(["ui.panel", "chat.read", "chat.write"]);
    for (const command of manifest.commands) {
      expect(command.required_context).toEqual(["conversation"]);
      const names = (command.arguments ?? []).map((a: { name: string }) => a.name);
      expect(names).not.toContain("conversation_id");
      expect(names).not.toContain("thread_id");
    }
    const dangerous = manifest.commands.filter((c: { dangerous?: boolean }) => c.dangerous);
    expect(dangerous.map((c: { id: string }) => c.id)).toEqual(["poll.close", "poll.clear"]);
  });

  it("posts the poll as one message and remembers it for the conversation", async () => {
    const t = start();
    expect((await t.host.handshake()).accepted).toBe(true);
    const answer = await t.run("poll", LUNCH);
    expect(answer.result?.message).toBe("Poll posted: Lunch?");
    expect(t.chat.messages().map((m) => [m.text, m.threadId])).toEqual([
      ["📊 Poll: Lunch?\n1. Pizza\n2. Sushi\n3. Tacos\nVote with /vote <number>", null],
    ]);
    expect(t.stored()).toEqual({
      conversationId: CONVERSATION,
      messageId: "msg-1",
      threadId: null,
      question: "Lunch?",
      options: ["Pizza", "Sushi", "Tacos"],
      status: "open",
      createdAt: new Date(T0).toISOString(),
    });
    expect(answer.result?.payload).toMatchObject({ question: "Lunch?", status: "open", voters: 0 });
    expect(t.panel()).toMatchObject({
      signedIn: true,
      inConversation: true,
      notice: null,
      poll: { question: "Lunch?", status: "open", voters: 0, counted: true },
    });
    await t.host.shutdown();
  });

  it("refuses a second open poll, unusable options, and a run outside a conversation", async () => {
    const t = start();
    await t.host.handshake();
    await t.run("poll", LUNCH);
    expect((await t.run("poll", LUNCH)).error?.message).toBe(
      'A poll is already open in this conversation: "Lunch?". Close it with Poll: Close first.',
    );
    expect((await t.run("poll", LUNCH, false, "conv-2")).result?.message).toBe(
      "Poll posted: Lunch?",
    );
    expect(await t.run("poll", { question: "Q", options: "one" }, false, "conv-3")).toMatchObject({
      error: { code: -32602, message: "A poll has 2 to 8 options; this one has 1." },
    });
    expect((await t.run("poll", LUNCH, false, null)).error).toMatchObject({
      code: -32602,
      message: "Open a conversation first: Poll runs in the conversation you have open.",
    });
    expect((await t.run("vote", { choice: "1", thread_id: 5 })).error?.message).toBe(
      "thread_id must be a string.",
    );
    expect(t.chat.posts()).toHaveLength(2);
    await t.host.shutdown();
  });

  it("votes by number or by text, latest vote winning, at the top when the poll is there", async () => {
    const t = start();
    await t.host.handshake();
    await t.run("poll", LUNCH);
    expect((await t.run("vote", { choice: "2" })).result?.message).toBe('Voted for "Sushi"');
    const answer = await t.run("vote", { choice: "tacos" });
    expect(answer.result?.message).toBe('Voted for "Tacos"');
    expect(
      t.chat
        .messages()
        .slice(1)
        .map((m) => [m.text, m.threadId]),
    ).toEqual([
      ["🗳️ vote: Sushi", null],
      ["🗳️ vote: Tacos", null],
    ]);
    expect(t.panel().poll).toMatchObject({ voters: 1, counted: true });
    expect(t.panel().poll?.options.map((o) => o.votes)).toEqual([0, 0, 1]);
    expect(await t.run("vote", { choice: "9" })).toMatchObject({
      error: {
        code: -32602,
        message: "choice must be a number from 1 to 3 or one of the options: Pizza, Sushi, Tacos.",
      },
    });
    // Voting from inside a thread puts the vote there; it counts all the same.
    await t.run("vote", { choice: "1", thread_id: "thread-1" });
    expect(t.chat.messages().at(-1)).toMatchObject({
      text: "🗳️ vote: Pizza",
      threadId: "thread-1",
    });
    expect(t.panel().poll?.options.map((o) => o.votes)).toEqual([1, 0, 0]);
    // The plugin keeps no votes of its own.
    expect([...t.store.values()]).toEqual([t.stored()]);
    await t.host.shutdown();
  });

  it("keeps a poll started in a thread there, with its votes and its closing tally", async () => {
    const t = start();
    await t.host.handshake();
    await t.run("poll", { ...LUNCH, thread_id: "thread-1" });
    await t.run("vote", { choice: "Pizza" });
    await t.run("poll.close", {}, true);
    expect(t.chat.messages().map((m) => m.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(t.stored()?.threadId).toBe("thread-1");
    await t.host.shutdown();
  });

  it("counts everyone's votes from the conversation, paging back to the poll message", async () => {
    const t = start();
    await t.host.handshake();
    t.chat.add(BOB, formatVote("Pizza")); // before the poll: ignored
    await t.run("poll", LUNCH);
    t.chat.add(BOB, formatVote("Sushi"));
    t.chat.add(EVE, formatVote("Sushi"));
    for (let i = 0; i < 220; i++) t.chat.add(ADA, `chatter ${i}`);
    t.chat.add(ADA, "🗳️ vote: burgers"); // names no option
    t.chat.add(BOB, formatVote("Tacos"), { threadId: "thread-1" }); // Bob changes his mind
    const before = t.chat.lists().length;
    const answer = await t.run("poll.results");
    expect(answer.result?.message).toBe("Lunch?: Pizza 0, Sushi 1, Tacos 1 (2 voters)");
    expect(answer.result?.payload).toEqual({
      question: "Lunch?",
      status: "open",
      voters: 2,
      options: [
        { number: 1, text: "Pizza", votes: 0 },
        { number: 2, text: "Sushi", votes: 1 },
        { number: 3, text: "Tacos", votes: 1 },
      ],
    });
    // 225 messages from the poll on: three pages, the last one holding the poll message.
    const lists = t.chat.lists().slice(before);
    expect(lists.map((c) => c.params.limit)).toEqual([100, 100, 100]);
    expect(lists[0].params.before).toBeUndefined();
    expect(t.panel().poll?.voters).toBe(2);
    await t.host.shutdown();
  });

  it("finds a poll this device does not remember, votes in it and remembers it", async () => {
    const t = start();
    await t.host.handshake();
    t.chat.add(EVE, formatPoll({ question: "Old?", options: ["Yes", "No"] }));
    t.chat.add(EVE, formatClosed("Old?", []));
    const poll = t.chat.add(ADA, formatPoll({ question: "Ship it?", options: ["Yes", "No"] }));
    t.chat.add(BOB, formatVote("No"));
    expect((await t.run("vote", { choice: "yes" })).result?.message).toBe('Voted for "Yes"');
    expect(t.stored()).toMatchObject({
      messageId: poll.id,
      question: "Ship it?",
      options: ["Yes", "No"],
      status: "open",
      createdAt: poll.sentAt,
    });
    expect((await t.run("poll.results")).result?.message).toBe("Ship it?: Yes 1, No 1 (2 voters)");
    // Only the person who started it closes it.
    expect((await t.run("poll.close", {}, true)).error?.message).toBe(
      "Only Ada, who started the poll, can close it. Poll: Clear forgets it on this device.",
    );
    // When Ada closes it, the next count sees so and remembers it closed.
    t.chat.add(ADA, formatClosed("Ship it?", []));
    t.chat.add(BOB, formatVote("Yes"));
    expect((await t.run("poll.results")).result?.message).toBe(
      "Ship it?: Yes 1, No 1 (2 voters, closed)",
    );
    expect(t.stored()?.status).toBe("closed");
    expect((await t.run("vote", { choice: "1" })).error?.message).toBe(
      'The poll "Ship it?" is closed.',
    );
    await t.host.shutdown();
  });

  it("says when the conversation has no poll", async () => {
    const t = start();
    await t.host.handshake();
    t.chat.add(BOB, "hello");
    expect((await t.run("poll.results")).result?.message).toBe(
      "There is no poll in this conversation.",
    );
    expect(t.panel()).toMatchObject({ inConversation: true, poll: null });
    expect((await t.run("vote", { choice: "1" })).error?.message).toBe(
      "There is no open poll in this conversation. Start one with /poll.",
    );
    expect((await t.run("poll.close", {}, true)).error?.message).toBe(
      "There is no open poll in this conversation.",
    );
    await t.host.shutdown();
  });

  it("closes the poll once the person confirms, posting the final tally", async () => {
    const t = start();
    await t.host.handshake();
    await t.run("poll", LUNCH);
    t.chat.add(BOB, formatVote("Pizza"));
    t.chat.add(EVE, formatVote("Pizza"));
    await t.run("vote", { choice: "Sushi" });
    expect((await t.run("poll.close")).error).toMatchObject({
      code: -32002,
      data: { reason: "confirmation_required" },
    });
    const answer = await t.run("poll.close", {}, true);
    expect(answer.result?.message).toBe("Lunch?: Pizza 2, Sushi 1, Tacos 0 (3 voters, closed)");
    expect(t.chat.messages().at(-1)?.text).toBe(
      "📊 Poll closed: Lunch?\n1. Pizza — 2\n2. Sushi — 1\n3. Tacos — 0",
    );
    expect(t.stored()?.status).toBe("closed");
    expect(t.panel()).toMatchObject({
      poll: null,
      notice: 'Closed "Lunch?". The final tally is in the conversation.',
    });
    expect((await t.run("poll.close", {}, true)).error?.message).toBe(
      "There is no open poll in this conversation.",
    );
    // The closed poll still shows its final counts, and a new poll may start.
    expect((await t.run("poll.results")).result?.payload).toMatchObject({
      status: "closed",
      voters: 3,
    });
    expect(t.panel().poll?.status).toBe("closed");
    expect((await t.run("poll", { question: "Dinner?", options: "a;b" })).result?.message).toBe(
      "Poll posted: Dinner?",
    );
    await t.host.shutdown();
  });

  it("forgets a poll whose message is gone, without posting", async () => {
    const t = start();
    await t.host.handshake();
    await t.run("poll", LUNCH);
    t.chat.conversations.set(CONVERSATION, []); // the poll message was deleted
    expect((await t.run("poll.results")).error?.message).toBe(NOT_FOUND_TEXT);
    expect(t.panel().notice).toBe(NOT_FOUND_TEXT);
    expect((await t.run("poll.clear")).error?.data).toEqual({ reason: "confirmation_required" });
    const posts = t.chat.posts().length;
    expect((await t.run("poll.clear", {}, true)).result?.message).toBe(
      'Forgot the poll "Lunch?" on this device.',
    );
    expect(t.stored()).toBeUndefined();
    expect(t.chat.posts()).toHaveLength(posts);
    expect(t.panel()).toMatchObject({ poll: null });
    expect((await t.run("poll.clear", {}, true)).result?.message).toBe(
      "This device remembered no poll in this conversation.",
    );
    await t.host.shutdown();
  });

  it("says that encrypted conversations are out of reach, and when chat is not allowed", async () => {
    const t = start();
    await t.host.handshake();
    t.chat.encrypted.add("secret");
    expect((await t.run("poll", LUNCH, false, "secret")).error).toMatchObject({
      code: ErrorCode.CAPABILITY_DENIED,
      message: ENCRYPTED_TEXT,
    });
    expect((await t.run("poll.results", {}, false, "secret")).error?.message).toBe(ENCRYPTED_TEXT);
    expect(t.stored("secret")).toBeUndefined();
    await t.host.shutdown();

    const denied = start({ grantedCapabilities: ["ui.panel"] });
    await denied.host.handshake();
    expect((await denied.run("poll", LUNCH)).error?.message).toBe(
      "Poll needs the permissions to read and post in your conversations. Allow them in Settings → Plugins.",
    );
    await denied.host.shutdown();
  });

  it("needs someone signed in", async () => {
    const t = start({ principal: null });
    await t.host.handshake();
    await until(() => t.panels.length > 0);
    expect(t.panel()).toMatchObject({ signedIn: false, poll: null });
    expect((await t.run("poll", LUNCH)).error?.message).toBe("Sign in to use polls.");
    expect(t.chat.calls).toHaveLength(0);
    await t.host.shutdown();
  });

  it("counts the panel's open poll again on its own", async () => {
    const t = start({ refreshMs: 20 });
    await t.host.handshake();
    await t.run("poll", LUNCH);
    t.chat.add(BOB, formatVote("Tacos"));
    await until(() => t.panel().poll?.voters === 1);
    expect(t.panel().poll?.options.map((o) => o.votes)).toEqual([0, 0, 1]);
    await t.run("poll.close", {}, true);
    const lists = t.chat.lists().length;
    await new Promise((done) => setTimeout(done, 80));
    expect(t.chat.lists()).toHaveLength(lists);
    await t.host.shutdown();
  });
});

describe("explainChatError", () => {
  const refusal = (code: number, message: string, data?: unknown) =>
    explainChatError(
      new HostRequestError("rim.chat.list_messages", { code, message, ...(data ? { data } : {}) }),
    ) as Error;

  it("says what the person can do about each refusal", () => {
    expect(refusal(ErrorCode.INTERNAL_ERROR, "no cache", { reason: "noCache" }).message).toBe(
      "This browser keeps no messages, so Poll cannot read or post here. Set it up as a linked device, or use the desktop app.",
    );
    expect(refusal(ErrorCode.INTERNAL_ERROR, "later", { reason: "notCached" }).message).toBe(
      "This conversation is not fully stored on this device yet. Try again shortly.",
    );
    expect(refusal(ErrorCode.INTERNAL_ERROR, "no", { reason: "noEncryption" }).message).toBe(
      ENCRYPTED_TEXT,
    );
    expect(refusal(ErrorCode.RATE_LIMITED, "slow down").message).toBe(
      "Poll made too many chat calls this minute. Try again in a minute.",
    );
    expect(refusal(ErrorCode.INVALID_PARAMS, "unknown thread: t9").message).toBe(
      "The app refused: unknown thread: t9",
    );
    const other = new Error("boom");
    expect(explainChatError(other)).toBe(other);
  });
});

describe("storageKey", () => {
  it("uses ids the store takes as they are and hashes the rest", () => {
    expect(storageKey("0190f3a2-7c1e-7d00-8000-000000000001")).toBe(
      "poll.0190f3a2-7c1e-7d00-8000-000000000001",
    );
    const hashed = storageKey("conv/with:odd chars");
    expect(hashed).toMatch(/^poll\.h[0-9a-f]{16}$/);
    expect(storageKey("conv/with:odd chars")).toBe(hashed);
    expect(storageKey("conv/with:odd chars!")).not.toBe(hashed);
    expect(storageKey("x".repeat(200))).toMatch(/^poll\.h[0-9a-f]{16}$/);
  });
});
