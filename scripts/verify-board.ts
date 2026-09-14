/**
 * Sanity-checks every coordinate in config.yaml against what the weather model
 * thinks is there.
 *
 *   pnpm tsx scripts/verify-board.ts
 *
 * Open-Meteo returns the elevation of the grid cell it answered from. Comparing
 * that against the elevation we claim catches the errors that actually matter —
 * a transposed sign, a coordinate on the wrong mountain, a base that is really
 * a summit — without pretending we can verify a resort base to four decimals.
 *
 * Expect some disagreement in steep terrain: a 9 km cell averages a valley and
 * a ridge into one number, so a few hundred metres is normal. Hundreds of km,
 * or a delta above ~800 m, is a real error.
 */
import { loadConfig } from '../src/config.js';
import { FORECAST_URL, getJson } from '../src/sources/weather/openMeteo.js';

const cfg = loadConfig({ env: {} });

type Check = { label: string; lat: number; lon: number; claimedM: number };

const checks: Check[] = [
  { label: 'ASPEN base', ...cfg.aspen.base, claimedM: cfg.aspen.base.elevation_m },
  { label: 'ASPEN summit', ...cfg.aspen.summit, claimedM: cfg.aspen.summit.elevation_m },
  ...cfg.board.map((d) => ({
    label: d.name,
    lat: d.lat,
    lon: d.lon,
    claimedM: d.base_elevation_m,
  })),
];

console.log('\n  point                          claimed   model    delta   verdict');
console.log('  ' + '─'.repeat(72));

const cells = new Map<string, string>();

for (const c of checks) {
  try {
    const json = await getJson(FORECAST_URL, {
      latitude: c.lat,
      longitude: c.lon,
      daily: 'snowfall_sum',
      forecast_days: 1,
      timezone: 'auto',
    });
    const modelM = typeof json.elevation === 'number' ? json.elevation : null;
    const delta = modelM === null ? null : Math.round(modelM - c.claimedM);
    const verdict =
      delta === null ? '?' : Math.abs(delta) > 800 ? '❌ CHECK THIS' : Math.abs(delta) > 400 ? '⚠️  steep' : '✅';
    console.log(
      `  ${c.label.padEnd(30)} ${String(c.claimedM).padStart(6)}m ${String(modelM ?? '?').padStart(7)}m ${String(delta ?? '?').padStart(7)}  ${verdict}`,
    );
    // Track which points resolved to the same grid cell.
    const cell = `${json.latitude},${json.longitude}`;
    if (cells.has(cell)) {
      console.log(`     ↳ same grid cell as "${cells.get(cell)}"`);
    } else {
      cells.set(cell, c.label);
    }
  } catch (err) {
    console.log(`  ${c.label.padEnd(30)} ${String((err as Error).message).slice(0, 40)}`);
  }
}

console.log(
  '\n  If ASPEN base and ASPEN summit report the same grid cell, a 9 km model\n' +
    '  cannot tell them apart and a "summit forecast" from it is really the base\n' +
    "  forecast relabelled. That's Packet 4's problem to handle honestly —\n" +
    '  either a lapse-rate correction off the elevation delta, or WeatherNext\'s\n' +
    '  finer 0.05° grid, or saying base only.\n',
);
