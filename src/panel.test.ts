// @vitest-environment jsdom
// The Poll panel page in a DOM: it renders the state the plugin publishes as text
// and runs the plugin's commands through the host, never anything itself.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelState } from "./plugin.ts";

const dir = `${import.meta.dirname}/../panels/results`;
const html = readFileSync(`${dir}/index.html`, "utf8");
const script = readFileSync(`${dir}/app.js`, "utf8");

const STATE: PanelState = {
  signedIn: true,
  inConversation: true,
  notice: null,
  poll: {
    question: "<img src=x onerror=alert(1)>",
    status: "open",
    voters: 4,
    counted: true,
    myVote: 2,
    mine: true,
    options: [
      { number: 1, text: "Pizza", votes: 3 },
      { number: 2, text: "Sushi", votes: 1 },
      { number: 3, text: "Tacos", votes: 0 },
    ],
  },
};

let added: Array<() => void>;
let sent: Array<Record<string, unknown>>;

/** The commands the panel asked the host to run, without the plugin id. */
const commands = () =>
  sent
    .filter((m) => m.type === "rim.command.execute")
    .map((m) => [(m.commandId as string).replace("plugin.chat.rim.poll.", ""), m.args]);

function answer(ok: boolean, message = "") {
  const last = sent.filter((m) => m.type === "rim.command.execute").at(-1);
  fromHost({ type: "rim.command.result", requestId: last?.requestId, ok, message });
}

function click(id: string) {
  (document.getElementById(id) as HTMLButtonElement).click();
}

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

const text = (id: string) => document.getElementById(id)?.textContent;
const hidden = (id: string) => document.getElementById(id)?.hidden;

beforeEach(() => {
  vi.useFakeTimers();
  added = [];
  sent = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      add(type, listener, options);
      added.push(() => target.removeEventListener(type, listener, options));
    });
  }
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as Record<string, unknown>);
  });
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[^>]*><\/script>/, "");
  new Function(script)();
});

