# Changelog

What changes between releases of the Poll plugin, for the people who use it and the workspaces
that recommend it. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); a release is the tag `v<version>`,
the version in `rim-plugin.json` and in `package.json`.

## How entries are written

- A pull request that changes what a user or a workspace sees adds its line under `Unreleased`
  in the same pull request. Refactors, tests and internal documentation do not.
- Each line goes under one heading: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or
  `Security`. It says what changed for the reader, not how it was built.
- A change to the plugin's permissions or commands names them: a new permission makes every
  install ask again.
- At release time `Unreleased` becomes `## [<version>] - <YYYY-MM-DD>` and a new empty
  `Unreleased` starts above it.

## [Unreleased]

## [0.0.1] - 2026-10-16

### Added

- The Poll plugin. **Poll: Start** posts a poll of 2 to 8 options in the open conversation,
  **Poll: Vote** posts your vote as a message, **Poll: Results** counts the votes from the
  conversation's messages, one per person with the latest counting, and **Poll: Close** posts
  the final tally. **Poll: Clear** forgets a poll whose message is gone.
- The **Poll** panel shows the question, each option's votes with a bar, the number of
  voters and whether the poll is open, and counts an open poll again every minute.
- It asks for **Render UI Panels**, **Read your conversations** and **Post as you**, and works
  in plaintext conversations only.
- The repository holds the built plugin at its root (`rim-plugin.json`, `main.mjs` and
  `panels/`), so the desktop installs it from its git URL; each release attaches a
  `.rimbundle` for Install from link.

[Unreleased]: https://github.com/rim-platform/plugin-poll/compare/v0.0.1...master
[0.0.1]: https://github.com/rim-platform/plugin-poll/releases/tag/v0.0.1
