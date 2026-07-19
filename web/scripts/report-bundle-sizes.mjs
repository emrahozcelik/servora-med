import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const assetsDirectory = new URL('../dist/assets/', import.meta.url);
const rawLimitBytes = 500_000;
const enforce = process.env.BUNDLE_ENFORCE === '1';

let entries;
try {
  entries = await readdir(assetsDirectory, { withFileTypes: true });
} catch (error) {
  console.error(
    'dist/assets bulunamadı. Önce `npm run build` çalıştırın.',
    error,
  );
  process.exit(1);
}

const javascriptFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name)
  .sort();

const rows = [];

for (const filename of javascriptFiles) {
  const content = await readFile(new URL(filename, assetsDirectory));
  rows.push({
    file: filename,
    rawBytes: content.byteLength,
    rawKiB: Number((content.byteLength / 1024).toFixed(2)),
    gzipKiB: Number((gzipSync(content).byteLength / 1024).toFixed(2)),
  });
}

rows.sort((left, right) => right.rawBytes - left.rawBytes);

console.log('JavaScript bundle sizes');
console.table(
  rows.map(({ file, rawKiB, gzipKiB }) => ({
    file,
    rawKiB,
    gzipKiB,
  })),
);

const oversized = rows.filter((row) => row.rawBytes > rawLimitBytes);

if (!enforce) {
  if (oversized.length > 0) {
    console.log(
      `Measurement only: ${oversized.length} JavaScript chunk 500.000 byte sınırını geçiyor.`,
    );
  }
  process.exit(0);
}

const failures = [];

if (rows.length < 2) {
  failures.push(
    `Route split kanıtlanmadı: yalnız ${rows.length} JavaScript chunk üretildi.`,
  );
}

for (const row of oversized) {
  failures.push(
    `${row.file}: ${row.rawBytes} byte; izin verilen en yüksek değer ${rawLimitBytes} byte.`,
  );
}

if (failures.length > 0) {
  console.error('Bundle budget failure:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Bundle budget OK: ${rows.length} JavaScript chunk, her biri en fazla ${rawLimitBytes} byte.`,
);
