# Repository Guidelines

## Project Structure

Kiteline is a pnpm workspace using strict TypeScript and ESM:

- `packages/server/src/`: HTTP/WebSocket service and SQLite storage.
- `packages/agent/src/`: device operations; `packages/terminal-recorder/src/`: tmux recording.
- `packages/cli/src/`: remote `kiteline` CLI.
- `packages/shared/src/`: protocols and platform helpers.
- `packages/web/src/`: React/Vite/Tailwind workbench; `packages/web/public/`: static assets.
- `native/`, `installer/`, `scripts/`, `release/`, `deploy/`: native components, installation, builds, release inputs, deployment examples.

The browser communicates through the server; agents initiate outbound connections. Start with [the documentation map](docs/README.md). Follow [architecture](docs/design/architecture.md) and [protocol](docs/design/protocol.md) when changing RPC, events, channels, or routes.

## Build, Test, and Development Commands

Develop on Linux x64/arm64 using Node and pnpm versions from `package.json`. [Setup](docs/development/setup.md) lists native prerequisites. Run from the repository root:

- `corepack enable pnpm`; `pnpm install --frozen-lockfile`: enable pnpm and install dependencies.
- `pnpm native:build`: prepare native tools in `dist/native/`.
- `pnpm build`: compile packages and build the web app.
- `KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm dev`: start watchers, server, and Vite at `http://localhost:5173`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: check types, ESLint rules, and formatting; `pnpm format` rewrites files.

Run the agent separately per the setup guide, using `KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent` to keep development identity separate.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, and Prettier's 100-column width with trailing commas. Follow existing kebab-case filenames, PascalCase components, and `useX` hooks. Reuse `packages/web/src/components/ui/`; do not regenerate with shadcn CLI. Keep `en.ts` and `zh-CN.ts` synchronized in `packages/web/src/i18n/`. Preserve Chromium 97 compatibility.

## Testing Guidelines

Vitest test locations are defined in [vitest.config.ts](vitest.config.ts); `packages/web/test/*.typecheck.ts` are checked by `pnpm typecheck`. Add focused behavior tests for changed contracts. Run `pnpm test` after `pnpm native:build` and `pnpm build`, with Git >=2.23; target files with `pnpm test packages/agent/test/git-read.test.ts`. See [GitHub Actions](docs/development/release.md#github-actions) for CI coverage. Check UI changes in current Chrome and Chromium 97 at desktop/mobile sizes; verify terminal input on Android Chrome. For installer/native changes, test final [release packages](docs/development/release.md) on affected platforms.

## Commit & Pull Request Guidelines

Use English Conventional Commit subjects, e.g. `fix(agent): reject unknown CLI arguments`. Keep changes focused. Describe behavior and verification in PRs; include relevant issues and UI screenshots where useful.

## Documentation

Most changes need no documentation change. Before adding a sentence, decide where the fact belongs; if it fits none of the places below, leave it out.

- **User guides** (`README`, `docs/guide/`) help a reader act or decide. Change them when a prerequisite, command, option, configuration value, limit, or error message changes, or when a consequence would surprise the reader: data loss, security exposure, something that cannot be undone. Do not describe what the interface already shows (control locations, keyboard and focus behavior, layout thresholds, timings) or how a feature is implemented.
- **Design docs** (`docs/design/`) hold what a maintainer cannot learn from one file: contracts between components, which component owns each piece of state, invariants a change must preserve, and the reason for a trade-off. Do not restate what a single module does, list its functions, or copy its constants; link to the source.
- **Code comments** hold a non-obvious reason that applies to one implementation: one or two lines, in English, next to the code. Self-explanatory code gets neither a comment nor a doc sentence.
- **Tests** hold exact behavior. A threshold, ordering, or edge case that must not regress belongs in a test, not in prose.

State each fact once and link to it; [the reference](docs/guide/reference.md) owns commands, environment variables, limits, and file locations. Say what the software does not do only when the reader would otherwise act wrongly. Keep license notices and source attribution.

When a change makes existing text wrong, fix it; when it makes text unnecessary, delete it. Keep each guide aligned with its `.en.md` counterpart. The web app links to guide headings (search `docs/guide/` in `packages/web/src/`); update those links when renaming a heading or moving a section.
