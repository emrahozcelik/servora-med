// OPS-R4-004: read-only, exact-path historical source inventory. This module
// never publishes an archive, moves a source, issues a grant or seals a record.
// Its JSON output is NOT a disposition, approval, or archival acceptance proof.
//
// The inventory is implemented in the shared evidence layer so the OPS-R4-002
// in-place admission branch can prove the same bytes without importing this
// CLI module (which would create a controller/module cycle).
import {fileURLToPath} from 'node:url';
import {
  captureHistoricalSourceInventory,validateHistoricalSourceInventory
} from './historical-recovery-evidence.mjs';

export {captureHistoricalSourceInventory,validateHistoricalSourceInventory};

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.length!==2)throw new Error('RECOVERY_HISTORICAL_INVENTORY_ARGUMENTS_INVALID');
  // Root-only readback; deliberately no filesystem mutation and no output files.
  process.stdout.write(JSON.stringify(captureHistoricalSourceInventory())+'\n');
}
