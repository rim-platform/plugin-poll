// The poll's text formats and counting rules, without a host.
import { describe, expect, it } from "vitest";

import {
  countVotes,
  formatClosed,
  formatPoll,
  formatVote,
  isClosedMessage,
  matchChoice,
  parseOptions,
  parsePollMessage,
  parseQuestion,
  parseVote,
  PollInputError,
  summarize,
  type TallyMessage,
} from "./tally.ts";

const POLL = { question: "Lunch?", options: ["Pizza", "Sushi", "Tacos"] };
const ADA = { principalId: "rimp1_ada", displayName: "Ada" };
const BOB = { principalId: "rimp1_bob", displayName: "Bob" };
const EVE = { principalId: "rimp1_eve", displayName: "Eve" };

let nextId = 0;
function say(author: TallyMessage["author"], text: string, id = `m${++nextId}`): TallyMessage {
  return { id, author, text };
}

const pollMessage = say(ADA, formatPoll(POLL), "poll");

describe("parseQuestion", () => {
  it("keeps the question on one line, trimmed", () => {
    expect(parseQuestion("  Where do we\n  eat?  ")).toBe("Where do we eat?");
  });

  it("refuses an empty, missing or overlong question", () => {
    expect(() => parseQuestion("   ")).toThrow(PollInputError);
    expect(() => parseQuestion(undefined)).toThrow("question must say what the poll asks.");
    expect(() => parseQuestion("x".repeat(201))).toThrow("at most 200 characters");
    expect(parseQuestion("x".repeat(200))).toHaveLength(200);
  });
});

describe("parseOptions", () => {
  it("splits on | and ; and trims each option", () => {
    expect(parseOptions(" Pizza | Sushi;Tacos  ")).toEqual(["Pizza", "Sushi", "Tacos"]);
    expect(parseOptions("a;b")).toEqual(["a", "b"]);
  });

  it("takes 2 to 8 options", () => {
    expect(() => parseOptions("only one")).toThrow("A poll has 2 to 8 options; this one has 1.");
    expect(parseOptions("1|2|3|4|5|6|7|8")).toHaveLength(8);
    expect(() => parseOptions("1|2|3|4|5|6|7|8|9")).toThrow("this one has 9");
  });

  it("refuses empty, overlong and repeated options", () => {
    expect(() => parseOptions("a||b")).toThrow("Option 2 is empty.");
    expect(() => parseOptions("a|b|")).toThrow("Option 3 is empty.");
    expect(() => parseOptions(`a|${"é".repeat(81)}`)).toThrow(
      "Option 2 is longer than 80 characters.",
    );
    expect(parseOptions(`a|${"é".repeat(80)}`)[1]).toHaveLength(80);
    expect(() => parseOptions("Pizza|sushi|PIZZA")).toThrow('"PIZZA" is listed twice.');
    expect(() => parseOptions(42)).toThrow("options must list 2 to 8 options");
  });
});

describe("matchChoice", () => {
  it("matches an option by its number from 1", () => {
    expect(matchChoice("1", POLL.options)).toBe(0);
    expect(matchChoice(" 3 ", POLL.options)).toBe(2);
    expect(matchChoice("0", POLL.options)).toBeNull();
    expect(matchChoice("4", POLL.options)).toBeNull();
  });

  it("matches an option by its text in any case", () => {
    expect(matchChoice("sushi", POLL.options)).toBe(1);
    expect(matchChoice("  TACOS ", POLL.options)).toBe(2);
    expect(matchChoice("Burgers", POLL.options)).toBeNull();
    expect(matchChoice(2, POLL.options)).toBeNull();
  });

  it("prefers the text of an option that is itself a number out of range", () => {
    expect(matchChoice("2024", ["2023", "2024"])).toBe(1);
    expect(matchChoice("2", ["2023", "2024"])).toBe(1);
  });
});

