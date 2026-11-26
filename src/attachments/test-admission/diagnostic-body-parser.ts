import {
  json,
  urlencoded,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import type { RequestAccounting } from "./request-accounting";
import { DIAGNOSTIC_JSON_INGRESS_CAP } from "./diagnostic-ingress-policy";
const base = "/api/v1/attachments";
function namespace(path: string): boolean {
  let detected = path;
  for (let i = 0; i < 2; i++)
    detected = detected.replace(/%([a-f0-9]{2})/gi, (_, b: string) =>
      String.fromCharCode(parseInt(b, 16)),
    );
  detected = detected
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (detected === base || detected.startsWith(base + "/")) return true;
  try {
    detected = new URL(
      detected,
      "http://diagnostic.invalid",
    ).pathname.toLowerCase();
  } catch {
    /* Denial-only detection; never select a normalized path. */
  }
  return detected === base || detected.startsWith(base + "/");
}
function reject(
  req: Request,
  res: Response,
  status: number,
  cancelInput = false,
): void {
  if (req.aborted || res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
  res.vary("Cookie");
  res.setHeader("Connection", "close");
  res.once("finish", () => {
    if (cancelInput) req.socket.end(() => req.destroy());
    else req.socket.end();
  });
  res.status(status).json({
    success: false,
    error: {
      code: status === 503 ? "ATTACHMENTS_UNAVAILABLE" : "INVALID_REQUEST",
      message:
        status === 503
          ? "Attachments are temporarily unavailable"
          : "Invalid request body",
    },
  });
}
/** Explicit diagnostic composition only: Nest bodyParser:false, committed request
 * accounting first, this parser second. Never install alongside an earlier body
 * parser. Finite declared application input is bounded; this is not a wire-byte,
 * authentication, provider-write or runtime-activation grant. */
export function createDiagnosticBodyParser(
  accounting: Pick<RequestAccounting, "peekCandidate" | "peekBodyRemaining">,
): RequestHandler {
  const normalJson = json(),
    normalForm = urlencoded({ extended: true });
  const diagnosticJson = json({
    limit: DIAGNOSTIC_JSON_INGRESS_CAP,
    inflate: false,
    type: () => true,
  });
  return (req, res, next) => {
    const path = (req.originalUrl || req.url).split("?", 1)[0];
    if (!namespace(path)) {
      normalJson(req, res, (error) => {
        if (error) next(error);
        else normalForm(req, res, next);
      });
      return;
    }
    let candidate;
    try {
      candidate = accounting.peekCandidate(req);
    } catch {
      reject(req, res, 503);
      return;
    }
    if (
      !candidate ||
      candidate.method !== req.method ||
      candidate.path !== path
    ) {
      reject(req, res, 503);
      return;
    }
    const names = [
      "content-length",
      "transfer-encoding",
      "content-encoding",
      "content-type",
    ];
    const counts = new Map<string, number>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const n = req.rawHeaders[i].toLowerCase();
      if (names.includes(n)) counts.set(n, (counts.get(n) || 0) + 1);
    }
    if (
      [...counts.values()].some((n) => n > 1) ||
      req.headers["transfer-encoding"] !== undefined
    ) {
      reject(req, res, 400);
      return;
    }
    const encoding = req.headers["content-encoding"];
    if (
      encoding !== undefined &&
      (typeof encoding !== "string" ||
        encoding.trim().toLowerCase() !== "identity")
    ) {
      reject(req, res, 415);
      return;
    }
    const raw = req.headers["content-length"];
    const length =
      typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)
        ? Number(raw)
        : NaN;
    const isJson =
      (req.method === "POST" && path === base) ||
      (req.method === "PATCH" &&
        /^\/api\/v1\/attachments\/[^/]+\/metadata$/.test(path));
    const isRaw =
      req.method === "PUT" &&
      /^\/api\/v1\/attachments\/[^/]+\/content$/.test(path);
    if (!isJson && !isRaw) {
      if (
        raw !== undefined &&
        (!Number.isSafeInteger(length) || length !== 0)
      ) {
        reject(req, res, 400);
        return;
      }
      next();
      return;
    }
    if (!Number.isSafeInteger(length) || length < 1) {
      reject(req, res, 400);
      return;
    }
    if (
      length > candidate.ingressBytes ||
      (isJson && length > DIAGNOSTIC_JSON_INGRESS_CAP)
    ) {
      reject(req, res, 413);
      return;
    }

    const contentType = req.headers["content-type"];
    if (
      !isRaw &&
      (typeof contentType !== "string" ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
          contentType,
        ))
    ) {
      reject(req, res, 415);
      return;
    }
    const started = performance.now();
    let remaining: number | undefined;
    try {
      remaining = accounting.peekBodyRemaining(req);
    } catch {
      reject(req, res, 503);
      return;
    }
    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 600000
    ) {
      reject(req, res, 503);
      return;
    }
    if (remaining === 0) {
      reject(req, res, 408, true);
      return;
    }
    const deadline = started + Math.min(30000, remaining);
    if (performance.now() >= deadline) {
      reject(req, res, 408, true);
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const event of ["end", "error", "aborted", "close"])
        req.removeListener(event, cleanup);
      for (const event of ["finish", "close"])
        res.removeListener(event, cleanup);
    };
    const timeout = () => {
      if (settled) return;
      cleanup();
      reject(req, res, 408, true);
    };
    const timer = setTimeout(
      timeout,
      Math.max(0, deadline - performance.now()),
    );
    for (const event of isRaw
      ? ["end", "error", "aborted", "close"]
      : ["aborted", "close"])
      req.once(event, cleanup);
    for (const event of ["finish", "close"]) res.once(event, cleanup);
    if (isRaw) {
      next();
      return;
    }
    diagnosticJson(req, res, (error) => {
      if (settled) return;
      if (performance.now() >= deadline) {
        timeout();
        return;
      }
      cleanup();
      if (error) {
        const status = (error as { status?: number }).status;
        reject(req, res, status === 413 ? 413 : status === 415 ? 415 : 400);
        return;
      }
      next();
    });
  };
}
