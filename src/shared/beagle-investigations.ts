/** Contextual AD investigations pinned to BloodHound CE v9.8.0 (1759e163).
 * Action names: bh-shared-ui/src/utils/content.ts; semantics: analysis/ad/queries.go.
 * Keep these IDs independent of labels: they are validated IPC query selectors.
 */
export interface BeagleDrilldown {
  id: string;
  label: string;
  category: string;
  kinds: readonly string[];
}

export const BEAGLE_DRILLDOWNS: readonly BeagleDrilldown[] = [
  { id: "relationships", label: "Relationships", category: "General", kinds: [] },
  { id: "base-outbound_object_control", label: "Outbound Object Control", category: "Base", kinds: ["Base"] },
  { id: "base-inbound_object_control", label: "Inbound Object Control", category: "Base", kinds: ["Base"] },
  { id: "container-inbound_object_control", label: "Inbound Object Control", category: "Container", kinds: ["Container"] },
  { id: "aiaca-inbound_object_control", label: "Inbound Object Control", category: "AIACA", kinds: ["AIACA"] },
  { id: "aiaca-pki_hierarchy", label: "PKI Hierarchy", category: "AIACA", kinds: ["AIACA"] },
  { id: "certtemplate-inbound_object_control", label: "Inbound Object Control", category: "CertTemplate", kinds: ["CertTemplate"] },
  { id: "certtemplate-published_to_cas", label: "Published To CAs", category: "CertTemplate", kinds: ["CertTemplate"] },
  { id: "computer-sessions", label: "Sessions", category: "Computer", kinds: ["Computer"] },
  { id: "computer-local_admins", label: "Local Admins", category: "Computer", kinds: ["Computer"] },
  { id: "computer-rdp_users", label: "RDP Users", category: "Computer", kinds: ["Computer"] },
  { id: "computer-psremote_users", label: "PSRemote Users", category: "Computer", kinds: ["Computer"] },
  { id: "computer-dcom_users", label: "DCOM Users", category: "Computer", kinds: ["Computer"] },
  { id: "computer-sql_admin_users", label: "SQL Admin Users", category: "Computer", kinds: ["Computer"] },
  { id: "computer-constrained_delegation_users", label: "Constrained Delegation Users", category: "Computer", kinds: ["Computer"] },
  { id: "computer-member_of", label: "Member Of", category: "Computer", kinds: ["Computer"] },
  { id: "computer-local_admin_privileges", label: "Local Admin Privileges", category: "Computer", kinds: ["Computer"] },
  { id: "computer-rdp_privileges", label: "RDP Privileges", category: "Computer", kinds: ["Computer"] },
  { id: "computer-psremote_rights", label: "PSRemote Rights", category: "Computer", kinds: ["Computer"] },
  { id: "computer-dcom_privileges", label: "DCOM Privileges", category: "Computer", kinds: ["Computer"] },
  { id: "computer-inbound_object_control", label: "Inbound Object Control", category: "Computer", kinds: ["Computer"] },
  { id: "computer-outbound_object_control", label: "Outbound Object Control", category: "Computer", kinds: ["Computer"] },
  { id: "domain-foreign_users", label: "Foreign Users", category: "Domain", kinds: ["Domain"] },
  { id: "domain-foreign_groups", label: "Foreign Groups", category: "Domain", kinds: ["Domain"] },
  { id: "domain-foreign_admins", label: "Foreign Admins", category: "Domain", kinds: ["Domain"] },
  { id: "domain-foreign_gpo_controllers", label: "Foreign GPO Controllers", category: "Domain", kinds: ["Domain"] },
  { id: "domain-inbound_trusts", label: "Inbound Trusts", category: "Domain", kinds: ["Domain"] },
  { id: "domain-outbound_trusts", label: "Outbound Trusts", category: "Domain", kinds: ["Domain"] },
  { id: "domain-controllers", label: "Controllers", category: "Domain", kinds: ["Domain"] },
  { id: "domain-adcs_escalations", label: "ADCS Escalations", category: "Domain", kinds: ["Domain"] },
  { id: "enterpriseca-inbound_object_control", label: "Inbound Object Control", category: "EnterpriseCA", kinds: ["EnterpriseCA"] },
  { id: "enterpriseca-pki_hierarchy", label: "PKI Hierarchy", category: "EnterpriseCA", kinds: ["EnterpriseCA"] },
  { id: "enterpriseca-published_templates", label: "Published Templates", category: "EnterpriseCA", kinds: ["EnterpriseCA"] },
  { id: "gpo-ous", label: "OUs", category: "GPO", kinds: ["GPO"] },
  { id: "gpo-computers", label: "Computers", category: "GPO", kinds: ["GPO"] },
  { id: "gpo-users", label: "Users", category: "GPO", kinds: ["GPO"] },
  { id: "gpo-sites", label: "Sites", category: "GPO", kinds: ["GPO"] },
  { id: "gpo-tier_zero_objects", label: "Tier Zero Objects", category: "GPO", kinds: ["GPO"] },
  { id: "gpo-inbound_object_control", label: "Inbound Object Control", category: "GPO", kinds: ["GPO"] },
  { id: "group-sessions", label: "Sessions", category: "Group", kinds: ["Group"] },
  { id: "group-members", label: "Members", category: "Group", kinds: ["Group"] },
  { id: "group-member_of", label: "Member Of", category: "Group", kinds: ["Group"] },
  { id: "group-local_admin_privileges", label: "Local Admin Privileges", category: "Group", kinds: ["Group"] },
  { id: "group-rdp_privileges", label: "RDP Privileges", category: "Group", kinds: ["Group"] },
  { id: "group-dcom_privileges", label: "DCOM Privileges", category: "Group", kinds: ["Group"] },
  { id: "group-psremote_rights", label: "PSRemote Rights", category: "Group", kinds: ["Group"] },
  { id: "group-inbound_object_control", label: "Inbound Object Control", category: "Group", kinds: ["Group"] },
  { id: "group-outbound_object_control", label: "Outbound Object Control", category: "Group", kinds: ["Group"] },
  { id: "ntauthstore-inbound_object_control", label: "Inbound Object Control", category: "NTAuthStore", kinds: ["NTAuthStore"] },
  { id: "ntauthstore-trusted_cas", label: "Trusted CAs", category: "NTAuthStore", kinds: ["NTAuthStore"] },
  { id: "ou-affecting_gpos", label: "Affecting GPOs", category: "OU", kinds: ["OU"] },
  { id: "ou-groups", label: "Groups", category: "OU", kinds: ["OU"] },
  { id: "ou-computers", label: "Computers", category: "OU", kinds: ["OU"] },
  { id: "ou-users", label: "Users", category: "OU", kinds: ["OU"] },
  { id: "rootca-inbound_object_control", label: "Inbound Object Control", category: "RootCA", kinds: ["RootCA"] },
  { id: "rootca-pki_hierarchy", label: "PKI Hierarchy", category: "RootCA", kinds: ["RootCA"] },
  { id: "issuancepolicy-inbound_object_control", label: "Inbound Object Control", category: "IssuancePolicy", kinds: ["IssuancePolicy"] },
  { id: "issuancepolicy-linked_certificate_templates", label: "Linked Certificate Templates", category: "IssuancePolicy", kinds: ["IssuancePolicy"] },
  { id: "site-inbound_object_control", label: "Inbound Object Control", category: "Site", kinds: ["Site"] },
  { id: "site-linked_gpos", label: "Linked GPOs", category: "Site", kinds: ["Site"] },
  { id: "site-linked_siteservers", label: "Linked Site Servers", category: "Site", kinds: ["Site"] },
  { id: "site-linked_sitesubnets", label: "Linked Site Subnets", category: "Site", kinds: ["Site"] },
  { id: "user-sessions", label: "Sessions", category: "User", kinds: ["User"] },
  { id: "user-member_of", label: "Member Of", category: "User", kinds: ["User"] },
  { id: "user-local_admin_privileges", label: "Local Admin Privileges", category: "User", kinds: ["User"] },
  { id: "user-rdp_privileges", label: "RDP Privileges", category: "User", kinds: ["User"] },
  { id: "user-psremote_privileges", label: "PSRemote Privileges", category: "User", kinds: ["User"] },
  { id: "user-dcom_privileges", label: "DCOM Privileges", category: "User", kinds: ["User"] },
  { id: "user-sql_admin_rights", label: "SQL Admin Rights", category: "User", kinds: ["User"] },
  { id: "user-constrained_delegation_privileges", label: "Constrained Delegation Privileges", category: "User", kinds: ["User"] },
  { id: "user-outbound_object_control", label: "Outbound Object Control", category: "User", kinds: ["User"] },
  { id: "user-inbound_object_control", label: "Inbound Object Control", category: "User", kinds: ["User"] },
];

