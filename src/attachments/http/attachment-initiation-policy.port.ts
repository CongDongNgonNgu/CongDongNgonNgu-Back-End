import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type { ControlledInitiationContext } from "../initiation/controlled-initiation.port";
export const ATTACHMENT_INITIATION_POLICY = "ATTACHMENT_INITIATION_POLICY";
/** Optional trusted diagnostic composition after native guard/query/CSRF only. */
export interface AttachmentInitiationPolicy {
  bind(
    request: AuthenticatedRequest,
    input: unknown,
    response: Response,
  ): Promise<ControlledInitiationContext>;
}
