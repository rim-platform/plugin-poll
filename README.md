# Poll

A [RIM](https://github.com/rim-platform) plugin that runs a quick poll in the conversation you
have open. The poll is a message, every vote is a message, and the plugin counts the votes from
the conversation itself, so everyone who has the plugin sees the same tally and nobody has to
trust a list kept on one device. It is a `WebSandboxed` plugin built on
[`@rim-platform/plugin-sdk`](https://www.npmjs.com/package/@rim-platform/plugin-sdk): it runs in
a sandboxed frame of the app, on the web and on the desktop alike.

## What it asks for

RIM shows the plugin as one that "Runs sandboxed in this app. It cannot read your files, run
programs, or use your RIM session. It reaches RIM only through the permissions below." It asks
for five permissions, each with its own checkbox:

- **Render UI Panels** (`ui.panel`), to show the poll and its votes in its **Poll** panel.
- **Read your conversations** (`chat.read`): "this plugin sees the messages stored on this
  device, except those of encrypted DMs and groups." It reads the messages that follow a poll
  to count the votes, and recent messages to find a poll someone else started.
- **Post as you** (`chat.write`): "this plugin sends messages in your name, except in
  encrypted DMs and groups." It posts the poll, your votes and the closing tally, and only
  when you run one of its commands.
- **Read Encrypted Messages** (`chat.read.encrypted`) and **Send Encrypted Messages**
  (`chat.write.encrypted`), optional: "this plugin sees their decrypted text and can send it
  anywhere its other permissions allow" and "sends messages in your name there, encrypted like
  your own". DMs and groups are encrypted by default, so a poll there needs both. Leave them
  unticked and polls work in plaintext channels only: in an encrypted DM or group the plugin
  says what to allow. The app counts every encrypted message the plugin reads in its audit.

It has no network access, so what it reads stays in the app. The plugin reads messages from what your device stores:
on the web that needs a browser set up as a linked device, and the plugin says so when it is
not.

## What it does

Open **Poll** from the side rail. The panel follows the conversation you have open: with no poll
there it shows a form for a question and 2 to 8 options, and with one it shows each option's
votes with a **Vote** button, your own vote marked. **Refresh** counts again, **Close poll**
(for whoever started it) posts the final tally, **Forget** drops the poll on this device and
**New poll** starts the next one once a poll is closed. The panel runs the commands below; the
command palette does not list the two that take arguments, Start and Vote.

| Command                            | What it does                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Poll: Start** (`poll`)           | Posts `question` with 2 to 8 `options`, separated by `\|` or `;`, each up to 80 characters. One open poll per conversation. |
| **Poll: Vote** (`vote`)            | Posts your vote for `choice`, the option's number or its text in any case. Vote again to change it.               |
| **Poll: Results** (`poll.results`) | Counts the votes and shows them in the panel and as the command's answer.                                         |
| **Poll: Close** (`poll.close`)     | Posts the final tally and closes the poll. Only the person who started it can, and the app asks first.            |
| **Poll: Clear** (`poll.clear`)     | Forgets the conversation's poll on this device without posting, for a poll whose message was deleted. The app asks first. |

A poll reads well without the plugin:

```text
📊 Poll: Lunch?
1. Pizza
2. Sushi
3. Tacos
Vote in the Poll panel, or reply /vote <number>
```

A vote from the panel is a message `🗳️ vote: Sushi`; anyone can also type `/vote 2` or
`/vote sushi` in the conversation. The closing tally is `📊 Poll closed: Lunch?` with a line
per option and its count. The count follows these rules:

- A vote is a message after the poll message whose text starts with `🗳️ vote:` and names one
  of the options, or starts with `/vote` and gives an option's number or text. A message that
  names none is ignored and does not undo an earlier vote.
- Each person has one vote: their latest.
- Messages before the poll message, and after its author's closing tally, do not count.

When you start a poll in a thread, the poll, its votes and its tally stay in that thread.
A poll started at the top of the conversation gets its votes at the top too, or in the thread
you vote from: the app does not let a plugin open a thread on a message, and every vote in the
conversation counts wherever it is.

The plugin remembers each conversation's poll in the app's plugin store for your account on
that device. Someone who did not start the poll, or the same person on another device, finds
it among the conversation's recent messages the first time they vote or ask for the results.

The panel counts an open poll again every minute and when you switch conversations. It has no
links: following one would navigate the panel's frame, which closes it.

## Install

Each way ends the same: RIM shows the plugin and its permissions, you approve them, enable the
plugin and open **Poll** from the side rail.

- **Install from git URL** (desktop): Settings → Plugins → Install from git URL, with
  `https://github.com/rim-platform/plugin-poll.git`. The desktop takes
  `rim-plugin.json`, the committed `main.mjs` and `panels/` from the checkout and leaves the
  rest of the repository out.
- **Install from link** (web and desktop): Settings → Plugins → Install from link, with the
  link a [release](https://github.com/rim-platform/plugin-poll/releases) gives:
  `https://github.com/rim-platform/plugin-poll/releases/download/v<version>/chat.rim.poll-<version>.rimbundle#sha256=<hash>`.
  The app checks that the bundle hashes to the value after `#sha256=` before it installs
  anything. Install from link with a GitHub release asset works on the desktop
  once it fetches links natively (a rim-ui issue); in the browser, install from a workspace
  registry or from a host that sends CORS headers.
- **Workspace registry**: when a workspace recommends or requires the plugin, the command
  palette's "Workspace plugins" offers it with its publisher's signature, and a required one
  is offered when the workspace opens. The app verifies the signed statement before it
  installs the exact version the workspace pinned.

## Develop

Node 22.18 or newer.

```sh
npm ci                 # install the SDK, esbuild and the test tools
npm test               # the plugin over a MessageChannel with a pretend conversation, and the panel in jsdom
npm run typecheck      # tsc with the strict settings plugins use
npm run lint
npm run format:check
npm run build          # bundle src/main.ts into main.mjs; commit the result
npm run check          # main.mjs and panels/ match a fresh build, as CI checks
npm run bundle         # dist/chat.rim.poll-<version>.rimbundle, and its sha256
```

```text
rim-plugin.json    the manifest the app installs by
main.mjs           the built plugin, committed; npm run build writes it
panels/results/    the panel page (plain HTML and JS, rendered with textContent only)
src/main.ts        the entry the build starts from
src/plugin.ts      the commands, the stored polls, reading the conversation and the panel state
src/tally.ts       the poll's text formats and the counting rules
```

A release is a tag `v<version>` matching the version in `rim-plugin.json` and `package.json`,
with a section for it in `CHANGELOG.md`. `CONTRIBUTING.md` has the rules for a pull request.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`.
