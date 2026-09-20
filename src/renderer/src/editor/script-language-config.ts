export const SCRIPT_LANGUAGE_ID = "sliver-script";

// These settings belong only to the script profile's analysis worker. Generic
// Monaco JavaScript/TypeScript editors keep their own language-service defaults.
export const SCRIPT_COMPILER_OPTIONS = {
  allowJs: true,
  allowNonTsExtensions: true,
  checkJs: true,
  noEmit: true,
  noResolve: true,
  target: 99,
  module: 0,
  // Every saved script has a fresh execution global; keep declarations from
  // cached editor models from colliding in the analysis service too.
  moduleDetection: 3,
  lib: ["lib.es2023.d.ts"],
  types: [],
};

export const SCRIPT_CONSOLE_TYPES = `
/** Output-only console supplied by the application's QuickJS sandbox. */
declare const console: {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  debug(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};
`;

export const SCRIPT_WORKER_DATA = {
  compilerOptions: SCRIPT_COMPILER_OPTIONS,
  extraLibs: {
    "file:///sliver-script-console.d.ts": { content: SCRIPT_CONSOLE_TYPES, version: 1 },
  },
};
