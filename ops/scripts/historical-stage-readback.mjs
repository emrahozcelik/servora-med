// OPS-R4-006: strict, read-only readback of the historical staging tree.
// It never certifies independent retention, a historical archive, approval,
// disposition, source removal, restore success or deploy eligibility.
//
// The readback is implemented in the shared evidence layer so the OPS-R4-002
// in-place admission branch can verify the same staged bytes without importing
// this CLI module (which would create a controller/module cycle).
import {fileURLToPath} from 'node:url';
import {
  HISTORICAL_STAGING_DIR,HISTORICAL_STAGING_RECEIPT,
  readHistoricalStageReceipt,validateHistoricalStageReceipt,verifyHistoricalStageReadback
} from './historical-recovery-evidence.mjs';

export {
  readHistoricalStageReceipt,validateHistoricalStageReceipt,verifyHistoricalStageReadback
};

export function verifyFixedHistoricalStage(){
  if(process.getuid?.()!==0)
    throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_ADMIN_REQUIRED');
  if(process.argv.length!==2)
    throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_ARGUMENTS_INVALID');
  return verifyHistoricalStageReadback({
    stageRoot:HISTORICAL_STAGING_DIR,receiptPath:HISTORICAL_STAGING_RECEIPT,uid:0,gid:0
  });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{process.stdout.write(JSON.stringify(verifyFixedHistoricalStage())+'\n');}
  catch(e){process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.message)
    ?e.message:'RECOVERY_HISTORICAL_STAGE_READBACK_INVALID')+'\n');process.exitCode=1;}
}
