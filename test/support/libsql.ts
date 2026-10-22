import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';
vi.mock(import('../../src/db/driver.js'), async (importOriginal) => {
  const original = await importOriginal();
  const { openTurso } = await import('../../src/db/turso.js');
  return { ...original, openSqlite: (file: string) => {
    const temporary = !file || file === ':memory:' ? mkdtempSync(join(tmpdir(), 'crewly-client-')) : undefined;
    const db = openTurso(pathToFileURL(temporary ? join(temporary, 'test.db') : file).href, '');
    const close = db.close;
    db.close = () => { try { close(); } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); } };
    return db;
  } };
});
