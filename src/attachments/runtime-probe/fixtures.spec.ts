import { createHash } from "node:crypto";
import { SMOKE_FIXTURES } from "./fixtures";
import { validateImageStructure } from "../validation/image";
import { validateMp4Structure } from "../video/mp4";
describe("fixed reviewed tiny runtime fixtures", () => {
  it("pins all bytes and actual dimensions rather than generating inputs in app", () => {
    expect(SMOKE_FIXTURES).toHaveLength(4);
    for (const item of SMOKE_FIXTURES) {
      const bytes = Buffer.from(item.base64, "base64");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        item.sha256,
      );
      if (item.name === "video") {
        const info = validateMp4Structure(bytes, item);
        expect(info.width).toBe(128);
        expect(info.height).toBe(72);
        expect(info.durationSeconds).toBe(0.5);
        expect(info.seiUnits).toBe(1);
      } else {
        const info = validateImageStructure(bytes, item);
        expect(info.width).toBe(32);
        expect(info.height).toBe(24);
      }
    }
  });
});
