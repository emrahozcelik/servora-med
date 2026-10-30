import { elapsedTime, sampleTrustedTime, type TimeEvidence } from '../scripts/trusted-time.mjs';
const sample: TimeEvidence = sampleTrustedTime();
const result = elapsedTime(sample, sample);
if (result.status === 'KNOWN') {
  const lower: number = result.lowerMs;
  const upper: number = result.upperMs;
  void lower; void upper;
}

import {validateCurrentTimeEvidence,validateTimeEvidence,type CurrentTimeEvidence,type LegacyTimeEvidence} from '../scripts/trusted-time.mjs';
const fresh:CurrentTimeEvidence=validateCurrentTimeEvidence(sample);
const currentVersion:2=fresh.formatVersion;
const historical=validateTimeEvidence(sample);
if(historical.formatVersion===1){const old:LegacyTimeEvidence=historical;void old;}
else {const count:2|3=historical.synchronization.sourceCount;void count;}
void currentVersion;
// @ts-expect-error historical evidence is not automatically current authority
const cannotPromote:CurrentTimeEvidence={} as LegacyTimeEvidence;
void cannotPromote;
