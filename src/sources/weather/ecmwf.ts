import type { Source } from '../types.js';
import { fetchModelForecast } from './openMeteo.js';
import type { Coord, ModelForecast } from './types.js';

export type ForecastParams = {
  coord: Coord;
  forecastDays: number;
  ttlMinutes: number;
};

/** The euro model: IFS HRES via Open-Meteo. The physics half of the consensus. */
export const ECMWF_IFS = 'ecmwf_ifs025';
/** ECMWF's own AI model. A second opinion from the same institution. */
export const ECMWF_AIFS = 'ecmwf_aifs025';

export function modelSource(model: string): Source<ForecastParams, ModelForecast> {
  return {
    name: `open-meteo:${model}`,
    key: (p) => `${p.coord.lat.toFixed(4)},${p.coord.lon.toFixed(4)}:${p.forecastDays}d`,
    ttlMinutes: (p) => p.ttlMinutes,
    fetch: (p) => fetchModelForecast(model, p.coord, p.forecastDays),
  };
}

export const ecmwfIfs = modelSource(ECMWF_IFS);
export const ecmwfAifs = modelSource(ECMWF_AIFS);
