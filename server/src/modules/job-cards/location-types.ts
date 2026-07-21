export type LocationGeocodingStatus = 'NOT_REQUESTED' | 'RESOLVED' | 'FAILED';
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

export type AppendJobActionLocationInput = Readonly<{
  organizationId: string;
  jobCardId: string;
  activityId: string;
  actorUserId: string;
  action: 'JOB_STARTED';
  capture: JobActionLocationCapture;
}>;

export type JobActionLocationRecord = AppendJobActionLocationInput & Readonly<{
  id: string;
  createdAt: Date;
}>;
