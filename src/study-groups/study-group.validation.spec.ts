import { describe, expect, it } from "@jest/globals";
import {
  bounded,
  pagination,
  uuid,
  StudyGroupFailure,
  unavailable,
} from "./study-group.validation";
import { groupResponse } from "./study-group.store";

describe("study group safe boundaries", () => {
  it("normalizes bounded plain text while preserving literal markup", () => {
    expect(bounded("  <script>literal text</script>  ", 2000)).toBe(
      "<script>literal text</script>",
    );
    expect(bounded("😀".repeat(2000), 2000)).toHaveLength(4000);
  });
  it.each([null, 42, "  ", "\0", "a".repeat(2001)])(
    "rejects invalid text %p",
    (value) => {
      expect(() => bounded(value, 2000)).toThrow(StudyGroupFailure);
    },
  );
  it("allows an empty optional description but rejects excessive scalar length", () => {
    expect(bounded("", 500, true)).toBe("");
    expect(() => bounded("😀".repeat(501), 500, true)).toThrow(
      StudyGroupFailure,
    );
  });
  it.each([
    { page: 0 },
    { page: 1.1 },
    { page: Infinity },
    { page: 1_000_001 },
    { limit: 21 },
    { limit: 0 },
  ])("rejects unbounded pagination %p", (query) => {
    expect(() => pagination(query)).toThrow(StudyGroupFailure);
  });
  it("accepts only valid UUID v4 identifiers", () => {
    expect(() => uuid("00000000-0000-4000-8000-000000000001")).not.toThrow();
    expect(() => uuid("foreign-id")).toThrow(StudyGroupFailure);
  });
  it("uses the same unavailable body for every authorization denial", () => {
    try {
      unavailable();
    } catch (error) {
      expect(error).toBeInstanceOf(StudyGroupFailure);
      expect((error as StudyGroupFailure).getResponse()).toEqual({
        code: "GROUP_UNAVAILABLE",
        message: "Study group is not available",
      });
      expect((error as StudyGroupFailure).getStatus()).toBe(404);
    }
  });
  it("explicitly serializes a group without owner/account/database internals", () => {
    const now = new Date("2026-10-07T00:00:00Z");
    expect(
      groupResponse(
        {
          id: "g",
          name: "group",
          description: "",
          owner_user_id: "private-owner",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
        "MEMBER",
      ),
    ).toEqual({
      id: "g",
      name: "group",
      description: "",
      status: "ACTIVE",
      role: "MEMBER",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });
});
