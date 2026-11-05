// Compile-time contract checks run by npm run typecheck; no runtime fixtures are needed.
import { expectTypeOf } from "vitest";
import type {
  DestructiveTargetActionId,
  PrepareTargetActionInput,
  TargetActionExecutionResult,
  TargetActionOutcome,
} from "./target-contracts.js";
import type {
  SessionDestructiveActionPreparation,
  SessionWorkbenchInvocationResult,
  SessionWorkbenchOutcomeUnknownOperationId,
} from "./session-contracts.js";

expectTypeOf<PrepareTargetActionInput>().toEqualTypeOf<{ actionId: DestructiveTargetActionId }>();
expectTypeOf<PrepareTargetActionInput>().not.toHaveProperty("targetId");
expectTypeOf<TargetActionExecutionResult>().toEqualTypeOf<{
  actionId: DestructiveTargetActionId;
  outcomes: TargetActionOutcome[];
  partial: boolean;
}>();
expectTypeOf<Extract<SessionDestructiveActionPreparation, { status: "canceled" }>>()
  .toEqualTypeOf<{ status: "canceled" }>();
expectTypeOf<Extract<SessionDestructiveActionPreparation, { status: "canceled" }>>()
  .not.toHaveProperty("plan");
expectTypeOf<Extract<SessionWorkbenchInvocationResult, { status: "failed" }>>()
  .toEqualTypeOf<{
    status: "failed";
    operationId: SessionWorkbenchOutcomeUnknownOperationId;
    message: string;
  }>();
expectTypeOf<Extract<SessionWorkbenchInvocationResult, { status: "outcome-unknown" }>>()
  .toEqualTypeOf<{
    status: "outcome-unknown";
    operationId: SessionWorkbenchOutcomeUnknownOperationId;
    message: string;
  }>();
