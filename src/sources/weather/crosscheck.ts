import type { Source } from '../types.js';
import { modelSource, type ForecastParams } from './ecmwf.js';
import type { ModelForecast } from './types.js';

/**
 * The third leg of the consensus. Which of these is meaningful depends on where
 * the resort is — NAM is CONUS-only, ICON-EU is Europe-only — so `crosscheckFor`
 * picks by longitude rather than asking every model about every mountain and
 * quietly getting a global-model answer dressed up as a regional one.
 */
export const ICON_EU = 'icon_eu';
export const ICON_GLOBAL = 'icon_global';
export const GFS = 'gfs_seamless';
export const NAM = 'ncep_nam_conus';

export const iconEu = modelSource(ICON_EU);
export const iconGlobal = modelSource(ICON_GLOBAL);
export const gfs = modelSource(GFS);
export const nam = modelSource(NAM);

export type Region = 'US' | 'EU' | 'JP' | 'CA';

/** Regional model first, GFS always, since GFS is the one that covers everywhere. */
export function crosscheckFor(region: Region): Source<ForecastParams, ModelForecast>[] {
  switch (region) {
    case 'US':
    case 'CA':
      return [nam, gfs];
    case 'EU':
      return [iconEu, gfs];
    case 'JP':
      return [iconGlobal, gfs];
  }
}
