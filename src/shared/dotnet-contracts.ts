import type { TargetRef } from "./target-contracts.js";

/** Renderer-safe description of one installed Armory .NET alias. */
export interface DotNetAssembly {
  readonly id: string;
  readonly commandName: string;
  readonly packageName: string;
  readonly description: string;
  readonly fileName: string;
  readonly isDll: boolean;
  readonly available: boolean;
  readonly reason?: string;
}

export interface DotNetCatalog {
  readonly target: TargetRef;
  readonly assemblies: readonly DotNetAssembly[];
}
