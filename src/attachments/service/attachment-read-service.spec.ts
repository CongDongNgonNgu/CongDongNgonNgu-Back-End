import { SessionFailure } from "../../auth/session/session.service";
import { AttachmentReadService } from "./attachment-read-service";
import type { Pool } from "pg";
import type { AttachmentStorage } from "../storage/attachment-storage.port";
describe("attachment service fresh identity boundary", () => {
  it("never touches SQL/storage when supplied identity refresh fails", async () => {
    const pool = { connect: jest.fn() },
      storage = { openRead: jest.fn(), head: jest.fn() };
    const service = new AttachmentReadService(
      pool as unknown as Pool,
      storage as unknown as AttachmentStorage,
    );
    const denied = new SessionFailure("AUTH_SESSION_EXPIRED");
    await expect(
      service.metadata(async () => {
        throw denied;
      }, "not-looked-up"),
    ).rejects.toBe(denied);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(storage.head).not.toHaveBeenCalled();
  });
  it.each(["patchMetadata", "delete"] as const)(
    "requires authentication before lookup for %s",
    async (method) => {
      const pool = { connect: jest.fn() },
        service = new AttachmentReadService(
          pool as unknown as Pool,
          {} as AttachmentStorage,
        );
      const operation =
        method === "delete"
          ? service.delete(async () => null, "not-looked-up")
          : service.patchMetadata(async () => null, "not-looked-up", {});
      await expect(operation).rejects.toMatchObject({
        code: "AUTH_UNAUTHORIZED",
      });
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );
  it("requires metadata authentication before SQL even with a valid trusted IP quota identity", async () => {
    const pool = { connect: jest.fn() },
      service = new AttachmentReadService(
        pool as unknown as Pool,
        {} as AttachmentStorage,
      );
    await expect(
      service.metadata(async () => null, "not-looked-up", "a".repeat(64)),
    ).rejects.toMatchObject({ code: "AUTH_UNAUTHORIZED" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects identity changes after initiation instead of projecting as a different or anonymous reader", async () => {
    const actor = "11111111-1111-4111-8111-111111111111",
      other = "22222222-2222-4222-8222-222222222222";
    for (const changed of [null, other]) {
      const refresh = jest
          .fn()
          .mockResolvedValueOnce(actor)
          .mockResolvedValueOnce(changed),
        pool = { connect: jest.fn() };
      const repository = {
        initiate: jest
          .fn()
          .mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" }),
      };
      const service = new AttachmentReadService(
        pool as unknown as Pool,
        {} as AttachmentStorage,
      );
      await expect(
        service.initiate(
          refresh,
          repository as unknown as import("../initiation/attachment-initiation-repository").AttachmentInitiationRepository,
          {},
        ),
      ).rejects.toMatchObject({ code: "AUTH_UNAUTHORIZED" });
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });
});

describe('internal current-public read constraint admission',()=>{
 it('requires authentication before SQL even with valid anonymous IP identity',async()=>{
  const pool={connect:jest.fn()},storage={head:jest.fn(),openRead:jest.fn()};const service=new AttachmentReadService(pool as unknown as Pool,storage as unknown as AttachmentStorage);
  await expect(service.read(async()=>null,'not-looked-up','HEAD',{trustedIpHash:'a'.repeat(64),constraint:'AUTHENTICATED_PUBLIC_COMMUNITY'} as never)).rejects.toMatchObject({code:'AUTH_UNAUTHORIZED'});
  expect(pool.connect).not.toHaveBeenCalled();expect(storage.head).not.toHaveBeenCalled();expect(storage.openRead).not.toHaveBeenCalled();
 });
 it.each([null,'UNKNOWN',false])('rejects invalid internal constraint %s before quota or identity I/O',async constraint=>{
  const pool={connect:jest.fn()},refresh=jest.fn(async()=>null),service=new AttachmentReadService(pool as unknown as Pool,{} as AttachmentStorage);
  await expect(service.read(refresh,'not-looked-up','GET',{trustedIpHash:'a'.repeat(64),constraint} as never)).rejects.toMatchObject({code:'ATTACHMENT_UNAVAILABLE'});
  expect(pool.connect).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
 });
});
