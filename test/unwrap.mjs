// Checks Volume.unwrap(): a part that wrapped around in an MRI scan is moved back.
//   node test/unwrap.mjs
// Uses a made-up head (an ellipsoid with a nose), no scan data.
import { Volume, display } from '../public/js/volume.js';

const NX = 96, NY = 128, NZ = 64, PS = 2; // 2 mm voxels; x = left, y = back (rows), z = up
let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };

/** Brightness of the made-up head at a point (mm, head center at 0,0,0; nose toward -y). */
function head(x, y, z) {
  if ((x / 70) ** 2 + (y / 90) ** 2 + (z / 55) ** 2 <= 1) return 600;
  if (Math.abs(x) < 14 && Math.abs(z + 10) < 14 && y < 0 && y > -118) return 500; // nose: sticks out to y = -118
  return 8;
}
/** A stack whose measured box starts at `front` mm (y of the first row); what lies outside the box wraps around. */
function stack(front, neckCut = false, blankEdges = false) {
  const buffer = new Int16Array(NX * NY * NZ), boxY = NY * PS;
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const x = (i - NX / 2) * PS, z = (k - NZ / 2) * PS + (neckCut ? 40 : 0), yIn = front + j * PS;
    // the scanner cannot tell y from y + box or y - box: all of them land in this voxel
    let v = 0;
    for (const y of [yIn - boxY, yIn, yIn + boxY]) v = Math.max(v, head(x, y, z));
    buffer[(k * NY + j) * NX + i] = blankEdges && (j === 0 || j >= NY - 2) ? 0 : v; // some scanners blank the outermost planes
  }
  const frames = Array.from({ length: NZ }, (_, k) => ({ ipp: [-(NX / 2) * PS, front, (k - NZ / 2) * PS], iop: [1, 0, 0, 0, 1, 0], ps: [PS, PS] }));
  return { cols: NX, rows: NY, n: NZ, buffer, frames, desc: { ps: [PS, PS], layout: 'regular' }, unit: '', uid: 1 };
}

// 1. the box starts 100 mm in front of the head center: the last 18 mm of the nose stick out and wrap to the back
const wrapped = new Volume(stack(-100));
ok(wrapped.unwrapped.length === 1 && wrapped.unwrapped[0] === 1, `a wrapped nose is found along the rows (${JSON.stringify(wrapped.unwrapped)})`);
const tip = wrapped.sample([0, -112, -10]), behind = wrapped.sample([0, 80, -10]), skull = wrapped.sample([0, 60, 0]), air = wrapped.sample([0, -116, 30]);
ok(tip > 400, `the nose tip is back in front of the face (${Math.round(tip)} at y = -112 mm)`);
ok(behind > 400 && skull > 500, 'the head itself has not moved');
ok(!(air > 100), 'and there is air next to the nose tip');
ok(stack(-100).buffer !== wrapped.data, 'the stack\'s own pictures are left alone (a copy was rotated)');

// 2. the whole head fits: nothing to do
const whole = new Volume(stack(-130));
ok(whole.unwrapped.length === 0 && whole.origin[1] === -130, 'a scan that fits in its box is not touched');

// 3. the box cuts through the neck at the bottom (tissue at one end only): nothing to do
const neck = new Volume(stack(-130, true));
ok(neck.unwrapped.length === 0, 'a head cut off at the bottom of the box is not taken for wrap-around');

// 3b. the scanner blanked the planes at the edges of its box: no slit is left where the piece rejoins
const blanked = new Volume(stack(-100, false, true));
const along = [-96, -98, -100, -102, -104, -106].map((y) => Math.round(blanked.sample([0, y, -10])));
ok(blanked.unwrapped.length === 1 && along.every((v) => v > 400), `with blank edge planes the piece is moved up against the face, no slit (${along.join(' ')})`);

// 4. switched off
display.unwrap = false;
const off = new Volume(stack(-100));
ok(off.unwrapped.length === 0 && off.origin[1] === -100 && !(off.sample([0, -112, -10]) > 100), 'with the switch off the scan is shown as it was made');

console.log(failed ? `${failed} problem(s)` : 'all good');
process.exit(failed ? 1 : 0);
