import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faApple, faLinux, faWindows } from "@fortawesome/free-brands-svg-icons";
import { faDesktop } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Chip } from "@heroui/react";

import type { ArmoryPackageTarget } from "../../../shared/armory-contracts";
import { armoryArchitectureLabel, armoryOperatingSystemLabel, compareArmoryArchitectures, compareArmoryOperatingSystems } from "../armory-platforms";

const operatingSystemIcons = new Map<string, IconDefinition>([
  ["windows", faWindows],
  ["linux", faLinux],
  ["darwin", faApple],
]);

export function ArmoryPlatformBadges({ targets }: { targets: readonly ArmoryPackageTarget[] | undefined }): React.JSX.Element {
  const platforms = new Map<string, Set<string>>();
  for (const { os, arch } of targets ?? []) {
    const architectures = platforms.get(os) ?? new Set<string>();
    architectures.add(arch);
    platforms.set(os, architectures);
  }

  return <span role="group" aria-label="Supported platforms" className="flex min-w-0 flex-wrap items-center gap-1.5">
    {platforms.size ? [...platforms].sort(([left], [right]) =>
      compareArmoryOperatingSystems(left, right),
    ).map(([os, architectures]) => {
      const sortedArchitectures = [...architectures].sort(compareArmoryArchitectures);
      return <Chip key={os} size="sm" variant="soft" className="max-w-full gap-1 px-2" title={sortedArchitectures.map((arch) => `${os}/${arch}`).join(", ")}>
        <FontAwesomeIcon aria-hidden icon={operatingSystemIcons.get(os) ?? faDesktop} className="shrink-0 text-muted" />
        <Chip.Label className="min-w-0 break-words">
          {armoryOperatingSystemLabel(os)}<span className="text-muted"> · {sortedArchitectures.map(armoryArchitectureLabel).join(", ")}</span>
        </Chip.Label>
      </Chip>;
    }) : <Chip size="sm" variant="soft" className="text-muted">OS/Arch unknown</Chip>}
  </span>;
}
