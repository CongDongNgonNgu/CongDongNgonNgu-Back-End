import type { PoolClient } from "pg";
import { AttachmentRetentionLedger } from "./attachment-retention-ledger";
describe("bounded attachment retention admission", () => {
  it.each([-1, 21, 1.5, NaN, Infinity])(
    "rejects invalid shared budget %s before touching SQL",
    async (limit) => {
      const query = jest.fn();
      await expect(
        new AttachmentRetentionLedger().purge(
          { query } as unknown as PoolClient,
          limit,
        ),
      ).rejects.toThrow("ATTACHMENT_RETENTION_INVALID");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("uses no SQL when the caller has no batch budget left", async () => {
    const query = jest.fn();
    expect(
      await new AttachmentRetentionLedger().purge(
        { query } as unknown as PoolClient,
        0,
      ),
    ).toEqual({
      admissionsPurged: 0,
      rateCountersPurged: 0,
      used: 0,
      remaining: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
