import type { Pool } from 'pg';

import type { AppConfig } from './config.js';
import type { AppDependencies } from './app.js';
import {
  createGeolocationDependencies,
  type GeolocationDependencies,
} from './geolocation-dependencies.js';

export type GeolocationDependencyFactory = (
  config: AppConfig,
  pool: Pool,
) => GeolocationDependencies;

export type ProductionDependencyFactories = Readonly<{
  createGeolocationDependencies?: GeolocationDependencyFactory;
}>;

/** Build the production app dependency object, including geolocation wiring. */
export function createProductionAppDependencies(
  config: AppConfig,
  pool: Pool,
  baseDependencies: AppDependencies,
  factories: ProductionDependencyFactories = {},
): AppDependencies {
  const createGeolocation =
    factories.createGeolocationDependencies ?? createGeolocationDependencies;

  return {
    ...baseDependencies,
    ...createGeolocation(config, pool),
  };
}
