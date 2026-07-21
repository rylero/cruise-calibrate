/* Cruise Calibrate — core algorithms.
 *
 * Shared verbatim by the browser page (index.html) and the CLI (cli.js).
 * Deliberately a plain classic script rather than an ES module: no build step,
 * and index.html keeps working both on GitHub Pages and when opened straight
 * from disk over file:// (module scripts are blocked by CORS there).
 */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.CruiseCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function(){
"use strict";

/* ==================== FIT binary parser ==================== */

const FIT_EPOCH_OFFSET = 631065600; // seconds between 1989-12-31T00:00:00Z and Unix epoch

const BASE_TYPES = {
  0x00:{size:1,name:'enum'},   0x01:{size:1,name:'sint8'},  0x02:{size:1,name:'uint8'},
  0x83:{size:2,name:'sint16'}, 0x84:{size:2,name:'uint16'},
  0x85:{size:4,name:'sint32'}, 0x86:{size:4,name:'uint32'},
  0x07:{size:1,name:'string'}, 0x88:{size:4,name:'float32'}, 0x89:{size:8,name:'float64'},
  0x0A:{size:1,name:'uint8z'}, 0x8B:{size:2,name:'uint16z'}, 0x8C:{size:4,name:'uint32z'},
  0x0D:{size:1,name:'byte'},   0x8E:{size:8,name:'sint64'},  0x8F:{size:8,name:'uint64'},
  0x90:{size:8,name:'uint64z'}
};

function readScalar(dv, offset, baseTypeByte, little){
  const t = BASE_TYPES[baseTypeByte];
  if(!t) return null;
  switch(t.name){
    case 'sint8': { const v = dv.getInt8(offset); return v===0x7F?null:v; }
    case 'uint8': case 'enum': { const v = dv.getUint8(offset); return v===0xFF?null:v; }
    case 'uint8z': { const v = dv.getUint8(offset); return v===0?null:v; }
    case 'sint16': { const v = dv.getInt16(offset,little); return v===0x7FFF?null:v; }
    case 'uint16': { const v = dv.getUint16(offset,little); return v===0xFFFF?null:v; }
    case 'uint16z': { const v = dv.getUint16(offset,little); return v===0?null:v; }
    case 'sint32': { const v = dv.getInt32(offset,little); return v===0x7FFFFFFF?null:v; }
    case 'uint32': { const v = dv.getUint32(offset,little); return v===0xFFFFFFFF?null:v; }
    case 'uint32z': { const v = dv.getUint32(offset,little); return v===0?null:v; }
    case 'float32': { const v = dv.getFloat32(offset,little); return Number.isNaN(v)?null:v; }
    default: return null;
  }
}

// Fields we care about, shared across message types by field number
const F_LAT = 0, F_LONG = 1, F_START_TIME = 2, F_TIMESTAMP = 253;
const MSG_RECORD = 20, MSG_LAP = 19;

function parseFit(arrayBuffer){
  const dv = new DataView(arrayBuffer);
  let p = 0;
  const headerSize = dv.getUint8(0);
  if(headerSize < 12) throw new Error('Not a valid FIT file (bad header size)');
  const dotFit = String.fromCharCode(dv.getUint8(8),dv.getUint8(9),dv.getUint8(10),dv.getUint8(11));
  if(dotFit !== '.FIT') throw new Error('Not a valid FIT file (missing ".FIT" tag)');
  const dataSize = dv.getUint32(4, true);
  p = headerSize;
  const end = headerSize + dataSize;

  const localDefs = {};
  let lastTimestamp = null;
  const records = [];
  const laps = [];

  while(p < end){
    const header = dv.getUint8(p); p += 1;
    const isDefinition = (header & 0x40) !== 0;
    const compressedTS = (header & 0x80) !== 0;

    if(compressedTS){
      const localType = (header >> 5) & 0x3;
      const timeOffset = header & 0x1F;
      const def = localDefs[localType];
      if(!def) throw new Error('Compressed-timestamp record before its definition');
      if(lastTimestamp === null) throw new Error('Compressed-timestamp record before any absolute timestamp');
      let ts = (lastTimestamp & ~0x1F) | timeOffset;
      if(ts < lastTimestamp) ts += 32;
      lastTimestamp = ts;
      const rec = readDataFields(dv, p, def);
      p += def.totalSize;
      rec.timestamp = ts;
      if(def.globalMesgNum === MSG_RECORD) pushRecordIfValid(records, rec);
      else if(def.globalMesgNum === MSG_LAP) pushLapIfValid(laps, rec);
      continue;
    }

    const localType = header & 0x0F;

    if(isDefinition){
      const reserved = dv.getUint8(p); p += 1; void reserved;
      const arch = dv.getUint8(p); p += 1;
      const little = arch === 0;
      const globalMesgNum = dv.getUint16(p, little); p += 2;
      const numFields = dv.getUint8(p); p += 1;
      const fields = [];
      let totalSize = 0;
      for(let i=0;i<numFields;i++){
        const fieldNum = dv.getUint8(p); const size = dv.getUint8(p+1); const baseType = dv.getUint8(p+2);
        p += 3;
        fields.push({num:fieldNum, size, baseType});
        totalSize += size;
      }
      if(header & 0x20){
        const numDev = dv.getUint8(p); p += 1;
        for(let i=0;i<numDev;i++){
          const size = dv.getUint8(p+1);
          p += 3;
          totalSize += size;
        }
      }
      localDefs[localType] = {globalMesgNum, little, fields, totalSize};
      continue;
    }

    const def = localDefs[localType];
    if(!def) throw new Error('Data message references undefined local type '+localType);
    const rec = readDataFields(dv, p, def);
    p += def.totalSize;
    if(rec.timestamp != null) lastTimestamp = rec.timestamp;
    if(def.globalMesgNum === MSG_RECORD) pushRecordIfValid(records, rec);
    else if(def.globalMesgNum === MSG_LAP) pushLapIfValid(laps, rec);
  }

  return {records, laps};
}

function readDataFields(dv, offset, def){
  let o = offset;
  const out = {};
  for(const f of def.fields){
    if(f.size === 4 && (f.num === F_TIMESTAMP || f.num === F_START_TIME)){
      const v = readScalar(dv, o, 0x86, def.little); // uint32
      if(f.num === F_TIMESTAMP) out.timestamp = v; else out.start_time = v;
    } else if(f.size === 4 && (f.num === F_LAT || f.num === F_LONG)){
      const v = readScalar(dv, o, 0x85, def.little); // sint32
      if(f.num === F_LAT) out.lat = v; else out.lon = v;
    }
    o += f.size;
  }
  return out;
}

function pushRecordIfValid(records, rec){
  if(rec.timestamp == null || rec.lat == null || rec.lon == null) return;
  records.push({
    t: rec.timestamp + FIT_EPOCH_OFFSET,
    lat: rec.lat * (180 / 2147483648),
    lon: rec.lon * (180 / 2147483648)
  });
}

function pushLapIfValid(laps, rec){
  if(rec.start_time == null || rec.timestamp == null) return;
  const start = rec.start_time + FIT_EPOCH_OFFSET;
  const end = rec.timestamp + FIT_EPOCH_OFFSET;
  if(end > start) laps.push({start, end});
}

/* ==================== Geometry / projection ==================== */

const R_EARTH = 6371000;

function projectENU(records){
  let sumLat=0, sumLon=0;
  for(const r of records){ sumLat += r.lat; sumLon += r.lon; }
  const lat0 = (sumLat/records.length) * Math.PI/180;
  const lon0 = (sumLon/records.length) * Math.PI/180;
  const cosLat0 = Math.cos(lat0);
  const t=[], x=[], y=[];
  for(const r of records){
    const latRad = r.lat*Math.PI/180, lonRad = r.lon*Math.PI/180;
    x.push(R_EARTH*(lonRad-lon0)*cosLat0);
    y.push(R_EARTH*(latRad-lat0));
    t.push(r.t);
  }
  return {t, x, y, lat0, lon0};
}

function unprojectENU(x, y, lat0, lon0){
  const cosLat0 = Math.cos(lat0);
  const latRad = lat0 + y/R_EARTH;
  const lonRad = lon0 + x/(R_EARTH*cosLat0);
  return {lat: latRad*180/Math.PI, lon: lonRad*180/Math.PI};
}

// Rough measurement-noise estimate from the data itself: the second
// difference of position cancels out slow (constant-velocity-ish) motion
// and is dominated by GPS noise, so std(d2)/sqrt(6) approximates the
// per-axis position noise std for iid noise. Used to seed a sensible
// Kalman r before the user runs (or instead of) the grid search.
function estimateGpsNoiseStd(x, y){
  const n = x.length;
  if(n < 5) return null;
  const d2 = [];
  for(let i=1;i<n-1;i++){
    d2.push(x[i+1]-2*x[i]+x[i-1]);
    d2.push(y[i+1]-2*y[i]+y[i-1]);
  }
  const mean = d2.reduce((a,b)=>a+b,0)/d2.length;
  const variance = d2.reduce((a,b)=>a+(b-mean)*(b-mean),0)/d2.length;
  return Math.sqrt(variance/6);
}

/* ==================== Segment splitting (pause/resume) ==================== */

function median(arr){
  const s = arr.slice().sort((a,b)=>a-b);
  const n = s.length;
  return n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2;
}

function splitSegments(t, x, y){
  if(t.length < 2) return [{t,x,y}];
  const dts = [];
  for(let i=1;i<t.length;i++) dts.push(t[i]-t[i-1]);
  const dtMed = median(dts) || 1;
  const gapThreshold = Math.max(20, dtMed*8);
  const segments = [];
  let segStart = 0;
  for(let i=1;i<t.length;i++){
    if(t[i]-t[i-1] > gapThreshold){
      segments.push({t:t.slice(segStart,i), x:x.slice(segStart,i), y:y.slice(segStart,i)});
      segStart = i;
    }
  }
  segments.push({t:t.slice(segStart), x:x.slice(segStart), y:y.slice(segStart)});
  return segments.filter(s => s.t.length >= 8);
}

/* ==================== Resampling ==================== */

function interpLinear(tq, t, v){
  const n = t.length;
  if(tq <= t[0]) return v[0];
  if(tq >= t[n-1]) return v[n-1];
  let lo=0, hi=n-1;
  while(hi-lo>1){
    const mid=(lo+hi)>>1;
    if(t[mid] <= tq) lo=mid; else hi=mid;
  }
  const f = (tq - t[lo])/(t[hi]-t[lo]);
  return v[lo] + f*(v[hi]-v[lo]);
}

function resampleUniform(t, x, y){
  const dts = [];
  for(let i=1;i<t.length;i++) dts.push(t[i]-t[i-1]);
  let dt = median(dts);
  if(!(dt > 0)) dt = 1;
  dt = Math.max(dt, 0.5);
  const t0 = t[0], t1 = t[t.length-1];
  const n = Math.max(2, Math.floor((t1-t0)/dt)+1);
  const tu = new Array(n), xu = new Array(n), yu = new Array(n);
  for(let i=0;i<n;i++){
    const tq = t0 + i*dt;
    tu[i] = tq;
    xu[i] = interpLinear(tq, t, x);
    yu[i] = interpLinear(tq, t, y);
  }
  return {t:tu, x:xu, y:yu, dt};
}

/* ==================== Kalman (constant-velocity, per axis) ==================== */

// Forward-only filter. Kept for reference/tests; the pipeline uses the
// forward-backward smoother below, which removes the cold-start transient
// a forward-only filter leaves at the very first samples (state covariance
// starts uncertain and needs a few steps to converge).
function kalman1D(z, dt, q, r){
  return kalmanRTSSmooth1D(z, dt, q, r).pos;
}

// Rauch-Tung-Striebel fixed-interval smoother: forward Kalman pass, then a
// backward pass that lets later samples correct earlier ones. Valid here
// because the whole recording is processed as a batch, not streamed live.
function kalmanRTSSmooth1D(z, dt, q, r){
  const n = z.length;
  const filtPos=new Array(n), filtVel=new Array(n);
  const filtP00=new Array(n), filtP01=new Array(n), filtP10=new Array(n), filtP11=new Array(n);
  const predPos=new Array(n), predVel=new Array(n);
  const predP00=new Array(n), predP01=new Array(n), predP10=new Array(n), predP11=new Array(n);

  let pos = z[0], vel = 0;
  let P00=100, P01=0, P10=0, P11=100;
  for(let i=0;i<n;i++){
    if(i>0){
      pos = pos + vel*dt;
      const Q11 = q*dt*dt*dt/3, Q12 = q*dt*dt/2, Q22 = q*dt;
      const fp00 = P00 + dt*P10, fp01 = P01 + dt*P11;
      const fp10 = P10, fp11 = P11;
      const np00 = fp00 + dt*fp01, np01 = fp01;
      const np10 = fp10 + dt*fp11, np11 = fp11;
      P00 = np00 + Q11; P01 = np01 + Q12; P10 = np10 + Q12; P11 = np11 + Q22;
    }
    predPos[i]=pos; predVel[i]=vel;
    predP00[i]=P00; predP01[i]=P01; predP10[i]=P10; predP11[i]=P11;

    const innov = z[i] - pos;
    const S = P00 + r;
    const K0 = P00/S, K1 = P10/S;
    pos = pos + K0*innov;
    vel = vel + K1*innov;
    const p00=P00, p01=P01;
    P00 = p00 - K0*p00; P01 = p01 - K0*p01;
    P10 = P10 - K1*p00; P11 = P11 - K1*p01;
    filtPos[i]=pos; filtVel[i]=vel;
    filtP00[i]=P00; filtP01[i]=P01; filtP10[i]=P10; filtP11[i]=P11;
  }

  const smPos = filtPos.slice(), smVel = filtVel.slice();
  for(let i=n-2;i>=0;i--){
    // C = filtP[i] . F^T . inv(predP[i+1]),  F=[[1,dt],[0,1]]
    const fF00 = filtP00[i] + dt*filtP01[i], fF01 = filtP01[i];
    const fF10 = filtP10[i] + dt*filtP11[i], fF11 = filtP11[i];
    const a=predP00[i+1], b=predP01[i+1], c=predP10[i+1], d=predP11[i+1];
    const det = a*d - b*c;
    if(Math.abs(det) < 1e-12) continue;
    const inv00=d/det, inv01=-b/det, inv10=-c/det, inv11=a/det;
    const C00 = fF00*inv00 + fF01*inv10, C01 = fF00*inv01 + fF01*inv11;
    const C10 = fF10*inv00 + fF11*inv10, C11 = fF10*inv01 + fF11*inv11;
    const dPos = smPos[i+1]-predPos[i+1], dVel = smVel[i+1]-predVel[i+1];
    smPos[i] = filtPos[i] + C00*dPos + C01*dVel;
    smVel[i] = filtVel[i] + C10*dPos + C11*dVel;
  }
  return {pos: smPos, vel: smVel};
}

/* ==================== Velocity ==================== */

function centralDiffVelocity(t, x, y){
  const n = t.length;
  const vx = new Array(n), vy = new Array(n);
  for(let i=0;i<n;i++){
    let i0 = i===0 ? 0 : i-1;
    let i1 = i===n-1 ? n-1 : i+1;
    const dt = t[i1]-t[i0];
    vx[i] = dt>0 ? (x[i1]-x[i0])/dt : 0;
    vy[i] = dt>0 ? (y[i1]-y[i0])/dt : 0;
  }
  return {vx, vy};
}

/* ==================== Autocorrelation lap-period detection ==================== */

function autocorrelate(signal, dt, minLagS, maxLagFrac){
  const n = signal.length;
  const mean = signal.reduce((a,b)=>a+b,0)/n;
  const s = signal.map(v=>v-mean);
  let energy = 0; for(const v of s) energy += v*v;
  const minLag = Math.max(2, Math.round(minLagS/dt));
  const maxLag = Math.max(minLag+1, Math.floor(n * maxLagFrac));
  let best = {lag:minLag, score:-Infinity};
  for(let lag=minLag; lag<maxLag; lag++){
    let acc = 0;
    for(let i=0; i<n-lag; i++) acc += s[i]*s[i+lag];
    const score = energy>0 ? acc/energy : 0;
    if(score > best.score) best = {lag, score};
  }
  return {periodS: best.lag*dt, lagSamples: best.lag, score: best.score};
}

/* ==================== Variable-window moving average ==================== */

function buildWindowSamplesArray(tUniform, lapBoundaries, dt, fallbackWindow){
  const n = tUniform.length;
  const windows = new Array(n);
  if(!lapBoundaries || lapBoundaries.length === 0){
    windows.fill(fallbackWindow);
    return windows;
  }
  const bs = lapBoundaries.slice().sort((a,b)=>a.start-b.start);
  let idx = 0;
  for(let i=0;i<n;i++){
    const tt = tUniform[i];
    while(idx < bs.length-1 && tt >= bs[idx+1].start) idx++;
    const lap = bs[idx];
    const dur = Math.max(dt*3, lap.end-lap.start);
    windows[i] = Math.max(3, Math.round(dur/dt));
  }
  return windows;
}

function movingAverageVariable(arr, windows){
  const n = arr.length;
  const prefix = new Array(n+1); prefix[0]=0;
  for(let i=0;i<n;i++) prefix[i+1] = prefix[i]+arr[i];
  const out = new Array(n), reliable = new Array(n);
  for(let i=0;i<n;i++){
    const half = Math.floor(windows[i]/2);
    let lo = i-half, hi = i+half;
    reliable[i] = !(lo < 0 || hi >= n);
    lo = Math.max(0, lo); hi = Math.min(n-1, hi);
    out[i] = (prefix[hi+1]-prefix[lo])/(hi-lo+1);
  }
  return {avg: out, reliable};
}

// The moving average at the first/last half-window of samples is computed
// from a truncated, one-sided window and is a poor ship-velocity estimate
// (biased toward the runner's own motion). Replace those edge estimates with
// a flat extrapolation from the nearest fully-windowed (reliable) sample,
// rather than integrating the biased value into distance/plots.
function extrapolateEdges(avg, reliable){
  const n = avg.length;
  const firstReliable = reliable.indexOf(true);
  const lastReliable = reliable.lastIndexOf(true);
  if(firstReliable === -1) return avg.slice();
  const out = avg.slice();
  for(let i=0;i<firstReliable;i++) out[i] = avg[firstReliable];
  for(let i=lastReliable+1;i<n;i++) out[i] = avg[lastReliable];
  return out;
}

/* ==================== Per-segment correction pipeline ==================== */

function runSegmentPipeline(seg, opts){
  opts = opts || {};
  const uni = resampleUniform(seg.t, seg.x, seg.y);
  let xs = uni.x, ys = uni.y;
  if(opts.kalman && opts.kalman.enabled){
    xs = kalman1D(uni.x, uni.dt, opts.kalman.q, opts.kalman.r);
    ys = kalman1D(uni.y, uni.dt, opts.kalman.q, opts.kalman.r);
  }
  const {vx, vy} = centralDiffVelocity(uni.t, xs, ys);
  const speed = vx.map((v,i)=>Math.hypot(v, vy[i]));

  let windowSource, acInfo=null, lapPeriodSDisplay, windows;
  if(opts.manualLapPeriodS){
    windowSource = 'manual';
    lapPeriodSDisplay = opts.manualLapPeriodS;
    windows = new Array(uni.t.length).fill(Math.max(3, Math.round(opts.manualLapPeriodS/uni.dt)));
  } else if(opts.lapBoundaries && opts.lapBoundaries.length >= 2){
    windowSource = 'fit-laps';
    lapPeriodSDisplay = opts.lapBoundaries.reduce((a,l)=>a+(l.end-l.start),0)/opts.lapBoundaries.length;
    windows = buildWindowSamplesArray(uni.t, opts.lapBoundaries, uni.dt, null);
  } else {
    windowSource = 'autocorrelation';
    acInfo = autocorrelate(speed, uni.dt, 20, 0.5);
    lapPeriodSDisplay = acInfo.periodS;
    windows = new Array(uni.t.length).fill(Math.max(3, Math.round(acInfo.periodS/uni.dt)));
  }

  const maX = movingAverageVariable(vx, windows);
  const maY = movingAverageVariable(vy, windows);
  const n = uni.t.length;
  const reliable = new Array(n);
  for(let i=0;i<n;i++) reliable[i] = maX.reliable[i] && maY.reliable[i];
  
  const vShipX = extrapolateEdges(maX.avg, reliable);
  const vShipY = extrapolateEdges(maY.avg, reliable);
  for (let i = 0; i < n; i++) {
      if (!reliable[i]) {
        if (i < reliable.length / 2) {
          for (let j = i; j < n; j++) {
            if (reliable[j]) {
              reliable[i] = reliable[j];
              vShipX[i] = vShipX[j];
              vShipY[i] = vShipY[j];
              break;
            }
          }
        } else {
          for (let j = i; j > 0; j--) {
            if (reliable[j]) {
              reliable[i] = reliable[j];
              vShipX[i] = vShipX[j];
              vShipY[i] = vShipY[j];
              break;
            }
          }
        }
      }
  }

  const vRelX = new Array(n), vRelY = new Array(n), vRelMag = new Array(n), shipSpeed = new Array(n);
  for(let i=0;i<n;i++){
    vRelX[i] = vx[i]-vShipX[i];
    vRelY[i] = vy[i]-vShipY[i];
    vRelMag[i] = Math.hypot(vRelX[i], vRelY[i]);
    shipSpeed[i] = Math.hypot(vShipX[i], vShipY[i]);
  }

  let correctedDistance = 0, reliableTime = 0, rawDistanceAll = 0;
  const cumCorrected = new Array(n);
  let cum = 0;
  for(let i=0;i<n;i++){
    rawDistanceAll += speed[i]*uni.dt;
    // Only accumulate over reliable samples, so this cumulative curve (used
    // for the CSV/FIT export) always totals to exactly correctedDistance —
    // unreliable edge samples hold the cumulative flat rather than folding
    // in a biased contribution.
    if(reliable[i]){ correctedDistance += vRelMag[i]*uni.dt; reliableTime += uni.dt; cum += vRelMag[i]*uni.dt; }
    cumCorrected[i] = cum;
  }

  const nUnreliable = reliable.filter(r=>!r).length;

  return {
    uni, vx, vy, speed, vShipX, vShipY, shipSpeed, vRelX, vRelY, vRelMag,
    reliable, cumCorrected, windowSource, acInfo, lapPeriodSDisplay,
    correctedDistance, reliableTime, rawDistanceAll, nUnreliable,
    rawX: seg.x, rawY: seg.y
  };
}

/* ==================== Full-activity correction (segments + chaining) ==================== */

// Below this ship speed (m/s) the heading of the ship-velocity vector is mostly
// noise, so de-rotation holds the last trustworthy heading instead.
const MIN_HEADING_SPEED = 0.5;

// Ship heading from the smoothed ship-velocity vector, unwrapped so it can be
// differenced without 2pi jumps. Below minSpeed the direction of a near-zero
// vector is meaningless, so hold the last trustworthy heading instead.
function shipHeadingSeries(vShipX, vShipY, shipSpeed, minSpeed){
  const n = vShipX.length, out = new Array(n);
  let last = null;
  for(let i=0;i<n;i++){
    if(shipSpeed[i] >= minSpeed){
      let a = Math.atan2(vShipY[i], vShipX[i]);
      if(last !== null) a += Math.round((last-a)/(2*Math.PI))*2*Math.PI;
      last = a;
    }
    out[i] = last;
  }
  // Leading samples run before the first trustworthy heading — back-fill them
  // with it (or 0 if the ship never moved fast enough to have a heading).
  const first = out.find(v => v !== null);
  for(let i=0;i<n;i++) if(out[i] === null) out[i] = (first === undefined ? 0 : first);
  return out;
}

function runFullCorrection(track, lapMessages, opts){
  opts = opts || {};
  const segments = splitSegments(track.t, track.x, track.y);
  const segResults = [];
  let correctedDistance = 0, reliableTime = 0, rawDistanceAll = 0;

  const combinedT=[], combinedSpeed=[], combinedShipSpeed=[], combinedVRel=[];
  const combinedRawX=[], combinedRawY=[], combinedShipFrameX=[], combinedShipFrameY=[];
  let runningSfx = 0, runningSfy = 0;
  // Reference heading for de-rotation: the ship's heading at the very first
  // sample of the activity. Every lap is rotated back onto this so the loops
  // stack instead of fanning out as the ship turns.
  const deRotate = opts.deRotate !== false;
  let refHeading = null;

  segments.forEach((seg, si) => {
    const t0 = seg.t[0], t1 = seg.t[seg.t.length-1];
    const segLaps = (lapMessages||[])
      .filter(l => l.end > t0 && l.start < t1)
      .map(l => ({start: Math.max(l.start, t0), end: Math.min(l.end, t1)}))
      .filter(l => l.end - l.start > 5);

    const res = runSegmentPipeline(seg, {
      lapBoundaries: segLaps.length >= 2 ? segLaps : null,
      manualLapPeriodS: opts.manualLapPeriodS || null,
      kalman: opts.kalman || {enabled:false}
    });
    res.lapCount = segLaps.length;
    res.shipFrameX = [];
    res.shipFrameY = [];
    segResults.push(res);

    correctedDistance += res.correctedDistance;
    reliableTime += res.reliableTime;
    rawDistanceAll += res.rawDistanceAll;

    const heading = shipHeadingSeries(res.vShipX, res.vShipY, res.shipSpeed, MIN_HEADING_SPEED);
    if(refHeading === null && heading.length) refHeading = heading[0];

    for(let i=0;i<res.uni.t.length;i++){
      combinedT.push(res.uni.t[i]);
      combinedSpeed.push(res.speed[i]);
      combinedShipSpeed.push(res.shipSpeed[i]);
      combinedVRel.push(res.vRelMag[i]);
      runningSfx += res.vRelX[i]*res.uni.dt;
      runningSfy += res.vRelY[i]*res.uni.dt;
      // De-rotation must be applied to the accumulated position, not to the
      // velocity: with p_earth = R(dtheta)*p_deck the earth-frame velocity also
      // carries an Rdot*p_deck term, so rotating velocity and then integrating
      // leaves a residual that grows with turn rate and smears the loops.
      // Rotating the position undoes the ship's turn exactly.
      let px = runningSfx, py = runningSfy;
      if(deRotate){
        const a = -(heading[i] - refHeading), ca = Math.cos(a), sa = Math.sin(a);
        px = runningSfx*ca - runningSfy*sa;
        py = runningSfx*sa + runningSfy*ca;
      }
      combinedShipFrameX.push(px);
      combinedShipFrameY.push(py);
      res.shipFrameX.push(px);
      res.shipFrameY.push(py);
    }
    for(let i=0;i<seg.x.length;i++){
      combinedRawX.push(seg.x[i]);
      combinedRawY.push(seg.y[i]);
    }
    if(si < segments.length-1){
      combinedT.push(null); combinedSpeed.push(null); combinedShipSpeed.push(null); combinedVRel.push(null);
      combinedRawX.push(null); combinedRawY.push(null);
      combinedShipFrameX.push(null); combinedShipFrameY.push(null);
    }
  });

  return {
    segments: segResults, correctedDistance, reliableTime, rawDistanceAll,
    combinedT, combinedSpeed, combinedShipSpeed, combinedVRel,
    combinedRawX, combinedRawY, combinedShipFrameX, combinedShipFrameY
  };
}

/* ==================== Ship-frame path assembly ==================== */

// Removes slow drift from a reconstructed path by subtracting a centred moving
// average taken over roughly one lap. Residual error in the ship-velocity
// estimate makes the stack of laps wander over the course of a run; averaged
// over a whole lap the running itself cancels, so what is left is the drift.
// Subtracting it pins the laps in place without touching their shape.
//
// The window shrinks at the two ends rather than extrapolating, so the first
// and last half-lap are detrended more weakly than the middle.
function detrendPath(xs, ys, windowSamples){
  const n = xs.length;
  const half = Math.max(1, Math.floor(windowSamples/2));
  const px = new Float64Array(n+1), py = new Float64Array(n+1);
  for(let i=0;i<n;i++){ px[i+1] = px[i]+xs[i]; py[i+1] = py[i]+ys[i]; }
  const ox = new Array(n), oy = new Array(n);
  for(let i=0;i<n;i++){
    const a = Math.max(0, i-half), b = Math.min(n, i+half+1), c = b-a;
    ox[i] = xs[i] - (px[b]-px[a])/c;
    oy[i] = ys[i] - (py[b]-py[a])/c;
  }
  return {x: ox, y: oy};
}

// Per-segment ship-frame path, optionally drift-corrected. Shared by the plot
// and the exporter so the picture on screen is the one that gets written out.
function segmentShipFramePath(seg, opts){
  opts = opts || {};
  if(!opts.detrend) return {x: seg.shipFrameX, y: seg.shipFrameY};
  const win = Math.max(3, Math.round((seg.lapPeriodSDisplay || 60)/seg.uni.dt));
  return detrendPath(seg.shipFrameX, seg.shipFrameY, win);
}

// Whole-activity ship-frame path for plotting, with nulls between segments.
function shipFramePath(result, opts){
  const x = [], y = [];
  result.segments.forEach((seg, si) => {
    const p = segmentShipFramePath(seg, opts);
    for(let i=0;i<p.x.length;i++){ x.push(p.x[i]); y.push(p.y[i]); }
    if(si < result.segments.length-1){ x.push(null); y.push(null); }
  });
  return {x, y};
}

/* ==================== Export sample construction ==================== */

// Builds the {tUnix, lat, lon, distM} samples handed to buildCorrectedFit.
//
// trace 'ship' (default) writes the reconstructed ship-frame path: the laps as
// actually run on the deck, anchored at the activity's starting coordinate.
// This is what matches the corrected distance.
//
// trace 'gps' writes the original coordinates instead. Those are geographically
// true but include the ship's transit, so the drawn track is the vessel's path
// smeared across the sea and its on-screen length disagrees with the corrected
// distance stored alongside it.
function buildExportSamples(result, track, opts){
  opts = opts || {};
  const useShipFrame = opts.trace !== 'gps';
  const samples = [];
  let offset = 0;
  for(const seg of result.segments){
    const path = useShipFrame ? segmentShipFramePath(seg, opts) : null;
    for(let i=0;i<seg.uni.t.length;i++){
      let x, y;
      if(useShipFrame){
        // Anchor the deck path at the first fix of the segment so the loops are
        // drawn at a plausible position rather than off the coast of Africa.
        x = seg.uni.x[0] + path.x[i];
        y = seg.uni.y[0] + path.y[i];
      } else {
        x = seg.uni.x[i];
        y = seg.uni.y[i];
      }
      const {lat, lon} = unprojectENU(x, y, track.lat0, track.lon0);
      samples.push({tUnix: seg.uni.t[i], lat, lon, distM: offset + seg.cumCorrected[i]});
    }
    offset += seg.correctedDistance;
  }
  return samples;
}

/* ==================== Synthetic scenario generator ==================== */

// Deterministic PRNG so grid search results are reproducible run-to-run.
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a>>>15, 1 | a);
    t = t + Math.imul(t ^ t>>>7, 61 | t) ^ t;
    return ((t ^ t>>>14) >>> 0) / 4294967296;
  };
}

