/**
 * Records real API responses into test/fixtures/ so the test suite can stay
 * hermetic while still being checked against data the APIs actually return.
 *
 * Run this from a shell with normal network access:
 *   pnpm tsx scripts/record-fixtures.ts
 *
 * It also answers two things the Open-Meteo docs do not: which `models=` values
 * are accepted, and which of them carry snow_depth and freezing_level_height.
 * Re-run it whenever a source starts behaving oddly — a diff in these files is
 * usually the explanation.
 */
import '../src/env.js'; // must come first: reads .env into process.env
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_URL, FORECAST_URL, SEASONAL_URL, getJson } from '../src/sources/weather/openMeteo.js';

const OUT = join(process.cwd(), 'test', 'fixtures');
mkdirSync(OUT, { recursive: true });

// Aspen Snowmass base, the coordinate every weather fixture is anchored to.
const ASPEN = { latitude: 39.2084, longitude: -106.949 };

const CORE_DAILY =
  'snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min,temperature_2m_mean,wind_speed_10m_max,wind_gusts_10m_max';
const OPTIONAL_HOURLY = 'snow_depth,freezing_level_height';

const MODELS = [
  'ecmwf_ifs025',
  'ecmwf_aifs025',
  'icon_eu',
  'icon_global',
  'gfs_seamless',
  'ncep_nam_conus',
];

type Row = { model: string; ok: boolean; optional: boolean; note: string };
const rows: Row[] = [];

const save = (name: string, data: unknown) => {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
};

for (const model of MODELS) {
  const base = {
    ...ASPEN,
    models: model,
    daily: CORE_DAILY,
    forecast_days: 15,
    timezone: 'auto',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  };
  try {
    const withOptional = await getJson(FORECAST_URL, { ...base, hourly: OPTIONAL_HOURLY });
    save(`forecast-${model}`, withOptional);
    rows.push({ model, ok: true, optional: true, note: 'full' });
  } catch {
    try {
      const coreOnly = await getJson(FORECAST_URL, base);
      save(`forecast-${model}`, coreOnly);
      rows.push({ model, ok: true, optional: false, note: 'no snow_depth/freezing_level' });
    } catch (err2) {
      rows.push({ model, ok: false, optional: false, note: String((err2 as Error).message).slice(0, 90) });
    }
  }
}

// Trailing week of observed snowfall.
const end = new Date(Date.now() - 24 * 3600_000);
const start = new Date(end.getTime() - 6 * 24 * 3600_000);
const d = (x: Date) => x.toISOString().slice(0, 10);
try {
  save(
    'archive-aspen',
    await getJson(ARCHIVE_URL, {
      ...ASPEN,
      start_date: d(start),
      end_date: d(end),
      daily: 'snowfall_sum',
      timezone: 'auto',
    }),
  );
  rows.push({ model: 'archive', ok: true, optional: true, note: `${d(start)}..${d(end)}` });
} catch (err) {
  rows.push({ model: 'archive', ok: false, optional: false, note: String((err as Error).message).slice(0, 90) });
}

try {
  save(
    'seasonal-aspen',
    await getJson(SEASONAL_URL, {
      ...ASPEN,
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
      forecast_days: 180,
      timezone: 'auto',
    }),
  );
  rows.push({ model: 'seasonal', ok: true, optional: true, note: '180d' });
} catch (err) {
  rows.push({ model: 'seasonal', ok: false, optional: false, note: String((err as Error).message).slice(0, 90) });
}

console.log('\n  source                 ok   optional vars   note');
console.log('  ' + '─'.repeat(70));
for (const r of rows) {
  console.log(
    `  ${r.model.padEnd(22)} ${(r.ok ? '✅' : '❌').padEnd(4)} ${(r.optional ? 'yes' : 'no').padEnd(15)} ${r.note}`,
  );
}
console.log(`\n  fixtures written to ${OUT}\n`);
