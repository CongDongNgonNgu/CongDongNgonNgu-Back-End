import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(__dirname, "../../database/migrations");
describe("study group scoped migration safety", () => {
  it("preserves community author-private schema and scoped owner enforcement", () => {
    const sql = readFileSync(
      resolve(root, "0027_phase22_study_groups.sql"),
      "utf8",
    );
    expect(sql).not.toMatch(
      /ALTER TABLE (?:community_|users)|UPDATE (?:community_|users)|DROP /iu,
    );
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("UNIQUE (group_id,user_id,status,role)");
    expect(sql).toContain("FOREIGN KEY (group_id,text_id)");
  });
  it("limits destructive development rollback to the new tables", () => {
    const sql = readFileSync(
      resolve(root, "0027_phase22_study_groups.down.sql"),
      "utf8",
    );
    const drops = [...sql.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map(
      (match) => match[1],
    );
    expect(drops).toHaveLength(6);
    expect(drops.every((name) => name.startsWith("study_group"))).toBe(true);
    expect(sql).not.toMatch(/CASCADE|DROP TYPE|DROP SCHEMA/iu);
  });
});