function gaussianNoise(rng){
  rng = rng || Math.random;
  let u=0, v=0;
  while(u===0) u = rng();
  while(v===0) v = rng();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

function generateSyntheticScenario(opts, rng){
  rng = rng || Math.random;
  const cfg = Object.assign({
    durationS: 1800, dt: 1.0, shipSpeed: 10, headingDegPerMin: 0,
    lapPeriodBase: 36, lapJitterFrac: 0, runnerSpeed: 2.8,
    noiseStd: 3, pauseAtFrac: null, pauseDurationS: 0
  }, opts||{});

  const laps = [];
  let curT = 0;
  while(curT < cfg.durationS){
    const jitter = 1 + cfg.lapJitterFrac*(rng()*2-1);
    const dur = Math.max(5, cfg.lapPeriodBase*jitter);
    laps.push({start:curT, end:curT+dur});
    curT += dur;
  }
  function runnerAngleAt(time){
    for(let i=0;i<laps.length;i++){
      if(time >= laps[i].start && time < laps[i].end){
        const f = (time-laps[i].start)/(laps[i].end-laps[i].start);
        return 2*Math.PI*(i+f);
      }
    }
    return 2*Math.PI*laps.length;
  }
  const loopRadius = (cfg.runnerSpeed*cfg.lapPeriodBase)/(2*Math.PI);

  const n = Math.round(cfg.durationS/cfg.dt);
  const t=[], x=[], y=[];
  let shipX=0, shipY=0;
  const heading0 = rng()*2*Math.PI;
  let prevAngle = null, runnerDistance = 0;
  let pauseStart=null, pauseEnd=null;
  if(cfg.pauseAtFrac != null){
    pauseStart = cfg.pauseAtFrac*cfg.durationS;
    pauseEnd = pauseStart+cfg.pauseDurationS;
  }
  for(let i=0;i<n;i++){
    const time = i*cfg.dt;
    const heading = heading0 + (cfg.headingDegPerMin*Math.PI/180)*(time/60);
    shipX += cfg.shipSpeed*Math.cos(heading)*cfg.dt;
    shipY += cfg.shipSpeed*Math.sin(heading)*cfg.dt;
    const ang = runnerAngleAt(time);
    const rx = loopRadius*Math.cos(ang), ry = loopRadius*Math.sin(ang);
    const inPause = pauseStart != null && time >= pauseStart && time < pauseEnd;
    if(!inPause){
      if(prevAngle != null) runnerDistance += Math.abs(ang-prevAngle)*loopRadius;
      prevAngle = ang;
      const nx = gaussianNoise(rng)*cfg.noiseStd, ny = gaussianNoise(rng)*cfg.noiseStd;
      t.push(time); x.push(shipX+rx+nx); y.push(shipY+ry+ny);
    } else {
      prevAngle = null;
    }
  }
  return {
    t, x, y,
    laps: laps.filter(l=>l.start < cfg.durationS).map(l=>({start:l.start, end:Math.min(l.end, cfg.durationS)})),
    truth: {runnerDistance, lapPeriodBase: cfg.lapPeriodBase, shipSpeed: cfg.shipSpeed}
  };
}

const GRID_SEARCH_SCENARIOS = [
  {name:'baseline', opts:{}},
  {name:'high_noise', opts:{noiseStd:6}},
  {name:'inconsistent_pace', opts:{lapJitterFrac:0.35}},
  {name:'ship_turning', opts:{headingDegPerMin:3}},
  {name:'pause_resume', opts:{pauseAtFrac:0.5, pauseDurationS:300}}
];

function gridSearchKalmanParams(qCandidates, rCandidates, scenarioDefs, repeatsPerScenario, seed){
  const rng = mulberry32(seed != null ? seed : 42);
  const instances = [];
  for(const sd of scenarioDefs){
    for(let k=0;k<repeatsPerScenario;k++){
      instances.push(generateSyntheticScenario(sd.opts, rng));
    }
  }
  function avgErrFor(kalmanOpts){
    let tot = 0;
    for(const inst of instances){
      const full = runFullCorrection({t:inst.t, x:inst.x, y:inst.y}, inst.laps, {kalman:kalmanOpts});
      tot += Math.abs(full.correctedDistance - inst.truth.runnerDistance)/inst.truth.runnerDistance;
    }
    return tot/instances.length;
  }
  const baselineErr = avgErrFor({enabled:false});
  const results = [];
  let best = null;
  for(const q of qCandidates){
    for(const r of rCandidates){
      const err = avgErrFor({enabled:true, q, r});
      results.push({q, r, err});
      if(!best || err < best.err) best = {q, r, err};
    }
  }
  results.sort((a,b)=>a.err-b.err);
  return {baselineErr, best, top: results.slice(0,8)};
}

/* ==================== Formatting (unit-aware) ==================== */

const MI_PER_M = 1/1609.344;
let unitSystem = 'km'; // 'km' | 'mi', toggled from the UI

function fmtDist(m){
  if(unitSystem === 'mi'){
    const mi = m*MI_PER_M;
    return mi>=0.1 ? mi.toFixed(3)+' mi' : m.toFixed(1)+' m';
  }
  return m>=1000 ? (m/1000).toFixed(3)+' km' : m.toFixed(1)+' m';
}
function fmtPace(secPerM){
  if(!isFinite(secPerM) || secPerM<=0) return '—';
  const secPerUnit = unitSystem === 'mi' ? secPerM/MI_PER_M : secPerM*1000;
  const min = Math.floor(secPerUnit/60), sec = Math.round(secPerUnit%60);
  return min+':'+String(sec).padStart(2,'0')+(unitSystem==='mi' ? ' /mi' : ' /km');
}

/* ==================== FIT file export ==================== */

// Standard FIT CRC-16 (nibble-wise table from the Garmin FIT SDK).
const FIT_CRC_TABLE = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,
  0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400];
