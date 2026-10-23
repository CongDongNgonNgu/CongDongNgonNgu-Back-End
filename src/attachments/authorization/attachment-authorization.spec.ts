import { authorizeDraftScope } from "./attachment-authorization";
import type { PoolClient } from "pg";
import { authorizeBoundParent } from "./attachment-authorization";
describe("attachment scope validation", () => {
  it("denies anonymous private-domain identifiers before SQL", async () => {
    const client = {
      query: () => {
        throw new Error("unexpected SQL");
      },
    } as unknown as PoolClient;
    await expect(
      authorizeBoundParent(client, null, {
        kind: "STUDY_GROUP",
        groupId: "24f23806-5a78-44bc-a805-3b5d77b1d517",
        textId: "84e16306-91a6-47da-a648-bd70c9abc024",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
    await expect(
      authorizeBoundParent(client, null, {
        kind: "DIRECT_MESSAGE",
        conversationId: "24f23806-5a78-44bc-a805-3b5d77b1d517",
        messageId: "84e16306-91a6-47da-a648-bd70c9abc024",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
  });
  it("rejects malformed and unsupported scopes before SQL", async () => {
    const client = {
      query: () => {
        throw new Error("unexpected SQL");
      },
    } as unknown as PoolClient;
    await expect(
      authorizeDraftScope(client, "bad", {
        kind: "STUDY_GROUP",
        groupId: "bad",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  });
});
