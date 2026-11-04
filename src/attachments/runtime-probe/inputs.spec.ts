import { selectRuntimeInputs } from "./inputs";
import { validateImageStructure } from "../validation/image";
import { validateMp4Structure } from "../video/mp4";
import * as boundary from "./boundary-inputs";
describe("lazy closed runtime corpus selection", () => {
  afterEach(() => jest.restoreAllMocks());
  it("never reads boundary files while selecting either finite suite", () => {
    const read = jest
      .spyOn(boundary, "readBoundaryInput")
      .mockRejectedValue(Error("MUST_NOT_RUN"));
    expect(selectRuntimeInputs("tiny").map((x) => x.name)).toEqual([
      "jpeg",
      "png",
      "webp",
      "video",
    ]);
    expect(selectRuntimeInputs("boundary").map((x) => x.name)).toEqual([
      "jpeg",
      "png",
      "webp",
      "video",
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(() => selectRuntimeInputs("unknown" as "tiny")).toThrow(
      "PHASE30_PROBE_GUARD",
    );
  });
  it.each(["tiny", "boundary"] as const)(
    "loads one hash-bound input at a time with exact expected dimensions: %s",
    async (suite) => {
      const signal = new AbortController().signal;
      for (const input of selectRuntimeInputs(suite)) {
        const bytes = await input.read(signal);
        const actual =
          input.name === "video"
            ? validateMp4Structure(bytes, input)
            : validateImageStructure(bytes, input);
        expect(actual.width).toBe(input.width);
        expect(actual.height).toBe(input.height);
        if (input.name === "video")
          expect((actual as { durationSeconds: number }).durationSeconds).toBe(
            input.durationSeconds,
          );
      }
    },
  );
  it("does not materialize tiny bytes for an already aborted request", async () => {
    const c = new AbortController();
    c.abort();
    await expect(selectRuntimeInputs("tiny")[0].read(c.signal)).rejects.toThrow(
      "PHASE30_PROBE_ABORTED",
    );
  });
});
