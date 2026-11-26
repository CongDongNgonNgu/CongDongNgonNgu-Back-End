import express, { type Request, type Response } from "express";
import request from "supertest";
import { EventEmitter } from "node:events";
import { createDiagnosticBodyParser } from "./diagnostic-body-parser";
import { DIAGNOSTIC_JSON_INGRESS_CAP as CAP } from "./diagnostic-ingress-policy";
import type { RequestCandidate } from "./run-ledger";
const base = "/api/v1/attachments",
  item = base + "/11111111-1111-4111-8111-111111111111";
function app(ingress = CAP) {
  const server = express(),
    reached = jest.fn();
  server.use(
    createDiagnosticBodyParser({
      peekCandidate: (req) =>
        Object.freeze({
          key: "coarse",
          method: req.method as RequestCandidate["method"],
          path: req.originalUrl.split("?")[0],
          authClass: "AUTH",
          ingressBytes: ingress,
          egressBytes: 0,
        }),
    }),
  );
  server.use((req, res) => {
    reached();
    res.json({
      body: req.body,
      unread: req.readableFlowing === null,
      dataListeners: req.listenerCount("data"),
    });
  });
  return { server, reached };
}
function direct(
  headers: Record<string, string>,
  method = "POST",
  path = base,
  ingress = CAP,
  rawHeaders = Object.entries(headers).flat(),
) {
  const peekCandidate = jest.fn(
      () =>
        Object.freeze({
          key: "coarse",
          method,
          path,
          authClass: "AUTH" as const,
          ingressBytes: ingress,
          egressBytes: 0,
        }) as RequestCandidate,
    ),
    destroy = jest.fn(),
    next = jest.fn();
  const req = {
    method,
    originalUrl: path,
    url: path,
    headers,
    rawHeaders,
    aborted: false,
    socket: { end: destroy },
  };
  Object.defineProperty(req, "body", {
    get() {
      throw Error("body inspected");
    },
  });
  const response = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    headersSent: boolean;
    status: jest.Mock;
    json: jest.Mock;
    setHeader: jest.Mock;
    vary: jest.Mock;
  };
  Object.assign(response, {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockImplementation(() => {
      expect(destroy).not.toHaveBeenCalled();
      response.emit("finish");
      return response;
    }),
    setHeader: jest.fn(),
    vary: jest.fn(),
  });
  return {
    peekCandidate,
    destroy,
    next,
    req: req as unknown as Request,
    res: response as unknown as Response,
    response,
    run: () =>
      createDiagnosticBodyParser({ peekCandidate })(
        req as unknown as Request,
        response as unknown as Response,
        next,
      ),
  };
}
const jsonBytes = (size: number) => '{"pad":"' + "x".repeat(size - 10) + '"}';
describe("explicit committed-fact diagnostic body parsing only", () => {
  it.each([CAP - 1, CAP])(
    "parses finite identity JSON exactly at %s bytes",
    async (size) => {
      const f = app();
      await request(f.server)
        .post(base)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(jsonBytes(size))
        .expect(200)
        .expect(({ body }) => expect(body.body.pad.length).toBe(size - 10));
      expect(f.reached).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects above-cap JSON before parser/controller and closes after the response", async () => {
    const f = app();
    await request(f.server)
      .post(base)
      .set("Content-Type", "application/json")
      .send(jsonBytes(CAP + 1))
      .expect(413)
      .expect("Connection", "close");
    expect(f.reached).not.toHaveBeenCalled();
  });
  it("uses committed ingress instead of an inferred body or mutable plan allowance", async () => {
    const f = app(0);
    await request(f.server)
      .post(base)
      .set("Content-Type", "application/json")
      .send("{}")
      .expect(413);
    expect(f.reached).not.toHaveBeenCalled();
  });
  it("preserves malformed JSON400 before later native guards", async () => {
    const f = app();
    await request(f.server)
      .post(base)
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400);
    expect(f.reached).not.toHaveBeenCalled();
  });
  it.each(["gzip", "br"])(
    "rejects unsupported %s encoding without inflating",
    async (encoding) => {
      const f = app();
      await request(f.server)
        .post(base)
        .set("Content-Type", "application/json")
        .set("Content-Encoding", encoding)
        .send("{}")
        .expect(415);
      expect(f.reached).not.toHaveBeenCalled();
    },
  );
  it("bypasses all JSON/urlencoded parsing for raw PUT even with JSON MIME", async () => {
    const f = app(100);
    await request(f.server)
      .put(item + "/content")
      .set("Content-Type", "application/json")
      .send("{raw")
      .expect(200)
      .expect(({ body }) => {
        expect(body.body).toBeUndefined();
        expect(body.unread).toBe(true);
        expect(body.dataListeners).toBe(0);
      });
  });
  it.each([
    ["transfer-encoding", "chunked", 400],
    ["content-length", "01", 400],
    ["content-length", "", 400],
    ["content-length", "9007199254740992", 400],
    ["content-type", "text/plain", 415],
    ["content-encoding", "gzip", 415],
  ])(
    "rejects unsafe %s=%s without reading application bytes",
    (_name, _value, status) => {
      const name = String(_name),
        value = String(_value),
        headers = {
          "content-length": "2",
          "content-type": "application/json",
          [name]: value,
        },
        f = direct(headers);
      f.run();
      expect(f.response.status).toHaveBeenCalledWith(status);
      expect(f.next).not.toHaveBeenCalled();
      expect(f.destroy).toHaveBeenCalledTimes(1);
      expect(f.response.setHeader).toHaveBeenCalledWith("Connection", "close");
      expect(f.peekCandidate).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects duplicate Content-Length even if normalized headers look valid", () => {
    const f = direct(
      { "content-length": "2", "content-type": "application/json" },
      "POST",
      base,
      CAP,
      [
        "Content-Length",
        "2",
        "content-length",
        "2",
        "Content-Type",
        "application/json",
      ],
    );
    f.run();
    expect(f.response.status).toHaveBeenCalledWith(400);
    expect(f.next).not.toHaveBeenCalled();
  });
  it.each(["GET", "HEAD", "DELETE"])(
    "rejects nonempty body framing on bodyless %s",
    (method) => {
      const f = direct({ "content-length": "1" }, method, item, 0);
      f.run();
      expect(f.response.status).toHaveBeenCalledWith(400);
      expect(f.next).not.toHaveBeenCalled();
    },
  );
  it("accepts an explicitly empty bodyless request and ignores Range for candidate selection", () => {
    const f = direct(
      { "content-length": "0", range: "bytes=0-0" },
      "HEAD",
      item + "/content",
      0,
    );
    f.run();
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.response.status).not.toHaveBeenCalled();
  });
  it("rejects absent, foreign or failed private candidate provenance", () => {
    for (const kind of ["missing", "foreign", "error"]) {
      const f = direct({
        "content-length": "2",
        "content-type": "application/json",
      });
      if (kind === "missing")
        f.peekCandidate.mockReturnValue(undefined as never);
      if (kind === "foreign")
        f.peekCandidate.mockReturnValue({
          ...f.peekCandidate(),
          path: item,
        } as RequestCandidate);
      if (kind === "error")
        f.peekCandidate.mockImplementation(() => {
          throw Error("private");
        });
      f.run();
      expect(f.response.status).toHaveBeenCalledWith(503);
      expect(f.next).not.toHaveBeenCalled();
      expect(JSON.stringify(f.response.json.mock.calls)).not.toContain(
        "private",
      );
    }
  });
  it("preserves unrelated normal JSON and extended urlencoded parsing", async () => {
    for (const type of [
      "application/json",
      "application/x-www-form-urlencoded",
    ]) {
      const f = app();
      await request(f.server)
        .post("/api/v1/community")
        .set("Content-Type", type)
        .send(type === "application/json" ? '{"a":{"b":"1"}}' : "a[b]=1")
        .expect(200)
        .expect(({ body }) => expect(body.body).toEqual({ a: { b: "1" } }));
    }
  });
});

