import { isAwsRegion } from "../../shared/cloud-deployment-contracts.js";

/**
 * Fixed console entry points, independent of OAuth authorization requests.
 * https://docs.aws.amazon.com/signin/latest/userguide/sign-in-urls-defined.html
 * https://docs.amazonaws.cn/en_us/aws/latest/userguide/console.html
 * https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/configure-account.html
 */
export function awsConsoleEntryUrl(region: string): string {
  if (!isAwsRegion(region)) throw new TypeError("The AWS Console region is invalid or unsupported.");
  if (/^cn-(?:north|northwest)-[1-9]\d?$/u.test(region)) return "https://console.amazonaws.cn/";
  if (/^us-gov-(?:east|west)-[1-9]\d?$/u.test(region)) return "https://console.amazonaws-us-gov.com/";
  if (/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9]\d?$/u.test(region)) {
    return "https://console.aws.amazon.com/";
  }
  // Restricted/sovereign partitions must never fall back to a commercial page.
  throw new TypeError("The AWS Console region is invalid or unsupported.");
}
