import type { ArmoryPackageTarget } from "../../shared/armory-contracts";

const operatingSystemLabels = new Map([
  ["windows", "Windows"],
  ["linux", "Linux"],
  ["darwin", "macOS"],
]);
const architectureLabels = new Map([
  ["amd64", "x64"],
  ["386", "x86"],
  ["arm64", "ARM64"],
  ["arm", "ARM"],
  ["wasm", "WebAssembly"],
]);

export function armoryOperatingSystemLabel(os: string): string {
  return operatingSystemLabels.get(os) ?? os;
}

export function armoryArchitectureLabel(arch: string): string {
  return architectureLabels.get(arch) ?? arch;
}

export function compareArmoryOperatingSystems(left: string, right: string): number {
  return comparePlatformValues(left, right, ["windows", "linux", "darwin"]);
}

export function compareArmoryArchitectures(left: string, right: string): number {
  return comparePlatformValues(left, right, ["amd64", "386", "arm64", "arm"]);
}

export function matchesArmoryPlatform(targets: readonly ArmoryPackageTarget[] | undefined, os: string, arch: string): boolean {
  return (!os && !arch) || Boolean(targets?.some((target) => (!os || target.os === os) && (!arch || target.arch === arch)));
}

export function armoryTargetOptions(items: readonly { readonly targets?: readonly ArmoryPackageTarget[] }[], field: keyof ArmoryPackageTarget, selected: string): string[] {
  const values = new Set(items.flatMap((item) => item.targets?.map((target) => target[field]) ?? []));
  // Keep a carried-over selection visible when switching tabs or refreshing inventory.
  if (selected) values.add(selected);
  return [...values].sort(field === "os" ? compareArmoryOperatingSystems : compareArmoryArchitectures);
}

function comparePlatformValues(left: string, right: string, priority: readonly string[]): number {
  const leftRank = priority.indexOf(left);
  const rightRank = priority.indexOf(right);
  return (leftRank < 0 ? priority.length : leftRank) - (rightRank < 0 ? priority.length : rightRank) || left.localeCompare(right);
}
