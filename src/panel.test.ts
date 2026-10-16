// @vitest-environment jsdom
// The Poll panel page in a DOM: it renders the state the plugin publishes as text.
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
    options: [
      { number: 1, text: "Pizza", votes: 3 },
      { number: 2, text: "Sushi", votes: 1 },
      { number: 3, text: "Tacos", votes: 0 },
    ],
  },
};

let added: Array<() => void>;

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

const text = (id: string) => document.getElementById(id)?.textContent;
const hidden = (id: string) => document.getElementById(id)?.hidden;

beforeEach(() => {
  added = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      add(type, listener, options);
      added.push(() => target.removeEventListener(type, listener, options));
    });
  }
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[^>]*><\/script>/, "");
  new Function(script)();
});

afterEach(() => {
  for (const remove of added) remove();
  vi.restoreAllMocks();
});

describe("Poll panel", () => {
  it("renders the question, the counts with bars and the voters, as text, with no links", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    expect(text("question")).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(text("status")).toBe("open");
    const rows = [...document.querySelectorAll("#options li")];
    expect(rows.map((r) => r.querySelector(".row")?.textContent)).toEqual([
      "1. Pizza3",
      "2. Sushi1",
      "3. Tacos0",
    ]);
    expect(rows.map((r) => (r.querySelector(".bar") as HTMLElement).style.width)).toEqual([
      "100%",
      "33%",
      "0%",
    ]);
    expect(text("footer")).toBe("4 voters. Each person's latest vote counts.");
    expect(hidden("empty")).toBe(true);
    expect(document.querySelector("a")).toBeNull();
  });

  it("shows a closed poll, and one whose votes are not counted yet", () => {
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: { ...STATE.poll, status: "closed", voters: 1 } },
    });
    expect(text("status")).toBe("closed");
    expect(text("footer")).toBe("1 voter. Each person's latest vote counts.");
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

  it("says when there is no poll, no conversation yet, or nobody signed in", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, poll: null } });
    expect(hidden("header")).toBe(true);
    expect(document.querySelectorAll("#options li")).toHaveLength(0);
    expect(text("empty")).toBe("There is no poll in this conversation.");
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, poll: null, notice: 'Closed "Lunch?".' },
    });
    expect(hidden("notice")).toBe(false);
    expect(text("notice")).toBe('Closed "Lunch?".');
    expect(hidden("empty")).toBe(true);
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, inConversation: false, poll: null },
    });
    expect(text("empty")).toBe("Run a poll command in a conversation to see its poll here.");
    fromHost({ type: "panel.state_update", state: { ...STATE, signedIn: false } });
    expect(text("empty")).toBe("Sign in to use polls.");
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
