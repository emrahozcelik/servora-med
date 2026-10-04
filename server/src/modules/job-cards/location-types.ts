export type LocationGeocodingStatus = 'NOT_REQUESTED' | 'RESOLVED' | 'FAILED';
export type LocationGeocodingProvider = 'GOOGLE';
export type LocationFailureReason =
  | 'PERMISSION_DENIED'
  | 'POSITION_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export type CapturedJobActionLocation = Readonly<{
  outcome: 'CAPTURED';
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: Date;
  geocodingStatus: LocationGeocodingStatus;
  geocodingProvider: LocationGeocodingProvider | null;
  neighborhood: string | null;
  district: string | null;
  city: string | null;
  approximateLabel: string | null;
}>;

export type UnavailableJobActionLocation = Readonly<{
  outcome: 'UNAVAILABLE';
  reason: LocationFailureReason;
}>;

export type JobActionLocationCapture =
  | CapturedJobActionLocation
  | UnavailableJobActionLocation;

export type JobActionLocationAction = 'JOB_STARTED' | 'JOB_SUBMITTED_FOR_APPROVAL';

export type JobActionLocationComparisonOutcome = 'MATCH' | 'DIFFERENT' | 'UNRELIABLE';

/**
 * Slice 2 advisory comparison evidence. Server-computed only: it is never
 * part of client-supplied input (the SUBMIT body contract rejects unknown
 * keys) and only exists on JOB_SUBMITTED_FOR_APPROVAL rows. Null comparison
 * (absent) means no comparison: legacy row, unavailable evidence, or no
 * valid START reference.
 */
export type JobActionLocationComparison = Readonly<{
  /** Exact JOB_STARTED activity the SUBMIT snapshot was compared against. */
  referenceActivityId: string;
  /** Server-computed great-circle distance in metres (kept for UNRELIABLE too). */
  distanceMeters: number;
  outcome: JobActionLocationComparisonOutcome;
}>;

export type AppendJobActionLocationInput = Readonly<{
  organizationId: string;
  jobCardId: string;
  activityId: string;
  actorUserId: string;
  action: JobActionLocationAction;
  capture: JobActionLocationCapture;
  comparison?: JobActionLocationComparison;
}>;

export type JobActionLocationRecord = Omit<AppendJobActionLocationInput, 'comparison'> & Readonly<{
  id: string;
  createdAt: Date;
  comparison: JobActionLocationComparison | null;
}>;
