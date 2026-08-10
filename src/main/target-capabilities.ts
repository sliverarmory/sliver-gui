import {
  TARGET_CAPABILITY_IDS,
  type TargetCapabilityId,
  type TargetCapabilityReason,
  type TargetCapabilityState,
  type TargetRef,
  type TargetServerSupport,
  type TargetSummary,
  type WindowTargetContext,
} from "../shared/target-contracts.js";

interface CapabilityRule {
  mode: "any" | "session" | "beacon";
  requiresResponsiveTarget: boolean;
  requiresKnownTransport: boolean;
  queueableWhenBeaconOffline: boolean;
  queueableWithUnknownBeaconTransport: boolean;
}

export interface WindowTargetContextInput {
  activeTarget: TargetRef | null;
  activeTargetSummary?: TargetSummary | null;
  serverSupport: TargetServerSupport;
  selectableTargets?: TargetRef[];
  beaconWatch?: boolean;
  unavailableReason?: string;
  authoritative?: boolean;
  openSessionEndpointAvailable?: boolean;
}

export interface TargetCapabilityFacts {
  openSessionEndpointAvailable?: boolean;
}

const CAPABILITY_RULES: Readonly<Record<TargetCapabilityId, CapabilityRule>> = {
  "target.ping": beaconQueueRule("any"),
  "target.rename": metadataRule("any"),
  "target.terminate": beaconQueueRule("any"),
  "target.task.execute": beaconQueueRule("any"),
  "target.environment.write": beaconQueueRule("any"),
  "session.close": responsiveRule("session"),
  "beacon.remove": metadataRule("beacon"),
  "beacon.reconfigure": beaconQueueRule("beacon"),
  "beacon.open-session": beaconQueueRule("beacon", false),
  "beacon.tasks.read": metadataRule("beacon"),
  "beacon.tasks.cancel": metadataRule("beacon"),
};

export function calculateTargetCapabilities(
  target: TargetSummary,
  serverSupport: TargetServerSupport,
  facts: TargetCapabilityFacts = {},
): TargetCapabilityState[] {
  const supported = new Set(serverSupport.supported);
  return TARGET_CAPABILITY_IDS.map((id) => {
    const reason = unavailableReason(id, CAPABILITY_RULES[id], target, supported, facts);
    return reason ? { id, available: false, reason } : { id, available: true };
  });
}

export function targetCapability(
  capabilities: readonly TargetCapabilityState[],
  id: TargetCapabilityId,
): TargetCapabilityState {
  return (
    capabilities.find((capability) => capability.id === id) ?? {
      id,
      available: false,
      reason: reason("unsupported-by-server", "The connected server does not support this action."),
    }
  );
}

export function createWindowTargetContext(input: WindowTargetContextInput): WindowTargetContext {
  if (!input.activeTarget) {
    return {
      status: "none",
      activeTarget: null,
      activeTargetSummary: null,
      selectableTargets: cloneTargetRefs(input.selectableTargets),
      capabilities: [],
      beaconWatch: false,
    };
  }

  const summary = input.activeTargetSummary;
  if (
    !summary ||
    summary.mode !== input.activeTarget.mode ||
    summary.id !== input.activeTarget.id
  ) {
    const unavailableReason = boundedReason(
      input.unavailableReason ?? "The selected target is no longer available in the current backend state.",
    );
    return {
      status: "unavailable",
      activeTarget: { ...input.activeTarget },
      activeTargetSummary: null,
      selectableTargets: cloneTargetRefs(input.selectableTargets),
      capabilities: unavailableCapabilities(),
      beaconWatch: input.activeTarget.mode === "beacon" && input.beaconWatch === true,
      unavailableReason,
    };
  }

  if (input.authoritative === false) {
    return {
      status: "unavailable",
      activeTarget: { ...input.activeTarget },
      activeTargetSummary: { ...summary },
      selectableTargets: cloneTargetRefs(input.selectableTargets),
      capabilities: unavailableCapabilities(),
      beaconWatch: summary.mode === "beacon" && input.beaconWatch === true,
      unavailableReason: boundedReason(
        input.unavailableReason ?? "The selected target inventory is refreshing; actions are temporarily disabled.",
      ),
    };
  }

  return {
    status: "selected",
    activeTarget: { ...input.activeTarget },
    activeTargetSummary: { ...summary },
    selectableTargets: cloneTargetRefs(input.selectableTargets),
    capabilities: calculateTargetCapabilities(summary, input.serverSupport, {
      openSessionEndpointAvailable: input.openSessionEndpointAvailable === true,
    }),
    beaconWatch: summary.mode === "beacon" && input.beaconWatch === true,
  };
}

