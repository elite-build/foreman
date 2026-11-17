import os from 'node:os'
import { DAY_MS, sweepTemp } from '../src/main/tempSweep'

/** Each test file's temp folder (tests/setup.ts): `fvt-` and six random characters. */
export const RUN_TEMP_PREFIX = 'fvt-'

// A run that was killed, or a file whose processes still held its folder, leaves the folder behind: clear those a day old.
export default async function setup(): Promise<void> {
  await sweepTemp({ dir: os.tmpdir(), match: new RegExp(`^${RUN_TEMP_PREFIX}[A-Za-z0-9]{6}$`), olderThanMs: DAY_MS })
}
