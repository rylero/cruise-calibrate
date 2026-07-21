#!/usr/bin/env node
/* Cruise Calibrate CLI — same correction pipeline as the web page, from a shell.
 * Runs core.js directly; there is no build step and nothing is uploaded. */
"use strict";

const fs = require('fs');
const path = require('path');
const core = require('./core.js');

const USAGE = `Cruise Calibrate — recover true running distance from a GPS track
recorded while running laps on a moving ship.

Usage:
  cruise-calibrate <input.fit> [options]

Options:
  --lap-period <s>     Manual lap-period override, in seconds (wins over
                       lap messages and autocorrelation).
  --kalman             Enable Kalman pre-smoothing of positions.
  --kalman-q <v>       Kalman process noise (default 0.5).
  --kalman-r <v>       Kalman measurement noise (default 9).
  --no-derotate        Do not de-rotate laps onto the ship's initial heading.
  --known-dist <m>     Known real lap distance, for a calibrated result.
  --known-laps <n>     Lap count to pair with --known-dist.
  --units <km|mi>      Output units (default km).
  --fit <out.fit>      Write a corrected .fit file.
  --trace <ship|gps>   Track written into --fit. 'ship' (default) writes the
                       reconstructed deck laps, which match the corrected
                       distance; 'gps' writes the original coordinates, whose
                       drawn path is the ship's transit and will not match.
  --csv <out.csv>      Write a per-sample CSV.
  --json               Emit results as JSON instead of a text report.
  -h, --help           Show this help.
`;

function parseArgs(argv){
  const opts = {units:'km', kalman:{enabled:false, q:0.5, r:9}, deRotate:true, trace:'ship'};
  const rest = [];
  for(let i=0;i<argv.length;i++){
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if(v === undefined) fail(`${a} requires a value`);
      return v;
    };
    const num = () => {
      const v = parseFloat(val());
      if(!isFinite(v)) fail(`${a} requires a number`);
      return v;
    };
    switch(a){
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
      case '--lap-period': opts.manualLapPeriodS = num(); break;
      case '--kalman': opts.kalman.enabled = true; break;
      case '--kalman-q': opts.kalman.q = num(); opts.kalman.enabled = true; break;
      case '--kalman-r': opts.kalman.r = num(); opts.kalman.enabled = true; break;
      case '--no-derotate': opts.deRotate = false; break;
      case '--known-dist': opts.knownDist = num(); break;
      case '--known-laps': opts.knownLaps = num(); break;
      case '--units': opts.units = val(); break;
      case '--fit': opts.fitOut = val(); break;
      case '--trace': opts.trace = val(); break;
      case '--csv': opts.csvOut = val(); break;
      case '--json': opts.json = true; break;
      default:
        if(a.startsWith('-')) fail(`unknown option: ${a}`);
        rest.push(a);
    }
  }
  if(rest.length !== 1) fail(rest.length ? 'expected exactly one input file' : 'no input file given');
  if(opts.units !== 'km' && opts.units !== 'mi') fail('--units must be km or mi');
  if(opts.trace !== 'ship' && opts.trace !== 'gps') fail("--trace must be ship or gps");
  opts.input = rest[0];
  return opts;
}

function fail(msg){
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(1);
}

function fmtDuration(s){
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.round(s%60);
  return (h ? h+'h ' : '') + m + 'm ' + String(sec).padStart(2,'0') + 's';
}

function main(){
  const opts = parseArgs(process.argv.slice(2));
  core.setUnitSystem(opts.units);

  if(!fs.existsSync(opts.input)) fail(`no such file: ${opts.input}`);
  const file = fs.readFileSync(opts.input);
  const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

  let parsed;
  try {
    parsed = core.parseFit(ab);
  } catch(e){
    fail(`could not parse ${path.basename(opts.input)} as a FIT file: ${e.message}`);
  }
  if(!parsed.records.length) fail('no GPS records with position data found in that file');

  const track = core.projectENU(parsed.records);
  const result = core.runFullCorrection(track, parsed.laps, {
    manualLapPeriodS: opts.manualLapPeriodS || null,
    kalman: opts.kalman,
    deRotate: opts.deRotate
  });

  const paceSecPerM = result.reliableTime > 0 && result.correctedDistance > 0
    ? result.reliableTime/result.correctedDistance : NaN;
  let calibrated = null;
  if(opts.knownDist && opts.knownLaps){
    const known = opts.knownDist*opts.knownLaps;
    calibrated = {knownDistanceM: known, scale: known/result.correctedDistance};
  }

  if(opts.fitOut) writeFit(opts.fitOut, result, track, opts.trace);
  if(opts.csvOut) writeCsv(opts.csvOut, result);

  if(opts.json){
    process.stdout.write(JSON.stringify({
      input: opts.input,
      records: parsed.records.length,
      lapMessages: parsed.laps.length,
      segments: result.segments.length,
      rawDistanceM: result.rawDistanceAll,
      correctedDistanceM: result.correctedDistance,
      reliableTimeS: result.reliableTime,
      calibrated
    }, null, 2) + '\n');
    return;
  }

  const L = [];
  L.push(`Cruise Calibrate — ${path.basename(opts.input)}`);
  L.push('');
  L.push(`  GPS records        ${parsed.records.length}`);
  L.push(`  Lap messages       ${parsed.laps.length || 'none (autocorrelation used)'}`);
  L.push(`  Segments           ${result.segments.length}`);
  L.push('');
  L.push(`  Raw GPS distance   ${core.fmtDist(result.rawDistanceAll)}`);
  L.push(`  Corrected distance ${core.fmtDist(result.correctedDistance)}`);
  L.push(`  Reliable time      ${fmtDuration(result.reliableTime)}`);
  L.push(`  Corrected pace     ${core.fmtPace(paceSecPerM)}`);
  if(calibrated){
    L.push('');
    L.push(`  Known distance     ${core.fmtDist(calibrated.knownDistanceM)}`);
    L.push(`  Calibration scale  ${calibrated.scale.toFixed(4)}x`);
  }
  const perSeg = result.segments.filter(s => s.nUnreliable > 0).length;
  if(perSeg){
    L.push('');
    L.push(`  Note: ${perSeg} of ${result.segments.length} segment(s) have edge samples where the`);
    L.push('  ship-velocity estimate is unreliable; those are excluded from the total.');
  }
  if(opts.fitOut) L.push(`\n  Wrote ${opts.fitOut} (${opts.trace === 'gps' ? 'original GPS trace' : 'reconstructed deck laps'})`);
  if(opts.csvOut) L.push(`  Wrote ${opts.csvOut}`);
  process.stdout.write(L.join('\n') + '\n');
}

function writeFit(out, result, track, trace){
  const samples = core.buildExportSamples(result, track, {trace});
  fs.writeFileSync(out, Buffer.from(core.buildCorrectedFit(samples)));
}

function writeCsv(out, result){
  const rows = ['time_s,speed_raw_mps,ship_speed_mps,speed_relative_mps'];
  for(let i=0;i<result.combinedT.length;i++){
    if(result.combinedT[i] === null) continue;
    rows.push([
      result.combinedT[i].toFixed(3),
      result.combinedSpeed[i].toFixed(4),
      result.combinedShipSpeed[i].toFixed(4),
      result.combinedVRel[i].toFixed(4)
    ].join(','));
  }
  fs.writeFileSync(out, rows.join('\n') + '\n');
}

main();
