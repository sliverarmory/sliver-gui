import { describe, expect, it } from "vitest";
import { BEAGLE_DRILLDOWNS, BEAGLE_PATH_EDGE_CATEGORIES, BEAGLE_PATH_EDGE_KINDS, getBeagleDrilldowns } from "./beagle-investigations.js";

describe("Beagle contextual investigation catalog", () => {
  it("covers the pinned CE's 71 actions across 15 sections, plus direct relationships", () => {
    expect(BEAGLE_DRILLDOWNS).toHaveLength(72);
    expect(new Set(BEAGLE_DRILLDOWNS.map((entry) => entry.id)).size).toBe(72);
    expect(new Set(BEAGLE_DRILLDOWNS.flatMap((entry) => entry.kinds)).size).toBe(15);
  });

  it("selects the specific kind section despite the ubiquitous Base label", () => {
    const ids = getBeagleDrilldowns(["Base", "Computer", "Tag_Tier_Zero"]).map((entry) => entry.id);
    expect(ids).toContain("relationships");
    expect(ids).toContain("computer-local_admins");
    expect(ids).toContain("computer-outbound_object_control");
    expect(ids).not.toContain("base-outbound_object_control");
    expect(ids).not.toContain("user-member_of");
  });

  it("provides generic control investigations for local and unknown kinds", () => {
    expect(getBeagleDrilldowns(["Base", "ADLocalUser"]).map((entry) => entry.id)).toEqual([
      "relationships", "base-outbound_object_control", "base-inbound_object_control",
    ]);
  });

  it("partitions the 62 pinned frontend traversable kinds without duplicates", () => {
    expect(BEAGLE_PATH_EDGE_KINDS).toHaveLength(62);
    expect(new Set(BEAGLE_PATH_EDGE_KINDS).size).toBe(62);
    expect(BEAGLE_PATH_EDGE_CATEGORIES.flatMap((entry) => entry.kinds)).toEqual(BEAGLE_PATH_EDGE_KINDS);
    expect(BEAGLE_PATH_EDGE_KINDS).toContain("ProtectAdminGroups");
    expect(BEAGLE_PATH_EDGE_KINDS).toContain("CoerceAndRelayNTLMToLDAPS");
    expect(BEAGLE_PATH_EDGE_KINDS).not.toContain("GetChanges");
    expect(BEAGLE_PATH_EDGE_KINDS).not.toContain("CrossForestTrust");
    // Actual StringKind values, not Go identifiers (WriteDACL != "WriteDacl").
    const ceKinds = "Owns GenericAll GenericWrite WriteOwner WriteDacl MemberOf ForceChangePassword AllExtendedRights AddMember HasSession GPLink AllowedToDelegate CoerceToTGT AllowedToAct AdminTo CanPSRemote CanRDP ExecuteDCOM HasSIDHistory AddSelf DCSync ReadLAPSPassword ReadGMSAPassword DumpSMSAPassword SQLAdmin AddAllowedToAct WriteSPN AddKeyCredentialLink SyncLAPSPassword WriteAccountRestrictions WriteGPLink GoldenCert ADCSESC1 ADCSESC3 ADCSESC4 ADCSESC6a ADCSESC6b ADCSESC9a ADCSESC9b ADCSESC10a ADCSESC10b ADCSESC13 SyncedToADUser CoerceAndRelayNTLMToSMB CoerceAndRelayNTLMToADCS WriteOwnerLimitedRights OwnsLimitedRights ClaimSpecialIdentity CoerceAndRelayNTLMToLDAP CoerceAndRelayNTLMToLDAPS HasTrustKeys WriteAltSecurityIdentities WritePublicInformation ManageCA ManageCertificates ServerIs Contains DCFor SameForestTrust SpoofSIDHistory AbuseTGTDelegation ProtectAdminGroups".split(" ");
    expect([...BEAGLE_PATH_EDGE_KINDS].sort()).toEqual(ceKinds.sort());
  });
});
