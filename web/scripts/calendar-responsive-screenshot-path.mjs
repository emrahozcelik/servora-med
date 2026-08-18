import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function calendarScreenshotPath(viewportName) {
  return join(tmpdir(), `servora-calendar-${viewportName}.png`);
}
