import { randomUUID } from "node:crypto";
import { parseInitiation } from "./initiation-input";
describe("strict immutable attachment initiation", () => {
  const input = () => ({
    clientUploadId: randomUUID(),
    scope: {
      kind: "COMMUNITY",
      postType: "DISCUSSION",
      languageId: randomUUID(),
      visibility: "PRIVATE",
    },
    filename: "synthetic.txt",
    mime: "text/plain",
    bytes: 5,
    caption: "safe",
    alt: "",
  });
  it("normalizes safe metadata and fingerprints a canonical fixed field order", () => {
    const source = input();
    const a = parseInitiation(source);
    const b = parseInitiation({
      ...source,
      scope: {
        visibility: "PRIVATE",
        languageId: source.scope.languageId,
        postType: "DISCUSSION",
        kind: "COMMUNITY",
      },
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.format).toBe("TEXT");
    expect(a.reservedBytes).toBe(65541);
    expect(
      parseInitiation({ ...source, caption: "changed" }).fingerprint,
    ).not.toBe(a.fingerprint);
  });
  it("fails unknown fields, wrong domains, malformed identifiers and incompatible post capability", () => {
    for (const change of [
      { ...input(), url: "https://invalid.invalid" },
      { ...input(), clientUploadId: "guess" },
      { ...input(), bytes: 0 },
      { ...input(), mime: "application/pdf" },
      {
        ...input(),
        scope: {
          kind: "STUDY_GROUP",
          groupId: randomUUID(),
          conversationId: randomUUID(),
        },
      },
      {
        ...input(),
        scope: {
          kind: "COMMUNITY",
          postType: "PRONUNCIATION_REQUEST",
          languageId: randomUUID(),
          visibility: "PUBLIC",
        },
      },
    ])
      expect(() => parseInitiation(change)).toThrow();
  });
  it("accepts each exact typed domain and keeps filenames separate from paths", () => {
    for (const scope of [
      { kind: "STUDY_GROUP", groupId: randomUUID() },
      { kind: "DIRECT_MESSAGE", conversationId: randomUUID() },
    ])
      expect(parseInitiation({ ...input(), scope }).intent).toEqual(scope);
    expect(() =>
      parseInitiation({ ...input(), filename: "../secret.txt" }),
    ).toThrow();
  });
});
