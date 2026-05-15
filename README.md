# mo

`mo` is a **M**arkdown viewer that **o**pens `.md` files in a browser, ported to Node.js / npm.

It is a faithful port of [k1LoW/mo](https://github.com/k1LoW/mo) (Go) to a single npm package, distributable via `npx` or `npm install -g`.

## Features

- GitHub-flavored Markdown (tables, task lists, footnotes, etc.)
- Syntax highlighting ([Shiki](https://shiki.style/))
- [Mermaid](https://mermaid.js.org/) diagram rendering
- LaTeX math rendering ([KaTeX](https://katex.org/))
- [GitHub Alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts) (admonitions)
- Fullscreen zoom modal for images and Mermaid diagrams
- Dark / light theme
- File grouping (tab groups)
- Table of contents panel
- Flat / tree sidebar view with drag-and-drop reorder
- File name / heading title sidebar display toggle (per-group)
- Full-text search across file names and content
- YAML frontmatter display (collapsible metadata block)
- MDX file support (renders as Markdown, strips `import`/`export`, escapes JSX tags)
- Content font size toggle (small / medium / large / extra large)
- Wide / narrow content width toggle
- Raw markdown view
- Copy content (Markdown / Text / HTML)
- Server restart with session preservation
- Auto session backup and restore
- Drag-and-drop file addition from the OS file manager
- Stdin pipe support (`cat file.md | mo`)
- Live-reload on save (for files opened via CLI)

## Install

```console
$ npm install -g @kongyo/mo
```

Or run on-demand with npx:

```console
$ npx @kongyo/mo README.md
```

## Usage

```console
$ mo README.md                          # Open a single file
$ mo README.md CHANGELOG.md docs/*.md   # Open multiple files
$ mo docs/                              # Open all .md files in a directory
$ mo spec.md --target design            # Open in a named group
$ cat notes.md | mo                     # Read Markdown from stdin
```

`mo` opens Markdown files in a browser with live-reload. When you save a file, the browser automatically reflects the changes.

### Reading from stdin

When no positional arguments are given and stdin is redirected (not a terminal), `mo` reads Markdown content from stdin.

```console
$ cat notes.md | mo
$ some-command | mo --target output
$ mo < notes.md
```

The content is loaded in-memory with a generated name (`stdin-<hash>.md`). Piping the same content again reuses the existing entry (deduplicated by content hash).

### Single server, multiple files

By default, `mo` runs a single server on port `6275`. If a server is already running on the same port, subsequent `mo` invocations add files to the existing session instead of starting a new one.

```console
$ mo README.md          # Starts a mo server in the background
$ mo CHANGELOG.md       # Adds the file to the running mo server
```

To run a completely separate session, use a different port:

```console
$ mo draft.md -p 6276
```

### Groups

Files can be organized into named groups using the `--target` (`-t`) flag. Each group gets its own URL path and sidebar.

```console
$ mo spec.md --target design      # Opens at http://localhost:6275/design
$ mo api.md --target design       # Adds to the "design" group
$ mo notes.md --target notes      # Opens at http://localhost:6275/notes
```

### Watch mode and glob patterns

`--watch` (`-w`) turns on watch mode. Directory and glob positional arguments are registered as watch patterns, matching files are opened, and new matching files are picked up automatically.

```console
$ mo -w '**/*.md'                              # Watch and open all .md files recursively
$ mo -w 'docs/**/*.md' --target docs           # Watch docs/ tree in "docs" group
$ mo -w docs/                                  # Watch docs/*.md
```

Combine with `--recursive` (`-R`) to descend into subdirectories. Short flags can be combined:

```console
$ mo -w -R docs/                               # Watch docs/**/*.md
$ mo -wR docs/                                 # Same, short-combined
```

#### Removing watch patterns

`--unwatch` removes previously registered patterns. Pass glob patterns or directories as positional arguments.

```console
$ mo --unwatch '**/*.md'
$ mo --unwatch docs/
$ mo --unwatch -R docs/                        # Removes all patterns under docs/
```

### Starting and stopping

`mo` runs in the background by default — the command returns immediately, leaving the shell free for other work.

```console
$ mo README.md
mo: serving at http://localhost:6275 (pid 12345)
$ # shell is available immediately
```

Use `--status` to check all running mo servers, and `--shutdown` to stop one:

```console
$ mo --status              # Show all running mo servers
$ mo --shutdown            # Shut down the mo server on the default port
$ mo --shutdown -p 6276    # Shut down a specific port
$ mo --restart             # Restart the mo server on the default port
```

If you need the mo server to run in the foreground (e.g. for debugging), use `--foreground`.

### Session backup and restore

`mo` automatically saves session state when files are added or removed. When starting a new server, the previous session is automatically restored and merged with any files specified on the command line.

```console
$ mo README.md CHANGELOG.md       # Start with two files
$ mo --shutdown                   # Shut down the server
$ mo                              # Restores README.md and CHANGELOG.md
$ mo TODO.md                      # Restores previous session + adds TODO.md
```

Use `--close` to remove specific files from the running server:

```console
$ mo --close README.md            # Close a file from the default group
$ mo --close docs/*.md -t docs    # Close files from the "docs" group
```

Use `--clear` to remove a saved session:

```console
$ mo --clear                      # Clear saved session for the default port
```

### JSON output

Use `--json` to get structured JSON output on stdout, useful for scripting.

```console
$ mo --json README.md
```

### Flags

| Flag                                | Short | Default     | Description                                          |
| ----------------------------------- | ----- | ----------- | ---------------------------------------------------- |
| `--target`                          | `-t`  | `default`   | Group name                                           |
| `--port`                            | `-p`  | `6275`      | Server port                                          |
| `--bind`                            | `-b`  | `localhost` | Bind address (e.g. `0.0.0.0`)                        |
| `--open`                            |       |             | Always open browser                                  |
| `--no-open`                         |       |             | Never open browser                                   |
| `--status`                          |       |             | Show all running mo servers                          |
| `--watch`                           | `-w`  | `false`     | Treat directory and glob arguments as watch patterns |
| `--unwatch`                         |       | `false`     | Remove watched patterns                              |
| `--recursive`                       | `-R`  | `false`     | Recurse into subdirectories                          |
| `--close`                           |       |             | Close files instead of opening them                  |
| `--shutdown`                        |       |             | Shut down the running mo server                      |
| `--restart`                         |       |             | Restart the running mo server                        |
| `--clear`                           |       |             | Clear saved session                                  |
| `--foreground`                      |       |             | Run mo server in foreground                          |
| `--json`                            |       |             | Output structured data as JSON                       |
| `--dangerously-allow-remote-access` |       |             | Allow remote access without authentication           |

> **Warning:** Binding to a non-localhost address exposes mo to the network **without any authentication**. Remote clients can read any file accessible by the user, browse the filesystem via glob patterns, and shut down the server. A confirmation prompt is shown when `--bind` is set to a non-loopback address.

## Build from source

Requires Node.js >= 20.10.0.

```console
$ npm install
$ cd frontend && npm install
$ cd ..
$ npm run build
$ node dist/bin/mo.js README.md
```

To run the dev server (Vite proxies `/_/` to a foreground `mo` instance):

```console
# Terminal 1: backend
$ npm run dev

# Terminal 2: Vite dev server with HMR
$ cd frontend && npm run dev
```

## License

- [MIT License](LICENSE) (mirrors the upstream Go project)
- Original Go implementation: [k1LoW/mo](https://github.com/k1LoW/mo) by Ken'ichiro Oyama
