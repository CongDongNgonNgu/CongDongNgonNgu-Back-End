import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { ConfigService } from "@nestjs/config";
import type { SessionService } from "../../auth/session/session.service";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import {
  AttachmentController,
  type AttachmentHttpApplication,
} from "./attachment.controller";
import type { ControlledInitiationContext } from "../initiation/controlled-initiation.port";
import { AttachmentRuntime } from "../attachment-runtime";
function fixture() {
  const order: string[] = [],
    context = {} as ControlledInitiationContext,
    request = Object.assign(new EventEmitter(), {
      headers: { authorization: "Bearer native" },
      user: { user: { id: "actor" }, claims: { sid: "session" } },
    }) as AuthenticatedRequest,
    response = new EventEmitter() as Response;
  const application = {
      initiate: jest.fn(async () => {
        order.push("application");
        return {};
      }),
    } as unknown as AttachmentHttpApplication,
    sessions = {
      assertCsrfForCookie: jest.fn(() => order.push("csrf")),
    } as unknown as SessionService,
    policy = {
      bind: jest.fn(async () => {
        order.push("bind");
        return context;
      }),
    },
    controller = new AttachmentController(
      application,
      sessions,
      {} as ConfigService,
      undefined,
      policy,
    );
  return {
    controller,
    request,
    response,
    context,
    application,
    policy,
    sessions,
    order,
  };
}
it("binds native initiation only after query and CSRF checks and forwards opaque context", async () => {
  const f = fixture(),
    input = { body: "native" };
  await f.controller.initiate(f.request, input, {}, f.response);
  expect(f.order).toEqual(["csrf", "bind", "application"]);
  expect(f.policy.bind).toHaveBeenCalledWith(f.request, input, f.response);
  expect(f.application.initiate).toHaveBeenCalledWith(
    expect.any(Function),
    input,
    f.context,
  );
});
it("never binds or calls product code on query/CSRF denial", async () => {
  for (const csrf of [false, true]) {
    const f = fixture();
    if (csrf)
      (f.sessions.assertCsrfForCookie as jest.Mock).mockImplementation(() => {
        throw Error("CSRF denied");
      });
    await expect(
      f.controller.initiate(
        f.request,
        {},
        csrf ? {} : { unexpected: "x" },
        f.response,
      ),
    ).rejects.toThrow();
    expect(f.policy.bind).not.toHaveBeenCalled();
    expect(f.application.initiate).not.toHaveBeenCalled();
  }
});
it("ordinary runtime rejects explicitly supplied context even undefined before invoking its ordinary producer", () => {
  const runtime = Object.create(
      AttachmentRuntime.prototype,
    ) as AttachmentRuntime,
    run = jest.fn();
  Reflect.set(runtime, "run", run);
  for (const value of [undefined, {} as ControlledInitiationContext])
    expect(() => runtime.initiate(async () => null, {}, value)).toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("fails closed if installed controlled binder does not supply a context", async () => {
  const f = fixture();
  f.policy.bind.mockResolvedValue(undefined as never);
  await expect(
    f.controller.initiate(f.request, {}, {}, f.response),
  ).rejects.toMatchObject({ status: 503 });
  expect(f.application.initiate).not.toHaveBeenCalled();
});