/** Specific node sections replace Base; unknown/local kinds retain generic control actions. */
export function getBeagleDrilldowns(labels: readonly string[]): BeagleDrilldown[] {
  const specific = BEAGLE_DRILLDOWNS.filter((view) => view.kinds.some((kind) => kind !== "Base" && labels.includes(kind)));
  return [BEAGLE_DRILLDOWNS[0]!, ...(specific.length ? specific : BEAGLE_DRILLDOWNS.filter((view) => view.kinds.includes("Base")))];
}

export interface BeaglePathEdgeCategory {
  id: string;
  label: string;
  kinds: readonly string[];
}

/** Exact 62-kind PathfindingRelationshipsMatchFrontend set in the pinned CE schema. */
export const BEAGLE_PATH_EDGE_CATEGORIES: readonly BeaglePathEdgeCategory[] = [
  { id: "object-control", label: "Object control", kinds: ["Owns", "GenericAll", "GenericWrite", "WriteOwner", "WriteDacl", "ForceChangePassword", "AllExtendedRights", "AddMember", "AddSelf", "AddAllowedToAct", "WriteSPN", "AddKeyCredentialLink", "WriteAccountRestrictions", "WriteGPLink", "WriteOwnerLimitedRights", "OwnsLimitedRights", "WriteAltSecurityIdentities", "WritePublicInformation", "ProtectAdminGroups"] },
  { id: "execution", label: "Execution and sessions", kinds: ["HasSession", "AdminTo", "CanPSRemote", "CanRDP", "ExecuteDCOM", "SQLAdmin", "ServerIs"] },
  { id: "membership", label: "Membership and identity", kinds: ["MemberOf", "HasSIDHistory", "ClaimSpecialIdentity", "SyncedToADUser"] },
  { id: "delegation", label: "Delegation and relay", kinds: ["AllowedToDelegate", "CoerceToTGT", "AllowedToAct", "CoerceAndRelayNTLMToSMB", "CoerceAndRelayNTLMToADCS", "CoerceAndRelayNTLMToLDAP", "CoerceAndRelayNTLMToLDAPS"] },
  { id: "credentials", label: "Credential access", kinds: ["DCSync", "ReadLAPSPassword", "ReadGMSAPassword", "DumpSMSAPassword", "SyncLAPSPassword"] },
  { id: "adcs", label: "AD CS", kinds: ["GoldenCert", "ADCSESC1", "ADCSESC3", "ADCSESC4", "ADCSESC6a", "ADCSESC6b", "ADCSESC9a", "ADCSESC9b", "ADCSESC10a", "ADCSESC10b", "ADCSESC13", "ManageCA", "ManageCertificates"] },
  { id: "directory", label: "Directory and trusts", kinds: ["GPLink", "Contains", "DCFor", "SameForestTrust", "SpoofSIDHistory", "AbuseTGTDelegation", "HasTrustKeys"] },
];

export const BEAGLE_PATH_EDGE_KINDS: readonly string[] = BEAGLE_PATH_EDGE_CATEGORIES.flatMap((category) => category.kinds);
