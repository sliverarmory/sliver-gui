import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faAmazon, faApple, faLinux, faMicrosoft, faWindows } from "@fortawesome/free-brands-svg-icons";
import { faCloud, faComputer, faCube, faLaptop, faSatellite, faServer } from "@fortawesome/free-solid-svg-icons";

const icons = new Map([
  ["aws", faAmazon], ["azure", faMicrosoft], ["cloud", faCloud],
  ["client", faLaptop], ["server", faServer], ["computer", faComputer],
  ["windows", faWindows], ["linux", faLinux], ["apple", faApple], ["beacon", faSatellite],
]);

export function TopologyIcon({ name, className = "" }: { name: string; className?: string }) {
  return <FontAwesomeIcon aria-hidden icon={icons.get(name) ?? faCube} className={className} />;
}
