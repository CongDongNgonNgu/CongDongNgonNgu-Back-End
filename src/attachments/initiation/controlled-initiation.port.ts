import type { PoolClient } from "pg";
export type InitiationMode = "CREATE_ALLOWED" | "REPLAY_ONLY";
export interface InitiationAttemptPlan {
  readonly policyKey: string;
  readonly policyAttemptKey: string;
  readonly creatorAttemptKey: string;
  readonly mode: InitiationMode;
}
declare const contextBrand: unique symbol;
/** Process-local opaque correlation only; never accepted from an HTTP body. */
export interface ControlledInitiationContext {
  readonly [contextBrand]: true;
}
export interface ControlledInitiationAccess {
  readonly attachmentId: string;
  readonly mode: InitiationMode;
  takeAttachment(): string;
  fresh(): Promise<void>;
}
/** Trusted service recipe only. Native session refresh runs outside ledger locks;
 * product rate/select callbacks use only the supplied gated client, with no provider I/O. */
export interface ControlledInitiationProjection<R> {
  refresh(): Promise<void>;
  rate(client: PoolClient, attachmentId: string): Promise<void>;
  select(client: PoolClient, attachmentId: string): Promise<R>;
}
/** Trusted repository callbacks only; domain helpers expire with the callback.
 * Four-argument continuation is source/domain proof compatibility only. Controlled
 * service calls require the projection recipe and return only its final result. */
export interface ControlledInitiationPort {
  continueInitiation<T, R>(
    context: ControlledInitiationContext,
    facts: { actorId: string; fingerprint: string },
    rate: (client: PoolClient, mode: InitiationMode) => Promise<void>,
    domain: (
      client: PoolClient,
      access: ControlledInitiationAccess,
    ) => Promise<T>,
    projection: ControlledInitiationProjection<R>,
  ): Promise<R>;
  continueInitiation<T>(
    context: ControlledInitiationContext,
    facts: { actorId: string; fingerprint: string },
    rate: (client: PoolClient, mode: InitiationMode) => Promise<void>,
    domain: (
      client: PoolClient,
      access: ControlledInitiationAccess,
    ) => Promise<T>,
  ): Promise<T>;
}
