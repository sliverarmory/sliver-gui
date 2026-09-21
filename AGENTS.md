# Repository Guidelines

## Project Structure & Module Organization

Sliver GUI is an Electron application with a React renderer. `src/main/` owns backend connections, native resources, and IPC handlers; `src/preload/` exposes typed bridges; `src/shared/` defines contracts and validation. UI pages, components, and assets live in `src/renderer/src/`. Tests sit beside source files, with Electron scenarios in `src/e2e/` and shared setup in `src/tests/`. `scripts/` contains build/provenance tooling, `protocol/` pins upstream inputs, `docs/` records architecture and verification, and `build/` holds packaging artwork.

## Build, Test, and Development Commands

Use Node 24.15+ on the 24.x line or Node 26+, npm 11.19+, and HeroUI Pro authentication; see `README.md` for setup.

- `npm ci --strict-allow-scripts`: install locked dependencies with approved lifecycle scripts.
- `npm run dev`: build and launch Electron; restart after edits because HMR is disabled.
- `npm run typecheck`: check main/preload and renderer TypeScript projects.
- `npm test` / `npm run test:watch`: run Vitest once or interactively.
- `npm run test:e2e:electron`: build and exercise Electron application workflows.
- `npm run protocol:check`: verify protocol, parity, and client provenance.
- `npm run build`: typecheck and produce `dist/`.
- `npm run package` / `npm run dist`: create an unpacked application or installers in `release/`.

Native packaging requires Go 1.27.1 and a clean Sliver checkout matching `protocol/sliver-console-provenance.json`, supplied through `sliver/` or `SLIVER_SOURCE_DIR`.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons. Name React components `PascalCase.tsx`, utility modules `kebab-case.ts`, and hooks `useSomething`. Follow nearby patterns; no dedicated formatter or lint command is configured. Reuse HeroUI/HeroUI Pro components and Font Awesome icons.

## Testing Guidelines

Vitest uses jsdom and React Testing Library. Colocate `*.test.ts` or `*.test.tsx`; `*.spec.ts(x)` is also supported. Electron `*.e2e.ts` tests use Node's test runner and Playwright. No numeric coverage threshold is configured. Add regression tests for behavior changes, run relevant suites and typechecking, and reserve actual-server tests for explicitly configured disposable environments.

## Commit & Pull Request Guidelines

Use short, imperative subjects such as `Fix Electron E2E reliability`. Keep commits focused. PRs should explain behavior changes, link relevant issues, list validation commands/results, and include screenshots for UI changes. Note skipped checks and platform limitations.

## Security & Configuration

Preserve strict CSP, sandboxing, and typed IPC boundaries. Keep credentials, filesystem access, and network operations in Electron main. Never commit tokens, operator configs, private keys, or generated build/test artifacts.