function fitCrc16(bytes){
  let crc = 0;
  for(const byte of bytes){
    let tmp = FIT_CRC_TABLE[crc & 0xF];
    crc = (crc>>4) & 0x0FFF;
    crc = crc ^ tmp ^ FIT_CRC_TABLE[byte & 0xF];
    tmp = FIT_CRC_TABLE[crc & 0xF];
    crc = (crc>>4) & 0x0FFF;
    crc = crc ^ tmp ^ FIT_CRC_TABLE[(byte>>4) & 0xF];
  }
  return crc;
}

// Little-endian byte sink, so message sizes never have to be precomputed.
function fitWriter(){
  const bytes = [];
  return {
    bytes,
    u8(v){ bytes.push(v & 0xFF); },
    u16(v){ bytes.push(v & 0xFF, (v>>8) & 0xFF); },
    u32(v){ v = v>>>0; bytes.push(v & 0xFF, (v>>>8) & 0xFF, (v>>>16) & 0xFF, (v>>>24) & 0xFF); },
    i32(v){ this.u32(v); },
    // fields: [[fieldNum, sizeBytes, baseType], ...]
    define(localType, globalNum, fields){
      this.u8(0x40 | localType);
      this.u8(0);                  // reserved
      this.u8(0);                  // little-endian
      this.u16(globalNum);
      this.u8(fields.length);
      for(const [num, size, base] of fields){ this.u8(num); this.u8(size); this.u8(base); }
    },
    header(localType){ this.u8(localType & 0x0F); }
  };
}

