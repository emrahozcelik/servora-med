import { elapsedTime, sampleTrustedTime, type TimeEvidence } from '../scripts/trusted-time.mjs';
const sample: TimeEvidence = sampleTrustedTime();
const result = elapsedTime(sample, sample);
if (result.status === 'KNOWN') {
  const lower: number = result.lowerMs;
  const upper: number = result.upperMs;
  void lower; void upper;
}
