import type { PoolClient } from "pg";
declare const contextBrand: unique symbol;
/** Process-local opaque correlation only; never accepted from an HTTP body. */
export interface ControlledInitiationContext {
  readonly [contextBrand]: true;
}
export interface ControlledInitiationAccess {
  readonly attachmentId: string;
  takeAttachment(): string;
  fresh(): Promise<void>;
}
/** Trusted repository callbacks only. No external I/O; domain helpers expire with the callback. */
export interface ControlledInitiationPort {
  continueInitiation<T>(
    context: ControlledInitiationContext,
    facts: { actorId: string; fingerprint: string },
    rate: (client: PoolClient) => Promise<void>,
    domain: (
      client: PoolClient,
      access: ControlledInitiationAccess,
    ) => Promise<T>,
  ): Promise<T>;
}
