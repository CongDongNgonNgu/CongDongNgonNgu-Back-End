import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('Tatoeba 08D3A zero-write architecture', () => {
  it('has no database bootstrap or Library write dependency on the dry-run surface', async () => {
    const importerDirectory = path.join(__dirname);
    const sourceFiles = [
      'tatoeba.api-client.ts',
      'tatoeba.attribution.ts',
      'tatoeba.bulk-reader.ts',
      'tatoeba.constants.ts',
      'tatoeba.direct-links.ts',
      'tatoeba.dry-run.ts',
      'tatoeba.errors.ts',
      'tatoeba.identities.ts',
      'tatoeba.languages.ts',
      'tatoeba.types.ts',
      'tatoeba.validation.ts',
    ];
    const cli = await fs.readFile(path.join(__dirname, '../../../cli/library-import-tatoeba.ts'), 'utf8');
    const contents = await Promise.all(sourceFiles.map((file) => fs.readFile(path.join(importerDirectory, file), 'utf8')));
    const joined = [...contents, cli].join('\n');

    expect(joined).not.toMatch(/AppModule|PostgresLibraryRepository|new Pool|DATABASE_URL|from ['"]pg['"]|db:migrate/);
    expect(joined).not.toMatch(/LibraryRepository|writeResource|createResource|reviewAudit/);
  });
});
