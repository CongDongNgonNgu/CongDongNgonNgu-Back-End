import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type { AttachmentReadConstraint } from "../access/attachment-access";
export const ATTACHMENT_REQUEST_POLICY = "ATTACHMENT_REQUEST_POLICY";
export type AttachmentPolicyAction =
  | { kind: "METADATA"; attachmentId: string }
  | {
      kind: "READ";
      attachmentId: string;
      method: "GET" | "HEAD";
      variant: "normalized" | "thumbnail";
      range: string | undefined;
    };
/** Optional trusted diagnostic composition only. Native guards/session and current
 * product ACL remain authoritative. No client operation key or access ticket. */
export interface AttachmentRequestPolicy {
  bind(
    request: AuthenticatedRequest,
    action: AttachmentPolicyAction,
  ): Promise<{ constraint?: AttachmentReadConstraint }>;
}