afterEach(() => {
  for (const remove of added) remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Poll panel", () => {
  it("renders the question, the counts with bars and the voters, as text, with no links", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    expect(text("question")).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(text("status")).toBe("open");
    const rows = [...document.querySelectorAll("#options li")];
    expect(
      rows.map((r) => [
        r.querySelector(".text")?.textContent,
        r.querySelector(".count")?.textContent,
        r.querySelector("button")?.textContent,
      ]),
    ).toEqual([
      ["1. Pizza", "3", "Vote"],
      ["2. Sushi", "1", "Your vote"],
      ["3. Tacos", "0", "Vote"],
    ]);
    expect(rows[1].className).toBe("mine");
    expect(rows.map((r) => (r.querySelector(".bar") as HTMLElement).style.width)).toEqual([
      "100%",
      "33%",
      "0%",
    ]);
    expect(text("footer")).toBe(
      "4 voters. Each person's latest vote counts; /vote <number> in the conversation counts too.",
    );
    expect(hidden("empty")).toBe(true);
    expect(document.querySelector("a")).toBeNull();
  });

  it("keeps a hidden section hidden although its styles give it a display", () => {
    // jsdom does not cascade author styles over `hidden`, so the rule itself is checked.
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const hiddenRule = rules.find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText === "[hidden]",
    );
    expect(hiddenRule?.style.getPropertyValue("display")).toBe("none");
    expect(hiddenRule?.style.getPropertyPriority("display")).toBe("important");
  });

  it("shows a closed poll without votes to cast, and one whose votes are not counted yet", () => {
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: { ...STATE.poll, status: "closed", voters: 1 } },
    });
    expect(text("status")).toBe("closed");
    expect(document.querySelectorAll("#options button")).toHaveLength(0);
    expect(hidden("close")).toBe(true);
    expect(hidden("new-poll")).toBe(false);
    fromHost({
      type: "panel.state_update",
      state: {
        ...STATE,
        notice: "Your vote is posted.",
        poll: { ...STATE.poll, counted: false },
      },
    });
    expect(text("notice")).toBe("Your vote is posted.");
    expect(text("footer")).toBe("The votes are not counted yet.");
  });

  it("offers a new poll when there is none, and says when it waits or nobody is signed in", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, poll: null } });
    expect(hidden("header")).toBe(true);
    expect(hidden("form")).toBe(false);
    expect(hidden("cancel")).toBe(true);
    expect(document.querySelectorAll("#form-options input")).toHaveLength(2);
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: null, notice: 'Closed "Lunch?".' },
    });
    expect(text("notice")).toBe('Closed "Lunch?".');
    expect(hidden("form")).toBe(false);
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, inConversation: false, poll: null },
    });
    expect(text("empty")).toBe("Looking for a poll in this conversation…");
    expect(hidden("form")).toBe(true);
    fromHost({ type: "panel.state_update", state: { ...STATE, signedIn: false } });
    expect(text("empty")).toBe("Sign in to use polls.");
  });

  it("asks for the open conversation's poll, and again each time another one opens", () => {
    fromHost({ type: "conversation.changed", conversationId: "c1" });
    fromHost({ type: "conversation.changed", conversationId: "c1" });
    fromHost({ type: "conversation.changed", conversationId: "c2" });
    fromHost({ type: "conversation.changed", conversationId: null });
    fromHost({ type: "panel.state_update", state: STATE });
    expect(commands()).toEqual([
      ["poll.results", {}],
      ["poll.results", {}],
    ]);
    expect(text("empty")).toBe("Open a conversation to see its poll.");
    vi.advanceTimersByTime(1000);
    expect(commands()).toHaveLength(2);
  });

  it("asks once on its own when the host never says which conversation is open", () => {
    vi.advanceTimersByTime(399);
    expect(commands()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(commands()).toEqual([["poll.results", {}]]);
  });

  it("votes, refreshes, closes and forgets through the plugin, waiting for each answer", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    const votes = document.querySelectorAll<HTMLButtonElement>("#options button");
    votes[1].click(); // already my vote: nothing
    votes[0].click();
    expect(commands()).toEqual([["vote", { choice: "1" }]]);
    expect(votes[2].disabled).toBe(true);
    answer(true, 'Voted for "Pizza"');
    click("refresh");
    answer(true);
    click("close");
    answer(false, "Cancelled");
    click("forget");
    expect(commands().map(([verb]) => verb)).toEqual([
      "vote",
      "poll.results",
      "poll.close",
      "poll.clear",
    ]);
    // The host asks before closing or forgetting; the panel never claims it.
    expect(sent.some((m) => "confirmed" in m)).toBe(false);

    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: { ...STATE.poll, mine: false } },
    });
    expect(hidden("close")).toBe(true);
  });

  it("posts a new poll from the form once it is complete", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, poll: null } });
    click("post");
    expect(text("error")).toBe("Write the question first.");
    (document.getElementById("form-question") as HTMLInputElement).value = " Lunch? ";
    const inputs = () => document.querySelectorAll<HTMLInputElement>("#form-options input");
    inputs()[0].value = "Pizza";
    click("post");
    expect(text("error")).toBe("A poll needs at least two options.");
    click("add-option");
    inputs()[1].value = "Sushi | Tacos";
    click("post");
    expect(text("error")).toBe("An option cannot contain | or ;.");
    inputs()[1].value = "Sushi";
    inputs()[2].value = "Tacos";
    click("post");
    expect(commands()).toEqual([
      ["poll", { question: "Lunch?", options: "Pizza | Sushi | Tacos" }],
    ]);

    answer(false, "A poll is already open in this conversation.");
    expect(text("error")).toBe("A poll is already open in this conversation.");
    expect(inputs()[2].value).toBe("Tacos");
    click("post");
    answer(true, "Poll posted: Lunch?");
    expect(hidden("error")).toBe(true);
    expect([...inputs()].map((i) => i.value)).toEqual(["", ""]);
  });

  it("posts with Enter in a field and has no form for the sandbox to refuse", () => {
    expect(document.querySelector("form")).toBeNull();
    fromHost({ type: "panel.state_update", state: { ...STATE, poll: null } });
    (document.getElementById("form-question") as HTMLInputElement).value = "Lunch?";
    const inputs = document.querySelectorAll<HTMLInputElement>("#form-options input");
    inputs[0].value = "Pizza";
    inputs[1].value = "Sushi";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    inputs[1].dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(commands()).toEqual([["poll", { question: "Lunch?", options: "Pizza | Sushi" }]]);
  });

  it("starts the next poll from a closed one, and shows a failure the notice does not say", () => {
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: { ...STATE.poll, status: "closed" } },
    });
    click("new-poll");
    expect(hidden("form")).toBe(false);
    click("cancel");
    expect(hidden("form")).toBe(true);

    fromHost({ type: "panel.state_update", state: { ...STATE, notice: "Not stored yet." } });
    click("refresh");
    answer(false, "Not stored yet.");
    expect(hidden("error")).toBe(true);
    click("refresh");
    answer(false, "The app refused: boom");
    expect(text("error")).toBe("The app refused: boom");
  });

  it("ignores messages that do not come from the host", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "panel.state_update", state: STATE } }),
    );
    expect(document.querySelectorAll("#options li")).toHaveLength(0);
    expect(text("empty")).toBe("Waiting for the plugin…");
  });

  it("takes the app's theme and says the plugin stopped once its state goes away", () => {
    fromHost({ type: "theme.changed", variables: { "--color-rim-accent": "#123456" } });
    expect(document.documentElement.style.getPropertyValue("--color-rim-accent")).toBe("#123456");
    fromHost({ type: "panel.state_update", state: STATE });
    fromHost({ type: "panel.state_update", state: null });
    expect(document.querySelectorAll("#options li")).toHaveLength(0);
    expect(text("empty")).toBe("The plugin stopped.");
  });
});
