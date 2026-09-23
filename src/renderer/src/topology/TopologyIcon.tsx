import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faAmazon, faApple, faLinux, faMicrosoft, faWindows } from "@fortawesome/free-brands-svg-icons";
import { faCloud, faComputer, faCube, faHammer, faLaptop, faMicrochip, faSatellite, faServer, faUser, faNetworkWired } from "@fortawesome/free-solid-svg-icons";

const icons = new Map([
  ["aws", faAmazon], ["azure", faMicrosoft], ["cloud", faCloud],
  ["client", faLaptop], ["server", faServer], ["computer", faComputer], ["session", faComputer],
  ["windows", faWindows], ["linux", faLinux], ["apple", faApple], ["beacon", faSatellite],
  ["operator", faUser], ["relay", faNetworkWired], ["egress", faNetworkWired],
  ["external-builder", faHammer], ["crackstation", faMicrochip],
]);

export function TopologyIcon({ name, className = "" }: { name: string; className?: string }) {
  return <FontAwesomeIcon aria-hidden icon={icons.get(name) ?? faCube} className={className} />;
}
