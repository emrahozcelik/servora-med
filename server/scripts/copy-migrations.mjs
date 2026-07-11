import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/db/migrations/', import.meta.url);
const destination = new URL('../dist/db/migrations/', import.meta.url);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