describe("the messages", () => {
  it("formats the poll so it reads in plain text, and reads it back", () => {
    expect(formatPoll(POLL)).toBe(
      "📊 Poll: Lunch?\n1. Pizza\n2. Sushi\n3. Tacos\nVote with /vote <number>",
    );
    expect(parsePollMessage(formatPoll(POLL))).toEqual(POLL);
  });

  it("reads only what is a poll message", () => {
    expect(parsePollMessage("📊 Poll: Lunch?\n1. Pizza\nVote with /vote <number>")).toBeNull();
    expect(
      parsePollMessage("📊 Poll: Lunch?\n1. Pizza\n3. Sushi\nVote with /vote <number>"),
    ).toBeNull();
    expect(parsePollMessage("📊 Poll: Lunch?\n1. Pizza\n2. Sushi")).toBeNull();
    expect(parsePollMessage(formatClosed("Lunch?", []))).toBeNull();
    expect(parsePollMessage("hello")).toBeNull();
  });

  it("formats a vote and the closing tally", () => {
    expect(formatVote("Sushi")).toBe("🗳️ vote: Sushi");
    expect(
      formatClosed("Lunch?", [
        { number: 1, text: "Pizza", votes: 3 },
        { number: 2, text: "Sushi", votes: 1 },
      ]),
    ).toBe("📊 Poll closed: Lunch?\n1. Pizza — 3\n2. Sushi — 1");
    expect(isClosedMessage(formatClosed("Lunch?", []), "lunch?")).toBe(true);
    expect(isClosedMessage(formatClosed("Dinner?", []), "Lunch?")).toBe(false);
  });

  it("reads a vote by its option's text, with or without the emoji selector", () => {
    expect(parseVote("🗳️ vote: Sushi", POLL.options)).toBe(1);
    expect(parseVote("🗳 vote:  tacos ", POLL.options)).toBe(2);
    expect(parseVote("🗳️ Vote: PIZZA", POLL.options)).toBe(0);
    expect(parseVote("🗳️ vote: Burgers", POLL.options)).toBeNull();
    expect(parseVote("🗳️ vote: 2", POLL.options)).toBeNull();
    expect(parseVote("I vote: Sushi", POLL.options)).toBeNull();
    expect(parseVote("> 🗳️ vote: Sushi", POLL.options)).toBeNull();
  });
});

describe("countVotes", () => {
  it("counts one vote per author, the latest winning", () => {
    const tally = countVotes(
      [
        pollMessage,
        say(BOB, formatVote("Pizza")),
        say(EVE, formatVote("Sushi")),
        say(BOB, "🗳️ vote: tacos"),
      ],
      "poll",
      POLL,
    );
    expect(tally.options.map((o) => o.votes)).toEqual([0, 1, 1]);
    expect(tally).toMatchObject({ found: true, author: ADA, closed: false, voters: 2 });
  });

  it("ignores votes from before the poll message", () => {
    const tally = countVotes(
      [say(BOB, formatVote("Pizza")), say(EVE, formatVote("Pizza")), pollMessage],
      "poll",
      POLL,
    );
    expect(tally.voters).toBe(0);
  });

  it("ignores messages that quote the format but name no option, keeping the earlier vote", () => {
    const tally = countVotes(
      [
        pollMessage,
        say(BOB, formatVote("Sushi")),
        say(BOB, "🗳️ vote: whatever"),
        say(EVE, "🗳️ vote: nothing at all"),
        say(EVE, "Let's vote: Pizza"),
      ],
      "poll",
      POLL,
    );
    expect(tally.options.map((o) => o.votes)).toEqual([0, 1, 0]);
    expect(tally.voters).toBe(1);
  });

  it("counts the author's own vote and stops at the author's closing message", () => {
    const tally = countVotes(
      [
        pollMessage,
        say(ADA, formatVote("Pizza")),
        say(BOB, formatClosed("Lunch?", [])),
        say(BOB, formatVote("Tacos")),
        say(ADA, formatClosed("Lunch?", [])),
        say(EVE, formatVote("Sushi")),
      ],
      "poll",
      POLL,
    );
    expect(tally.closed).toBe(true);
    expect(tally.options.map((o) => o.votes)).toEqual([1, 0, 1]);
  });

  it("counts nothing when the poll message is missing", () => {
    const tally = countVotes([say(BOB, formatVote("Pizza"))], "poll", POLL);
    expect(tally).toMatchObject({ found: false, author: null, voters: 0 });
    expect(tally.options).toHaveLength(3);
  });

  it("sums the tally up in one line", () => {
    const tally = countVotes([pollMessage, say(BOB, formatVote("Pizza"))], "poll", POLL);
    expect(summarize("Lunch?", tally)).toBe("Lunch?: Pizza 1, Sushi 0, Tacos 0 (1 voter)");
    expect(summarize("Lunch?", { ...tally, voters: 2, closed: true })).toBe(
      "Lunch?: Pizza 1, Sushi 0, Tacos 0 (2 voters, closed)",
    );
  });
});
