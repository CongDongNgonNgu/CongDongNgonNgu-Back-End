import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateImageStructure } from "../validation/image";
import { validateMp4Structure } from "../video/mp4";

describe("reviewed synthetic boundary fixture bytes (not deployed acceptance)", () => {
  const names = [
    "boundary.jpeg",
    "boundary.png",
    "boundary.webp",
    "boundary.mp4",
  ];
  it("pins the exact final asset inventory, hashes, and achieved limits", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "assets", "boundary-manifest.json"), "utf8"),
    );
    expect(manifest.scope).toBe("NEAR_LIMIT_SYNTHETIC_ONLY");
    expect(manifest.fixtures.map((x: { file: string }) => x.file)).toEqual(
      names,
    );
    for (const fixture of manifest.fixtures) {
      const bytes = readFileSync(join(__dirname, "assets", fixture.file));
      expect(bytes.length).toBe(fixture.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        fixture.sha256,
      );
      expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024 * 0.9);
      const declaration = { filename: fixture.file, mime: fixture.mime };
      const actual = fixture.file.endsWith(".mp4")
        ? validateMp4Structure(bytes, declaration)
        : validateImageStructure(bytes, declaration);
      expect(actual).toEqual(fixture.expected);
      if (fixture.file.endsWith(".mp4")) {
        expect(bytes.length).toBeLessThanOrEqual(3 * 1024 * 1024);
        expect(validateMp4Structure(bytes, declaration)).toMatchObject({
          width: 1280,
          height: 720,
          durationSeconds: 15,
          frameRate: 24,
          videoSamples: 360,
          audioSamples: 705,
          audioChannels: 1,
          audioSampleRate: 48000,
          seiUnits: 22,
        });
      } else {
        expect(bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(validateImageStructure(bytes, declaration)).toMatchObject({
          width: 2000,
          height: 1500,
        });
      }
    }
  });
  (process.env.PHASE30_REQUIRE_NATIVE_TESTS === "true" ? it : it.skip)(
    "verifies the final compiled asset inventory and hashes in required native CI",
    () => {
      const source = join(__dirname, "assets");
      const output = resolve("dist/attachments/runtime-probe/assets");
      const manifestBytes = readFileSync(
        join(source, "boundary-manifest.json"),
      );
      expect(readFileSync(join(output, "boundary-manifest.json"))).toEqual(
        manifestBytes,
      );
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      expect(readdirSync(output).sort()).toEqual(
        ["boundary-manifest.json", ...names].sort(),
      );
      for (const fixture of manifest.fixtures) {
        const bytes = readFileSync(join(output, fixture.file));
        expect(bytes.length).toBe(fixture.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          fixture.sha256,
        );
      }
    },
  );
});
