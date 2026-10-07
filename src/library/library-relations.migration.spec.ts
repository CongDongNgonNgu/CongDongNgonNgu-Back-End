import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIBRARY_RELATION_TYPES } from './library-relations.types';
describe('0028 additive reviewed relation migration contract', () => {
  it.each(['sql', 'down.sql'])('provides BOM-free %s executable SQL', (suffix) => {
    const bytes = readFileSync(resolve(__dirname, '../../database/migrations/0028_phase23_library_relations.' + suffix));
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });
  it('has directed unique nonself assertions, current review evidence and revision guards', () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../database/migrations/0028_phase23_library_relations.sql',
      ),
      'utf8',
    );
    for (const type of LIBRARY_RELATION_TYPES)
      expect(sql).toContain("'" + type + "'");
    expect(sql).toContain(
      'PRIMARY KEY(anchor_resource_id,target_resource_id,relation_type)',
    );
    expect(sql).toContain('CHECK(anchor_resource_id <> target_resource_id)');
    expect(
      sql.match(/REFERENCES library_resources\(id\) ON DELETE CASCADE/g),
    ).toHaveLength(2);
    expect(sql).toContain('REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('CHECK (revision > 0)');
    expect(sql).toContain('isfinite(reviewed_at)');
    expect(sql).toContain('library_resource_relations_anchor_order_idx');
    expect(sql).not.toMatch(/INSERT|library_collection_members|benchmark/i);
  });
  it('scopes rollback to the additive relation table', () => {
    expect(
      readFileSync(
        resolve(
          __dirname,
          '../../database/migrations/0028_phase23_library_relations.down.sql',
        ),
        'utf8',
      )
        .trim()
        .replace(/^\uFEFF/, ''),
    ).toBe('DROP TABLE library_resource_relations;');
  });
});
