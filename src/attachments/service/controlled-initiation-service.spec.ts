import type { Pool } from "pg";
import { SessionFailure } from "../../auth/session/session.service";
import { AttachmentReadService } from "./attachment-read-service";
import type { AttachmentStorage } from "../storage/attachment-storage.port";
import type { AttachmentInitiationRepository } from "../initiation/attachment-initiation-repository";
import type {
  ControlledInitiationContext,
  ControlledInitiationProjection,
} from "../initiation/controlled-initiation.port";
const actor = "00000008-1111-4111-8111-111111111111";
it("uses required gated projection after fresh actor correlation without ordinary metadata fallback", async () => {
  const service = new AttachmentReadService(
      {} as Pool,
      {} as AttachmentStorage,
    ),
    refresh = jest.fn(async () => actor),
    context = {} as ControlledInitiationContext,
    projected = jest.fn(
      async (
        _actor: string,
        _body: unknown,
        _ctx: ControlledInitiationContext,
        p: ControlledInitiationProjection<unknown>,
      ) => {
        await p.refresh();
        return { id: actor };
      },
    ),
    initiate = jest.fn(),
    repo = {
      initiate,
      initiateProjected: projected,
    } as unknown as AttachmentInitiationRepository,
    metadata = jest.spyOn(service, "metadata");
  await expect(service.initiate(refresh, repo, {}, context)).resolves.toEqual({
    id: actor,
  });
  expect(projected).toHaveBeenCalledWith(
    actor,
    {},
    context,
    expect.objectContaining({
      refresh: expect.any(Function),
      rate: expect.any(Function),
      select: expect.any(Function),
    }),
  );
  expect(initiate).not.toHaveBeenCalled();
  expect(metadata).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("preserves only native SessionFailure from the recipe refresh across opaque controlled failure", async () => {
  const service = new AttachmentReadService(
      {} as Pool,
      {} as AttachmentStorage,
    ),
    failure = new SessionFailure("AUTH_SESSION_EXPIRED"),
    refresh = jest
      .fn()
      .mockResolvedValueOnce(actor)
      .mockRejectedValueOnce(failure),
    repo = {
      initiateProjected: async (
        _a: string,
        _b: unknown,
        _c: unknown,
        p: ControlledInitiationProjection<unknown>,
      ) => {
        try {
          await p.refresh();
        } catch {
          throw Error("OPAQUE_CONTROL");
        }
      },
    } as unknown as AttachmentInitiationRepository;
  await expect(
    service.initiate(refresh, repo, {}, {} as ControlledInitiationContext),
  ).rejects.toBe(failure);
});