it("parses PATCH JSON with the same cap and rejects raw PUT above its own committed ingress", async () => {
  const f = app();
  await request(f.server)
    .patch(item + "/metadata")
    .set("Content-Type", "application/json")
    .send("{}")
    .expect(200)
    .expect(({ body }) => expect(body.body).toEqual({}));
  const raw = direct(
    { "content-length": "101", "content-type": "application/json" },
    "PUT",
    item + "/content",
    100,
  );
  raw.run();
  expect(raw.response.status).toHaveBeenCalledWith(413);
  expect(raw.next).not.toHaveBeenCalled();
});
it("rejects missing or zero JSON framing and transfer encoding even on bodyless routes", () => {
  for (const headers of [
    {},
    { "content-length": "0" },
    { "transfer-encoding": "chunked", "content-length": "2" },
  ] as Record<string, string>[]) {
    const f = direct(headers);
    f.run();
    expect(f.response.status).toHaveBeenCalledWith(400);
    expect(f.next).not.toHaveBeenCalled();
  }
  const f = direct({ "transfer-encoding": "chunked" }, "GET", item, 0);
  f.run();
  expect(f.response.status).toHaveBeenCalledWith(400);
});
it("keeps namespace aliases fail-closed and rejection cache controls private", () => {
  const f = direct(
    { "content-length": "2", "content-type": "application/json" },
    "POST",
    "/API//v1/%61ttachments",
  );
  f.peekCandidate.mockReturnValue(undefined as never);
  f.run();
  expect(f.response.status).toHaveBeenCalledWith(503);
  expect(f.next).not.toHaveBeenCalled();
  expect(f.response.setHeader).toHaveBeenCalledWith(
    "Cache-Control",
    "private, no-store",
  );
  expect(f.response.vary).toHaveBeenCalledWith("Authorization");
  expect(f.response.vary).toHaveBeenCalledWith("Cookie");
});
