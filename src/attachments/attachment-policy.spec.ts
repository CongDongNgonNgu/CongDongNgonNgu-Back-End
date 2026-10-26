import {
  ATTACHMENT_LIMITS as L,
  assertAttachmentTransition,
  assertParentBudget,
  attachmentReservationBytes,
  formatForDeclaration,
  parseAttachmentCapabilities,
} from "./attachment-policy";

describe("frozen attachment policy", () => {
  it("defaults every format off and rejects ambiguous activation", () => {
    expect(parseAttachmentCapabilities({})).toEqual({
      enabled: false,
      image: false,
      video: false,
      text: false,
    });
    expect(() =>
      parseAttachmentCapabilities({ ATTACHMENTS_ENABLED: "yes" }),
    ).toThrow();
    expect(() =>
      parseAttachmentCapabilities({ ATTACHMENTS_VIDEO_ENABLED: "true" }),
    ).toThrow();
    expect(
      parseAttachmentCapabilities({ ATTACHMENTS_ENABLED: "true" }),
    ).toEqual({ enabled: true, image: false, video: false, text: false });
  });
  it.each(["DELETED", "REJECTED", "READY"] as const)(
    "does not revive %s uploads",
    (state) => {
      expect(() => assertAttachmentTransition(state, "UPLOADING")).toThrow();
    },
  );
  it("only admits the specified state graph", () => {
    for (const [from, to] of [
      ["TEMPORARY", "UPLOADING"],
      ["UPLOADING", "PENDING"],
      ["PENDING", "READY"],
      ["PENDING", "REJECTED"],
      ["READY", "DELETED"],
    ] as const)
      expect(() => assertAttachmentTransition(from, to)).not.toThrow();
    expect(() => assertAttachmentTransition("TEMPORARY", "READY")).toThrow();
    expect(() => assertAttachmentTransition("DELETED", "READY")).toThrow();
  });
  it("reserves source and maximum derivatives including cleanup debt", () => {
    expect(attachmentReservationBytes("IMAGE", L.imageBytes)).toBe(
      2 * L.imageBytes + L.thumbnailBytes,
    );
    expect(attachmentReservationBytes("VIDEO", L.videoBytes)).toBe(
      2 * L.videoBytes + L.thumbnailBytes,
    );
    expect(attachmentReservationBytes("TEXT", L.textBytes)).toBe(
      2 * L.textBytes,
    );
  });
  it("matches MIME and final extension and enforces exact positive integer bytes", () => {
    expect(formatForDeclaration("PHOTO.JPEG", "image/jpeg", L.imageBytes)).toBe(
      "IMAGE",
    );
    expect(formatForDeclaration("notes.txt", "text/plain", L.textBytes)).toBe(
      "TEXT",
    );
    for (const [name, mime, bytes] of [
      ["a.jpg", "text/plain", 10],
      ["a.pdf", "application/pdf", 10],
      ["a.txt", "text/plain", 0],
      ["a.txt", "text/plain", L.textBytes + 1],
      ["a.mp4", "video/mp4", NaN],
      ["a.png", "image/png", 1.5],
    ] as const)
      expect(() => formatForDeclaration(name, mime, bytes)).toThrow();
  });
  it("enforces all eight Community post capabilities without widening comments or responses", () => {
    for (const kind of ["DISCUSSION", "LEARNING_JOURNAL", "CULTURE"])
      expect(() =>
        assertParentBudget("COMMUNITY", kind, [
          { format: "VIDEO", sourceBytes: 20 },
        ]),
      ).not.toThrow();
    for (const kind of [
      "QUESTION",
      "RESOURCE",
      "CHALLENGE",
      "CORRECTION_REQUEST",
    ])
      expect(() =>
        assertParentBudget("COMMUNITY", kind, [
          { format: "VIDEO", sourceBytes: 20 },
        ]),
      ).toThrow();
    expect(() =>
      assertParentBudget("COMMUNITY", "PRONUNCIATION_REQUEST", [
        { format: "IMAGE", sourceBytes: 20 },
      ]),
    ).toThrow();
    expect(() => assertParentBudget("COMMUNITY", "COMMENT", [])).toThrow();
  });
  it("enforces count, unique video and aggregate source byte limits at the boundary", () => {
    const image = { format: "IMAGE" as const, sourceBytes: L.imageBytes };
    expect(() =>
      assertParentBudget("STUDY_GROUP", null, Array(4).fill(image)),
    ).not.toThrow();
    expect(() =>
      assertParentBudget("STUDY_GROUP", null, Array(5).fill(image)),
    ).toThrow();
    expect(() =>
      assertParentBudget("DIRECT_MESSAGE", null, [
        { format: "VIDEO", sourceBytes: 1 },
        { format: "VIDEO", sourceBytes: 1 },
      ]),
    ).toThrow();
    expect(() =>
      assertParentBudget("STUDY_GROUP", null, [{ ...image, sourceBytes: -1 }]),
    ).toThrow();
  });

  it.each([
    ["IMAGE", L.imageBytes],
    ["VIDEO", L.videoBytes],
    ["TEXT", L.textBytes],
  ] as const)(
    "distinguishes valid exact %s byte boundaries from an oversized file",
    (format, limit) => {
      expect(() => attachmentReservationBytes(format, limit)).not.toThrow();
      try {
        attachmentReservationBytes(format, limit + 1);
        throw Error("expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "LIMIT_EXCEEDED" });
      }
      for (const bytes of [0, -1, NaN, Infinity, 1.5])
        try {
          attachmentReservationBytes(format, bytes);
          throw Error("expected rejection");
        } catch (error) {
          expect(error).toMatchObject({ code: "INVALID_REQUEST" });
        }
    },
  );
  it.each([
    ["synthetic.pdf", "application/pdf"],
    ["synthetic.jpg", "text/plain"],
  ])(
    "classifies unsupported declaration %s as type mismatch",
    (filename, mime) => {
      try {
        formatForDeclaration(filename, mime, 1);
        throw Error("expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "TYPE_MISMATCH" });
      }
    },
  );

  it("requires an actual filename extension rather than treating the entire filename as one", () => {
    try {
      formatForDeclaration("jpg", "image/jpeg", 1);
      throw Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "TYPE_MISMATCH" });
    }
  });
});
