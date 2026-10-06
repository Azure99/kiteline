# Repository Guidelines

## Project Structure

Kiteline is a pnpm workspace using strict TypeScript and ESM:

- `server/src/`: HTTP/WebSocket service and SQLite storage.
- `agent/src/`: device operations; `terminal-recorder/src/`: tmux recording.
- `shared/src/`: protocols and platform helpers.
- `web/src/`: React/Vite/Tailwind workbench; `web/public/`: static assets.
- `native/`, `installer/`, `scripts/`, `release/`, `deploy/`: native components, installation, builds,
  release inputs, deployment examples.

The browser communicates through the server; agents initiate outbound connections. Start with
[the documentation map](docs/README.md). Follow [architecture](docs/design/architecture.md) and
[protocol](docs/design/protocol.md) when changing RPC, events, channels, or routes.

## Build, Test, and Development Commands

Develop on Linux x64/arm64 using Node and pnpm versions from `package.json`.
[Setup](docs/development/setup.md) lists native prerequisites. Run from the repository root:

- `corepack enable pnpm`; `pnpm install --frozen-lockfile`: enable pnpm and install dependencies.
- `pnpm native:build`: prepare native tools in `dist/native/`.
- `pnpm build`: compile packages and build the web app.
- `KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm dev`: start watchers, server, and Vite at
  `http://localhost:5173`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: check types, ESLint rules, and formatting;
  `pnpm format` rewrites files.

Run the agent separately per the setup guide, using `KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent` to keep
development identity separate.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, and Prettier's 100-column width with trailing
commas. Follow existing kebab-case filenames, PascalCase components, and `useX` hooks. Reuse
`web/src/components/ui/`; do not regenerate with shadcn CLI. Keep `en.ts` and `zh-CN.ts` synchronized in
`web/src/i18n/`. Preserve Chromium 97 compatibility.

## Testing Guidelines

Vitest tests live in `{server,agent,terminal-recorder,web}/test/**/*.test.ts`;
`web/test/*.typecheck.ts` are checked by `pnpm typecheck`. Add focused behavior tests for changed
contracts. Run `pnpm test` after native and package builds, with Git >=2.23; target files with
`pnpm test agent/test/git-read.test.ts`. No coverage threshold is configured. See
[GitHub Actions](docs/development/release.md#github-actions) for CI coverage.
Check UI changes in current Chrome and Chromium 97 at
desktop/mobile sizes; verify terminal input on Android Chrome. For installer/native changes, test
final [release packages](docs/development/release.md) on affected platforms.

## Commit & Pull Request Guidelines

Use English Conventional Commit subjects, e.g. `fix(agent): reject unknown CLI arguments`. Keep
changes focused. Describe behavior and verification in PRs; include relevant issues and UI screenshots
where useful.

## Documentation

Update affected contracts and existing bilingual user guides when behavior, commands, or configuration
changes.

- Focus design docs on contracts, invariants, and reasons that help maintainers make changes.
- Prefer one maintained source for facts and link to it instead of copying implementation lists or
  values. Preserve essential context, license notices, and source attribution.
- Write guides for actions and decisions: keep prerequisites, steps, and non-obvious consequences;
  omit self-evident UI narration.
- Prefer explaining a reason near the code when it applies only to that local implementation.
