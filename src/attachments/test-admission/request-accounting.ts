import type { Request, Response, RequestHandler } from "express";
import type {
  RunLedger,
  ControlledActiveRun,
  RequestReservation,
} from "./run-ledger";
import type { CoarseRequestPlan } from "./coarse-request-plan";
const base = "/api/v1/attachments";
const signature = (method: string, path: string, auth: string) =>
  JSON.stringify([method, path, auth]);
/** Detection may normalize aliases only to DENY them. Candidate selection never
 * decodes, resolves, folds case or removes trailing slashes from request paths. */
function attachmentNamespace(path: string): boolean {
  let detected = path;
  for (let i = 0; i < 2; i++) {
    detected = detected.replace(/%([a-f0-9]{2})/gi, (_match, byte: string) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    );
  }
  detected = detected.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const literal = detected.toLowerCase();
  if (literal === base || literal.startsWith(base + "/")) return true;
  if (/^https?:/i.test(detected)) {
    try {
      detected = new URL(detected).pathname;
    } catch {
      /* Literal check below still denies namespace prefixes. */
    }
  } else {
    try {
      detected = new URL(detected, "http://accounting.invalid").pathname;
    } catch {
      /* No request-target normalization for selection. */
    }
  }
  detected = detected.toLowerCase();
  return detected === base || detected.startsWith(base + "/");
}
const closed = (req: Request, res: Response) =>
  req.aborted || res.destroyed || res.writableEnded;
function unavailable(req: Request, res: Response): void {
  if (closed(req, res)) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(503).json({
    success: false,
    error: {
      code: "ATTACHMENTS_UNAVAILABLE",
      message: "Attachments are temporarily unavailable",
    },
  });
}
/** Explicit injected pre-parser accounting only. No authentication, matching,
 * operation/identity allocation, body reading or runtime/bootstrap activation.
 * Successful reservation is durable even when parsing/auth/cancellation fails.
 * Original process-local handles stay private and may be taken only once. */
export class RequestAccounting {
  private readonly routes = new Map<string, string>();
  private readonly handles = new WeakMap<Request, RequestReservation>();
  private readonly responses = new WeakMap<Request, Response>();
  private readonly started = new WeakSet<Request>();
  constructor(
    private readonly ledger: Pick<
      RunLedger,
      "requireControlled" | "reserveRequest"
    >,
    private readonly active: ControlledActiveRun,
    plan: CoarseRequestPlan,
  ) {
    for (const c of plan.requests.candidates) {
      const key = signature(c.method, c.path, c.authClass);
      if (this.routes.has(key)) throw Error("TEST_ADMISSION_ACCOUNTING");
      this.routes.set(key, c.key);
    }
  }
  readonly middleware: RequestHandler = async (req, res, next) => {
    try {
      const target = req.originalUrl || req.url,
        path = target.split("?", 1)[0];
      if (!attachmentNamespace(path)) {
        next();
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.vary("Authorization");
      res.vary("Cookie");
      const optional =
        ["GET", "HEAD"].includes(req.method) &&
        /(?:\/content|\/preview)$/.test(path);
      let auth: "AUTH" | "ANON" = "AUTH";
      if (optional) {
        let supplied = Object.prototype.hasOwnProperty.call(
          req.headers,
          "authorization",
        );
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i].trim().toLowerCase() === "authorization")
            supplied = true;
        auth = supplied ? "AUTH" : "ANON";
      }
      const candidate = this.routes.get(signature(req.method, path, auth));
      if (!candidate || this.started.has(req)) {
        unavailable(req, res);
        return;
      }
      this.started.add(req);
      const controlled = this.ledger.requireControlled(this.active);
      const handle = await this.ledger.reserveRequest(controlled, candidate);
      if (closed(req, res)) return;
      this.handles.set(req, handle);
      this.responses.set(req, res);
      next();
    } catch {
      this.handles.delete(req);
      this.responses.delete(req);
      try {
        unavailable(req, res);
      } catch {
        res.destroy();
      }
    }
  };
  take(req: Request): RequestReservation | undefined {
    const handle = this.handles.get(req),
      response = this.responses.get(req);
    this.handles.delete(req);
    this.responses.delete(req);
    return !response || closed(req, response) ? undefined : handle;
  }
}