function cloneTargetRefs(refs: readonly TargetRef[] | undefined): TargetRef[] {
  return (refs ?? []).map((ref) => ({ ...ref }));
}

function unavailableReason(
  id: TargetCapabilityId,
  rule: CapabilityRule,
  target: TargetSummary,
  supported: ReadonlySet<TargetCapabilityId>,
  facts: TargetCapabilityFacts,
): TargetCapabilityReason | undefined {
  if (rule.mode === "session" && target.mode !== "session") {
    return reason("requires-session", "This action is available only for session targets.");
  }
  if (rule.mode === "beacon" && target.mode !== "beacon") {
    return reason("requires-beacon", "This action is available only for beacon targets.");
  }
  if (!supported.has(id)) {
    return reason("unsupported-by-server", "The connected server does not support this action.");
  }
  if (id === "beacon.open-session" && facts.openSessionEndpointAvailable !== true) {
    return reason(
      "unsupported-transport",
      "This beacon has no supported authoritative C2 endpoint for session conversion.",
    );
  }
  if (rule.requiresResponsiveTarget) {
    const livenessReason = target.mode === "beacon" && rule.queueableWhenBeaconOffline
      ? undefined
      : targetLivenessReason(target);
    if (livenessReason) return livenessReason;
  }
  if (
    rule.requiresKnownTransport &&
    !(target.mode === "beacon" && rule.queueableWithUnknownBeaconTransport) &&
    !supportsLiveTargetActions(target)
  ) {
    return reason("unsupported-transport", "This target transport does not support the action.");
  }
  return undefined;
}

function targetLivenessReason(target: TargetSummary): TargetCapabilityReason | undefined {
  if (target.mode === "session") {
    return target.liveness === "dead"
      ? reason("target-dead", "The session is no longer active.")
      : undefined;
  }
  switch (target.checkinStatus) {
    case "on-time":
      return undefined;
    case "overdue":
      return reason("target-overdue", "The beacon is overdue and may not receive this action.");
    case "unknown":
      return reason("target-state-unknown", "The beacon check-in state is unknown.");
  }
}

function supportsLiveTargetActions(target: TargetSummary): boolean {
  if (target.transport === "unknown") return false;
  // DNS is a beacon transport. A session claiming DNS is inconsistent with the
  // server protocol and is gated instead of being treated as interactive.
  return !(target.mode === "session" && target.transport === "dns");
}

function unavailableCapabilities(): TargetCapabilityState[] {
  return TARGET_CAPABILITY_IDS.map((id) => ({
    id,
    available: false,
    reason: reason("target-state-unknown", "The selected target is unavailable."),
  }));
}

function responsiveRule(mode: CapabilityRule["mode"]): CapabilityRule {
  return {
    mode,
    requiresResponsiveTarget: true,
    requiresKnownTransport: true,
    queueableWhenBeaconOffline: false,
    queueableWithUnknownBeaconTransport: false,
  };
}

function beaconQueueRule(
  mode: CapabilityRule["mode"],
  queueableWithUnknownBeaconTransport = true,
): CapabilityRule {
  return {
    mode,
    requiresResponsiveTarget: true,
    requiresKnownTransport: true,
    queueableWhenBeaconOffline: true,
    queueableWithUnknownBeaconTransport,
  };
}

function metadataRule(mode: CapabilityRule["mode"]): CapabilityRule {
  return {
    mode,
    requiresResponsiveTarget: false,
    requiresKnownTransport: false,
    queueableWhenBeaconOffline: false,
    queueableWithUnknownBeaconTransport: false,
  };
}

function reason(
  code: TargetCapabilityReason["code"],
  message: string,
): TargetCapabilityReason {
  return { code, message };
}

function boundedReason(value: string): string {
  return [...value]
    .slice(0, 256)
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