const FIT_UINT16 = 0x84, FIT_UINT32 = 0x86, FIT_SINT32 = 0x85, FIT_ENUM = 0x00;

// Builds a FIT activity file: file_id + record messages carrying the original
// timestamp/position plus the corrected cumulative distance in the standard
// `distance` field, followed by the lap/session/activity messages that the FIT
// spec requires of an activity file. Strava (and Garmin Connect) will accept
// the upload but hang partway through processing if those are missing.
function buildCorrectedFit(samples){
  const SEMI = 2147483648/180;
  const first = samples[0], last = samples[samples.length-1];
  const fitTime = u => Math.round(u - FIT_EPOCH_OFFSET) >>> 0;
  const startTime = fitTime(first.tUnix), endTime = fitTime(last.tUnix);
  const elapsedMs = Math.max(0, Math.round((last.tUnix - first.tUnix)*1000));
  const totalCm = Math.max(0, Math.round(last.distM*100));

  const w = fitWriter();

  // file_id (global 0), local type 0 — identifies this as an activity file
  w.define(0, 0, [[0,1,FIT_ENUM],[1,2,FIT_UINT16],[4,4,FIT_UINT32]]);
  w.header(0);
  w.u8(4);              // type = activity
  w.u16(255);           // manufacturer = development
  w.u32(startTime);     // time_created

  // record (global 20), local type 1
  w.define(1, 20, [[253,4,FIT_UINT32],[0,4,FIT_SINT32],[1,4,FIT_SINT32],[5,4,FIT_UINT32]]);
  for(const s of samples){
    w.header(1);
    w.u32(fitTime(s.tUnix));
    w.i32(Math.round(s.lat*SEMI));
    w.i32(Math.round(s.lon*SEMI));
    w.u32(Math.max(0, Math.round(s.distM*100)));
  }

  // lap (global 19), local type 2 — one lap spanning the whole activity
  w.define(2, 19, [[254,2,FIT_UINT16],[253,4,FIT_UINT32],[0,1,FIT_ENUM],[1,1,FIT_ENUM],
                   [2,4,FIT_UINT32],[7,4,FIT_UINT32],[8,4,FIT_UINT32],[9,4,FIT_UINT32]]);
  w.header(2);
  w.u16(0);             // message_index
  w.u32(endTime);       // timestamp
  w.u8(9);              // event = lap
  w.u8(1);              // event_type = stop
  w.u32(startTime);     // start_time
  w.u32(elapsedMs);     // total_elapsed_time (ms)
  w.u32(elapsedMs);     // total_timer_time (ms)
  w.u32(totalCm);       // total_distance (cm)

  // session (global 18), local type 3
  w.define(3, 18, [[254,2,FIT_UINT16],[253,4,FIT_UINT32],[0,1,FIT_ENUM],[1,1,FIT_ENUM],
                   [2,4,FIT_UINT32],[5,1,FIT_ENUM],[6,1,FIT_ENUM],[7,4,FIT_UINT32],
                   [8,4,FIT_UINT32],[9,4,FIT_UINT32],[25,2,FIT_UINT16],[26,2,FIT_UINT16]]);
  w.header(3);
  w.u16(0);             // message_index
  w.u32(endTime);       // timestamp
  w.u8(8);              // event = session
  w.u8(1);              // event_type = stop
  w.u32(startTime);     // start_time
  w.u8(1);              // sport = running
  w.u8(0);              // sub_sport = generic
  w.u32(elapsedMs);     // total_elapsed_time
  w.u32(elapsedMs);     // total_timer_time
  w.u32(totalCm);       // total_distance
  w.u16(0);             // first_lap_index
  w.u16(1);             // num_laps

  // activity (global 34), local type 4
  w.define(4, 34, [[253,4,FIT_UINT32],[0,4,FIT_UINT32],[1,2,FIT_UINT16],
                   [2,1,FIT_ENUM],[3,1,FIT_ENUM],[4,1,FIT_ENUM]]);
  w.header(4);
  w.u32(endTime);       // timestamp
  w.u32(elapsedMs);     // total_timer_time
  w.u16(1);             // num_sessions
  w.u8(0);              // type = manual
  w.u8(26);             // event = activity
  w.u8(1);              // event_type = stop

  const dataSize = w.bytes.length;
  const buf = new ArrayBuffer(12 + dataSize + 2);
  const dv = new DataView(buf);
  const out = new Uint8Array(buf);
  dv.setUint8(0, 12);                        // header size
  dv.setUint8(1, 0x10);                      // protocol version 1.0
  dv.setUint16(2, 100, true);                // profile version (arbitrary)
  dv.setUint32(4, dataSize, true);
  '.FIT'.split('').forEach((ch,i) => dv.setUint8(8+i, ch.charCodeAt(0)));
  out.set(w.bytes, 12);
  dv.setUint16(12+dataSize, fitCrc16(new Uint8Array(buf, 0, 12+dataSize)), true);
  return buf;
}


return {
  // FIT parsing / export
  parseFit, buildCorrectedFit, buildExportSamples, fitCrc16, FIT_EPOCH_OFFSET,
  // geometry
  projectENU, unprojectENU, estimateGpsNoiseStd, median,
  // signal processing
  splitSegments, resampleUniform, kalman1D, kalmanRTSSmooth1D,
  centralDiffVelocity, autocorrelate, shipHeadingSeries,
  detrendPath, segmentShipFramePath, shipFramePath,
  // correction
  runSegmentPipeline, runFullCorrection,
  // synthetic scenarios / tuning
  generateSyntheticScenario, gridSearchKalmanParams, mulberry32, GRID_SEARCH_SCENARIOS,
  // formatting
  fmtDist, fmtPace,
  getUnitSystem(){ return unitSystem; },
  setUnitSystem(u){ unitSystem = (u === 'mi') ? 'mi' : 'km'; }
};
});
