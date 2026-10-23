export interface BeagleLocalGroupAmbiguity {
  computer: string;
  suffix: "-544" | "-580" | "-562" | "-555";
  relationshipKind: "AdminTo" | "CanPSRemote" | "ExecuteDCOM" | "CanRDP";
  selectedGroup: string;
  candidateGroups: { objectid: string; directMembers: string[] }[];
}

/** The latest recorded native analysis, not a compatibility certification. */
export interface BeagleAnalysisDiagnostics {
  version: 1;
  localGroupAmbiguities: BeagleLocalGroupAmbiguity[];
  /** Nonempty when the report could not be read completely or validated. */
  errors: string[];
}
