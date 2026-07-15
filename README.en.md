# yome

[![ci](https://github.com/kongyo2/yome/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/yome/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kongyo2/yome.svg)](https://www.npmjs.com/package/@kongyo2/yome)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [日本語](README.md)

`yome` is a Node.js port of [k1LoW/mo](https://github.com/k1LoW/mo). It is a Markdown viewer that opens `.md` files in your browser and live-reloads the rendered output the moment you save.

It faithfully follows the behavior of the original Go implementation while being rewritten in Node.js + React so you can invoke it casually from npm with `npx`.

> Upstream sync status: caught up to the equivalent of mo **v1.6.3** (2026-06-26).

## Features

- **Live reload**: saving a file re-renders it in the browser instantly
- **Single-server model**: shares the default port `6275`, so a later `yome` invocation adds files to the existing session
- **Groups (tabs)**: split content into named groups with `--target`, each with its own URL and sidebar
- **Watch mode**: watches directories and glob patterns, automatically picking up newly created files (an empty group left with only a pattern shows a hint for the unwatch command)
- **stdin input**: Markdown piped from stdin is rendered on the spot
- **Session restore**: even after the server stops, the files you had open are restored automatically on the next launch
- **Rich rendering**:
  - GitHub Flavored Markdown
  - [Mermaid](https://mermaid.js.org/) diagrams (flowcharts, sequence, Gantt, Git graphs, and more)
  - [KaTeX](https://katex.org/) math
  - Syntax highlighting via [Shiki](https://shiki.style/)
  - GitHub Alerts (`> [!NOTE]`, etc.)
  - Front matter support

## Requirements

- Runtime (CLI): Node.js `>= 20.10.0`
- Development (building / testing the frontend): Node.js `^20.19.0 || >= 22.12.0` (required by Vite 8)

## Installation

```bash
# Install globally
npm install -g @kongyo2/yome

# Or run on demand
npx @kongyo2/yome README.md
```

## Usage

```bash
# Open a single file
yome README.md

# Multiple files and globs
yome README.md CHANGELOG.md docs/*.md

# Open in a named group (URL example: http://localhost:6275/design)
yome spec.md --target design

# Change the port
yome draft.md --port 6276

# Read from stdin
cat notes.md | yome
some-command | yome --target output

# Watch a directory recursively
yome -w -R docs/
```

### Server operations

```bash
yome --status              # List running yome servers (also detects orphan backups)
yome --shutdown            # Stop all running yome servers (or just the given --port)
yome --restart             # Restart while preserving state (or just the given --port)
yome --clear               # Discard the saved session (with a confirmation prompt)
yome --clear --yes         # Discard non-interactively from a script / CI (-y also works)
yome --close path/to.md    # Remove just the given file from its group
yome --unwatch docs/       # Remove a watch pattern

# One-off ad-hoc preview (does not restore the previous session, nor keep this content in a backup)
yome SKILL.md --no-restore-session
```

> `--shutdown` keeps a backup so the session can be restored on the next launch. Use `--clear` when you really want it forgotten. `--status` shows a port that only has a backup left (its log is gone) as `(saved session backup only)`.

### Main options

| Option                              | Description                                                       |
| ----------------------------------- | ----------------------------------------------------------------- |
| `-t, --target <name>`               | Group name (default: `default`)                                   |
| `-p, --port <number>`               | Port number (default: `6275`)                                     |
| `-b, --bind <addr>`                 | Bind address (default: `localhost`)                               |
| `-w, --watch`                       | Register a directory / glob as a watch pattern                    |
| `-R, --recursive`                   | Include subdirectories recursively                                |
| `--open` / `--no-open`              | Control automatic opening of the browser                          |
| `--no-restore-session`              | Do not read or write the session backup for the port              |
| `--foreground`                      | Run the server in the foreground                                  |
| `--json`                            | Emit output to stdout in JSON format                              |
| `-y, --yes`                         | Automatically answer yes to confirmation prompts (`--clear` etc.) |
| `--dangerously-allow-remote-access` | Suppress the warning when binding to a non-loopback address       |

Run `yome --help` to see all options.

## Security

- The server binds only to `localhost` by default. Binding to a non-loopback address exposes your files without authentication, so it requires a confirmation prompt and explicit consent via `--dangerously-allow-remote-access`.
- Every state-changing HTTP API (adding / removing / moving / uploading files, watch patterns, shutdown, restart) validates cross-site requests from the browser using the `Sec-Fetch-Site` / `Origin` headers and rejects them.

## License

MIT License.

- Original Go implementation © [k1LoW](https://github.com/k1LoW) — <https://github.com/k1LoW/mo>
- Node.js port © kongyo2

See [`LICENSE`](LICENSE) for details.
