import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const directory of ['migrations', 'migrations-postgres']) {
  const src = path.join(__dirname, '..', 'src', 'db', directory);
  const dest = path.join(__dirname, '..', 'dist', 'db', directory);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}
