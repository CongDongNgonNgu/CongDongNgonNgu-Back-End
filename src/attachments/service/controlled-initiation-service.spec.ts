import type { Pool } from "pg";
import { AttachmentReadService } from "./attachment-read-service";
import type { AttachmentStorage } from "../storage/attachment-storage.port";
import type { AttachmentInitiationRepository } from "../initiation/attachment-initiation-repository";
import type { ControlledInitiationContext } from "../initiation/controlled-initiation.port";
it("refreshes the normal actor before forwarding the opaque context and refreshes replay projection normally", async () => {
  const service = new AttachmentReadService(
      {} as Pool,
      {} as AttachmentStorage,
    ),
    actor = "00000008-1111-4111-8111-111111111111",
    refresh = jest.fn(async () => actor),
    initiate = jest.fn(async () => ({ id: actor })),
    repo = { initiate } as unknown as AttachmentInitiationRepository,
    context = {} as ControlledInitiationContext;
  const metadata = jest
    .spyOn(service, "metadata")
    .mockResolvedValue({ id: actor } as never);
  await service.initiate(refresh, repo, {}, context);
  expect(initiate).toHaveBeenCalledWith(actor, {}, context);
  expect(refresh).toHaveBeenCalledTimes(1);
  await metadata.mock.calls[0][0]();
  expect(refresh).toHaveBeenCalledTimes(2);
});
