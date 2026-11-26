import type { Request, Response, NextFunction } from "express";
import type { ControlledActiveRun, RequestReservation } from "./run-ledger";
import { RequestAccounting } from "./request-accounting";
import type { CoarseRequestPlan } from "./coarse-request-plan";
jest.mock("pg", () => {
  throw Error("accounting imports no runtime database");
});
const id = "11111111-1111-4111-8111-111111111111",
  base = "/api/v1/attachments",
  path = base + "/" + id + "/content";
function fixture() {
  const active = {} as ControlledActiveRun,
    handle = Object.freeze({
      runId: id,
      candidateKey: "read-anon",
      attemptKey: "coarse-r000",
    }) as RequestReservation;
  const ledger = {
    requireRequestCandidate: jest.fn(() =>
      Object.freeze({
        key: "read-anon",
        method: "GET" as const,
        path,
        authClass: "ANON" as const,
        ingressBytes: 0,
        egressBytes: 100,
      }),
    ),
    requireRequestBodyRemaining: jest.fn(() => 1000),
    requireControlled: jest.fn(() => active),
    reserveRequest: jest.fn(async () => handle),
  };
  const plan: CoarseRequestPlan = {
    requests: {
      candidates: [
        {
          key: "read-anon",
          method: "GET",
          path,
          authClass: "ANON",
          ingressBytes: 0,
          egressBytes: 100,
        },
        {
          key: "read-auth",
          method: "GET",
          path,
          authClass: "AUTH",
          ingressBytes: 0,
          egressBytes: 100,
        },
        {
          key: "init",
          method: "POST",
          path: base,
          authClass: "AUTH",
          ingressBytes: 0,
          egressBytes: 0,
        },
      ],
      attempts: [],
    },
    candidates: [],
  };
  const accounting = new RequestAccounting(ledger, active, plan);
  return { active, handle, ledger, plan, accounting };
}
function request(url = path, method = "GET", rawHeaders: string[] = []) {
  return {
    originalUrl: url,
    url,
    method,
    rawHeaders,
    headers: {},
    aborted: false,
  } as unknown as Request;
}
function response() {
  const headers = new Map<string, string>([["Vary", "Origin"]]);
  const res = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    setHeader: jest.fn((k: string, v: string) => {
      headers.set(k, v);
    }),
    vary: jest.fn((v: string) => {
      headers.set("Vary", headers.get("Vary") + ", " + v);
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
  return { res: res as unknown as Response, headers, raw: res };
}
const dispatch = async (
  f: ReturnType<typeof fixture>,
  req: Request,
  res: Response,
  next = jest.fn(),
) => {
  await f.accounting.middleware(req, res, next as NextFunction);
  return next;
};
describe("explicit controlled pre-parser accounting only", () => {
  it("peeks only committed ledger facts without consuming the private handle", async () => {
    const f = fixture(),
      req = request(),
      r = response();
    const facts = Object.freeze({
      key: "read-anon",
      method: "GET" as const,
      path,
      authClass: "ANON" as const,
      ingressBytes: 0,
      egressBytes: 250,
    });
    Object.assign(f.ledger, { requireRequestCandidate: jest.fn(() => facts) });
    expect(f.accounting.peekCandidate(req)).toBeUndefined();
    await dispatch(f, req, r.res);
    f.plan.requests.candidates[0].egressBytes = 999;
    expect(f.accounting.peekCandidate(req)).toBe(facts);
    expect(f.accounting.peekCandidate(req)).toBe(facts);
    expect(f.accounting.take(req)).toBe(f.handle);
    expect(f.accounting.peekCandidate(req)).toBeUndefined();
  });
  it("never peeks candidate facts after response closure", async () => {
    const f = fixture(),
      req = request(),
      r = response();
    await dispatch(f, req, r.res);
    r.raw.writableEnded = true;
    expect(f.accounting.peekCandidate(req)).toBeUndefined();
  });

  it("does not issue a stored handle after the response has closed", async () => {
    const f = fixture(),
      req = request(),
      r = response();
    await dispatch(f, req, r.res);
    r.raw.writableEnded = true;
    expect(f.accounting.take(req)).toBeUndefined();
    expect(f.accounting.take(req)).toBeUndefined();
  });

  it("reserves before next and exposes the original handle exactly once", async () => {
    const f = fixture(),
      req = request(),
      r = response(),
      next = jest.fn(() => {
        expect(f.ledger.reserveRequest).toHaveBeenCalled();
      });
    expect(f.ledger.requireControlled).not.toHaveBeenCalled();
    await dispatch(f, req, r.res, next);
    expect(f.ledger.requireControlled).toHaveBeenCalledWith(f.active);
    expect(f.ledger.reserveRequest).toHaveBeenCalledWith(f.active, "read-anon");
    expect(next).toHaveBeenCalledTimes(1);
    expect(f.accounting.take(req)).toBe(f.handle);
    expect(f.accounting.take(req)).toBeUndefined();
    expect(f.accounting.take(request())).toBeUndefined();
  });
  it("does not call next before confirmed reservation", async () => {
    const f = fixture(),
      req = request(),
      r = response(),
      next = jest.fn();
    let done!: (h: RequestReservation) => void;
    f.ledger.reserveRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const work = dispatch(f, req, r.res, next);
    expect(next).not.toHaveBeenCalled();
    done(f.handle);
    await work;
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("strips only query for coarse selection and never inspects body, actor, range, content type or length", async () => {
    const f = fixture(),
      req = request(path + "?unexpected=1"),
      r = response();
    Object.defineProperty(req, "body", {
      get() {
        throw Error("body inspected");
      },
    });
    Object.defineProperty(req, "user", {
      get() {
        throw Error("actor inspected");
      },
    });
    Object.defineProperty(req.headers, "range", {
      get() {
        throw Error("range inspected");
      },
    });
    Object.defineProperty(req.headers, "content-type", {
      get() {
        throw Error("type inspected");
      },
    });
    Object.defineProperty(req.headers, "content-length", {
      get() {
        throw Error("length inspected");
      },
    });
    expect(await dispatch(f, req, r.res)).toHaveBeenCalledTimes(1);
    expect(f.ledger.reserveRequest).toHaveBeenCalledWith(f.active, "read-anon");
  });
  it.each([
    ["Authorization", ""],
    ["authorization", "invalid"],
    ["AUTHORIZATION", "Bearer one", "Authorization", "Bearer two"],
  ])(
    "charges supplied/malformed/duplicate authorization as AUTH using raw header presence",
    async (...raw) => {
      const f = fixture(),
        r = response();
      await dispatch(f, request(path, "GET", raw), r.res);
      expect(f.ledger.reserveRequest).toHaveBeenCalledWith(
        f.active,
        "read-auth",
      );
    },
  );
  it("charges protected paths as AUTH even with no credentials", async () => {
    const f = fixture(),
      r = response();
    await dispatch(f, request(base, "POST"), r.res);
    expect(f.ledger.reserveRequest).toHaveBeenCalledWith(f.active, "init");
  });
  it("snapshots constructor routing data so later plan mutation cannot alter admission", async () => {
    const f = fixture();
    f.plan.requests.candidates[0].key = "mutated";
    f.plan.requests.candidates[0].path = "/other";
    await dispatch(f, request(), response().res);
    expect(f.ledger.reserveRequest).toHaveBeenCalledWith(f.active, "read-anon");
  });
  it.each([
    base + "/missing",
    path + "/",
    path.replace("attachments", "att%61chments"),
    path.replace("/api/", "/API/"),
    path.replace("/v1/", "//v1/"),
    path.replace("attachments", "att%61chments") + "/%zz",
    base + "/../content",
  ])(
    "rejects unknown or aliased attachment route %s before native processing",
    async (url) => {
      const f = fixture(),
        r = response(),
        next = await dispatch(f, request(url), r.res);
      expect(next).not.toHaveBeenCalled();
      expect(r.raw.status).toHaveBeenCalledWith(503);
      expect(f.ledger.reserveRequest).not.toHaveBeenCalled();
      expect(r.headers.get("Vary")).toContain("Origin");
      expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    },
  );
  it("leaves unrelated routes untouched without ledger work", async () => {
    const f = fixture(),
      r = response(),
      next = await dispatch(f, request("/api/v1/community"), r.res);
    expect(next).toHaveBeenCalledTimes(1);
    expect(f.ledger.requireControlled).not.toHaveBeenCalled();
    expect(f.ledger.reserveRequest).not.toHaveBeenCalled();
  });
  it("sanitizes controlled/expiry/exhaustion failures without issuing a handle or retrying", async () => {
    for (const phase of ["require", "reserve"]) {
      const f = fixture(),
        req = request(),
        r = response();
      if (phase === "require")
        f.ledger.requireControlled.mockImplementation(() => {
          throw Error("private");
        });
      else f.ledger.reserveRequest.mockRejectedValue(Error("private"));
      const next = await dispatch(f, req, r.res);
      expect(next).not.toHaveBeenCalled();
      expect(r.raw.status).toHaveBeenCalledWith(503);
      expect(JSON.stringify(r.raw.json.mock.calls)).not.toContain("private");
      expect(f.accounting.take(req)).toBeUndefined();
      expect(f.ledger.reserveRequest.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });
  it("retains consumed reservations on cancellation but never advances after commit", async () => {
    const f = fixture(),
      req = request(),
      r = response();
    f.ledger.reserveRequest.mockImplementation(async () => {
      req.aborted = true;
      return f.handle;
    });
    const next = await dispatch(f, req, r.res);
    expect(f.ledger.reserveRequest).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(f.accounting.take(req)).toBeUndefined();
    expect(r.raw.json).not.toHaveBeenCalled();
  });
  it("does not confuse a normally ended request stream with client cancellation", async () => {
    const f = fixture(),
      req = request(),
      r = response();
    Object.defineProperty(req, "destroyed", { value: true });
    const next = await dispatch(f, req, r.res);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

it("reads remaining body time only through the original private untaken receipt", async () => {
  const f = fixture(),
    req = request(),
    r = response();
  expect(f.accounting.peekBodyRemaining(req)).toBeUndefined();
  await dispatch(f, req, r.res);
  expect(f.accounting.peekBodyRemaining(req)).toBe(1000);
  expect(f.ledger.requireRequestBodyRemaining).toHaveBeenCalledWith(f.handle);
  f.accounting.take(req);
  expect(f.accounting.peekBodyRemaining(req)).toBeUndefined();
});
