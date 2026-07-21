export type ReverseGeocodingInput = Readonly<{
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  correlationId: string;
}>;

export type ReverseGeocodingResult = Readonly<{
  neighborhood: string | null;
  district: string | null;
  city: string | null;
  approximateLabel: string;
}>;

export interface ReverseGeocoder {
  reverse(input: ReverseGeocodingInput): Promise<ReverseGeocodingResult>;
}
