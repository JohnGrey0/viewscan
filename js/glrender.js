// glrender.js — one shared WebGL2 context that renders volume slices (MPR, with
// optional slab MIP and segmentation overlay), ray-cast 3-D views and meshes.
// Views own plain 2-D canvases; each render is drawn here and blitted across,
// so the (large) volume texture lives on the GPU only once.

const VS_FULL = `#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const VOL = `
precision highp float; precision highp int; precision highp sampler3D; precision highp isampler3D; precision highp usampler3D;
uniform SAMPLER uVol; uniform ivec3 uDims; uniform mat4 uW2I;
float fetchV(ivec3 p){ return float(texelFetch(uVol, clamp(p, ivec3(0), uDims - 1), 0).r); }
float tri(vec3 x){
  vec3 f = floor(x); vec3 t = x - f; ivec3 p = ivec3(f);
  float c000 = fetchV(p), c100 = fetchV(p + ivec3(1,0,0)), c010 = fetchV(p + ivec3(0,1,0)), c110 = fetchV(p + ivec3(1,1,0));
  float c001 = fetchV(p + ivec3(0,0,1)), c101 = fetchV(p + ivec3(1,0,1)), c011 = fetchV(p + ivec3(0,1,1)), c111 = fetchV(p + ivec3(1,1,1));
  return mix(mix(mix(c000, c100, t.x), mix(c010, c110, t.x), t.y), mix(mix(c001, c101, t.x), mix(c011, c111, t.x), t.y), t.z);
}
bool inside(vec3 x){ return all(greaterThanEqual(x, vec3(-0.5))) && all(lessThanEqual(x, vec3(uDims) - 0.5)); }
`;

const FS_SLICE = `#version 300 es
${VOL}
in vec2 vUV; out vec4 o;
uniform vec3 uCenter, uU, uV, uN; uniform vec2 uSize;
uniform float uWC, uWW, uSlab; uniform int uInvert, uSlabMode, uSlabN;
uniform usampler3D uLab; uniform int uHasLab; uniform mat4 uW2L; uniform ivec3 uLabDims; uniform vec4 uLabCol[8];
uniform usampler3D uFix; uniform int uHasFix;
void main(){
  vec2 px = (vUV - 0.5) * uSize;
  vec3 P = uCenter + px.x * uU + px.y * uV;
  vec3 i0 = (uW2I * vec4(P, 1.0)).xyz;
  float val = 0.0; bool any = false;
  if (uSlabN <= 1) { if (inside(i0)) { val = tri(i0); any = true; } }
  else {
    vec3 di = mat3(uW2I) * uN;
    float acc = uSlabMode == 1 ? -1e9 : (uSlabMode == 2 ? 1e9 : 0.0); float cnt = 0.0;
    for (int s = 0; s < 96; s++) {
      if (s >= uSlabN) break;
      vec3 x = i0 + di * ((float(s) / float(uSlabN - 1) - 0.5) * uSlab);
      if (!inside(x)) continue;
      float v = tri(x); any = true; cnt += 1.0;
      if (uSlabMode == 1) acc = max(acc, v); else if (uSlabMode == 2) acc = min(acc, v); else acc += v;
    }
    val = uSlabMode == 0 ? acc / max(cnt, 1.0) : acc;
  }
  if (!any) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float g = clamp((val - (uWC - 0.5 * uWW)) / max(uWW, 1e-6), 0.0, 1.0);
  if (uInvert == 1) g = 1.0 - g;
  vec3 c = vec3(g);
  if (uHasLab == 1) {
    ivec3 lp = ivec3(floor((uW2L * vec4(P, 1.0)).xyz + 0.5));
    if (all(greaterThanEqual(lp, ivec3(0))) && all(lessThan(lp, uLabDims))) {
      uint l = texelFetch(uLab, lp, 0).r;
      for (int b = 0; b < 8; b++) if ((l & (1u << uint(b))) != 0u) c = mix(c, uLabCol[b].rgb, uLabCol[b].a);
    }
  }
  if (uHasFix == 1) {
    // marks made by hand, on the scan's own grid: green = brain, orange = not brain
    ivec3 fp = ivec3(floor(i0 + 0.5));
    if (all(greaterThanEqual(fp, ivec3(0))) && all(lessThan(fp, uDims))) {
      uint f = texelFetch(uFix, fp, 0).r;
      if (f == 1u) c = mix(c, vec3(0.2, 0.95, 0.4), 0.55); else if (f == 2u) c = mix(c, vec3(1.0, 0.55, 0.1), 0.55);
    }
  }
  o = vec4(c, 1.0);
}`;

const FS_RAY = `#version 300 es
${VOL}
in vec2 vUV; out vec4 o;
uniform vec3 uCenter, uU, uV, uDir, uColor; uniform vec2 uSize;
uniform float uRadius, uStep, uIso, uWC, uWW; uniform int uMode;
void main(){
  vec2 px = (vUV - 0.5) * uSize;
  vec3 O = uCenter + px.x * uU + px.y * uV - uDir * uRadius;
  vec3 io = (uW2I * vec4(O, 1.0)).xyz; vec3 id = mat3(uW2I) * uDir;
  id += (1.0 - step(1e-7, abs(id))) * 1e-7;
  vec3 ta = (vec3(-0.5) - io) / id, tb = (vec3(uDims) - 0.5 - io) / id;
  vec3 tmn = min(ta, tb), tmx = max(ta, tb);
  float t0 = max(max(tmn.x, tmn.y), max(tmn.z, 0.0)), t1 = min(min(tmx.x, tmx.y), min(tmx.z, 2.0 * uRadius));
  vec3 bg = mix(vec3(0.07, 0.09, 0.14), vec3(0.02, 0.03, 0.05), vUV.y);
  if (t0 >= t1) { o = vec4(bg, 1.0); return; }
  float t = t0 + fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * uStep;
  if (uMode == 0) {
    float m = -1e9;
    for (int i = 0; i < 1600; i++) { if (t > t1) break; m = max(m, tri(io + id * t)); t += uStep; }
    float g = clamp((m - (uWC - 0.5 * uWW)) / max(uWW, 1e-6), 0.0, 1.0);
    o = vec4(vec3(g), 1.0); return;
  }
  bool hit = false; float prev = t0;
  for (int i = 0; i < 1600; i++) {
    if (t > t1) break;
    if (fetchV(ivec3(floor(io + id * t + 0.5))) >= uIso) { hit = true; break; }
    prev = t; t += uStep;
  }
  if (!hit) { o = vec4(bg, 1.0); return; }
  float a = prev, b = t;
  for (int k = 0; k < 6; k++) { float m = 0.5 * (a + b); if (tri(io + id * m) >= uIso) b = m; else a = m; }
  vec3 x = io + id * b;
  vec3 gi = vec3(tri(x + vec3(1,0,0)) - tri(x - vec3(1,0,0)), tri(x + vec3(0,1,0)) - tri(x - vec3(0,1,0)), tri(x + vec3(0,0,1)) - tri(x - vec3(0,0,1)));
  vec3 n = -normalize(transpose(mat3(uW2I)) * gi + 1e-9);
  float diff = max(dot(n, -uDir), 0.0);
  vec3 h = normalize(-uDir + normalize(-uDir - 0.4 * normalize(uU) - 0.5 * normalize(uV)));
  float spec = pow(max(dot(n, h), 0.0), 40.0);
  float depth = 1.0 - 0.35 * clamp((b - t0) / (2.0 * uRadius), 0.0, 1.0);
  o = vec4(uColor * (0.18 + 0.82 * diff) * depth + vec3(0.25) * spec, 1.0);
}`;

const VS_MESH = `#version 300 es
in vec3 aPos; in vec3 aNor;
uniform vec3 uCenter, uR, uD, uF; uniform vec2 uHalf; uniform float uRadius;
out vec3 vN; out vec3 vW;
void main(){
  vec3 p = aPos - uCenter;
  gl_Position = vec4(dot(p, uR) / uHalf.x, -dot(p, uD) / uHalf.y, dot(p, uF) / (uRadius * 4.0), 1.0);
  vN = vec3(dot(aNor, uR), dot(aNor, uD), dot(aNor, uF)); vW = aPos;
}`;
const FS_MESH = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; out vec4 o;
uniform vec3 uColor; uniform float uOpacity; uniform vec4 uClip; uniform int uUseClip;
void main(){
  if (uUseClip == 1 && dot(vW, uClip.xyz) > uClip.w) discard;
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  float diff = max(-n.z, 0.0);
  vec3 h = normalize(vec3(-0.35, -0.45, -1.0));
  float spec = pow(max(dot(n, h), 0.0), 36.0);
  vec3 c = uColor * (0.22 + 0.78 * diff) + vec3(0.22) * spec;
  if (!gl_FrontFacing) c *= 0.55;
  o = vec4(c, uOpacity);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

export class GLRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 16; this.canvas.height = 16;
    const gl = this.canvas.getContext('webgl2', { antialias: true, depth: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.progs = {};
    this.vol = null; this.volTex = null; this.volFloat = false;
    this.lab = null; this.labTex = null;
    this.fix = null; this.fixTex = null;
    this.meshBuf = new WeakMap();
    this.vao = gl.createVertexArray();
    this.maxTex = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.vol = null; this.lab = null; this.fix = null; this.progs = {}; });
  }
  prog(kind) {
    const key = kind + (this.volFloat ? 'F' : 'I');
    if (!this.progs[key]) {
      const def = (src) => src.replace(/SAMPLER/g, this.volFloat ? 'sampler3D' : 'isampler3D');
      if (kind === 'slice') this.progs[key] = program(this.gl, VS_FULL, def(FS_SLICE));
      else if (kind === 'ray') this.progs[key] = program(this.gl, VS_FULL, def(FS_RAY));
    }
    return this.progs[key];
  }
  supports(vol) { return Math.max(vol.nx, vol.ny, vol.nz) <= this.maxTex; }

  setVolume(vol) {
    if (this.vol === vol) return;
    const gl = this.gl;
    if (this.volTex) gl.deleteTexture(this.volTex);
    this.volTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.volFloat = vol.isFloat;
    if (vol.isFloat) gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, vol.nx, vol.ny, vol.nz, 0, gl.RED, gl.FLOAT, vol.data);
    else gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16I, vol.nx, vol.ny, vol.nz, 0, gl.RED_INTEGER, gl.SHORT, vol.data);
    this.vol = vol;
    this.w2i = vol.worldToIndexMatrix();
  }

  /** Segmentation overlay: { data: Uint8Array bitmask, dims:[x,y,z], w2i: Float32Array(16), version } or null. */
  setLabels(lab) {
    const gl = this.gl;
    if (!lab) { this.lab = null; return; }
    if (this.lab === lab && this.labVersion === lab.version) return;
    if (this.labTex) gl.deleteTexture(this.labTex);
    this.labTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.labTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, lab.dims[0], lab.dims[1], lab.dims[2], 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, lab.data);
    this.lab = lab; this.labVersion = lab.version;
  }

  /** Marks made by hand (fixes.js): { data: Uint8Array, dims, version } on the volume's own grid, or null. */
  setFix(fix) {
    const gl = this.gl;
    if (!fix) { this.fix = null; return; }
    if (this.fix === fix && this.fixVersion === fix.version) return;
    gl.activeTexture(gl.TEXTURE2);
    if (this.fix !== fix || !this.fixTex) {
      if (this.fixTex) gl.deleteTexture(this.fixTex);
      this.fixTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.fixTex);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    } else gl.bindTexture(gl.TEXTURE_3D, this.fixTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, fix.dims[0], fix.dims[1], fix.dims[2], 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, fix.data);
    this.fix = fix; this.fixVersion = fix.version;
  }

  begin(w, h) {
    const gl = this.gl, c = this.canvas;
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
    gl.viewport(0, c.height - h, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, c.height - h, w, h);
  }
  blit(ctx, w, h, dw = w, dh = h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = dw !== w;
    ctx.drawImage(this.canvas, 0, 0, w, h, 0, 0, dw, dh);
  }
  bindVolume(pr) {
    const gl = this.gl, v = this.vol;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.uniform1i(pr.u.uVol, 0);
    gl.uniform3i(pr.u.uDims, v.nx, v.ny, v.nz);
    gl.uniformMatrix4fv(pr.u.uW2I, false, this.w2i);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  }

  /**
   * Draw one reformatted plane.
   * @param p { center, u, v, n (world; u,v are per-pixel steps), wc, ww, invert, slab (mm), slabMode, labelColors }
   */
  drawSlice(ctx, w, h, p) {
    const gl = this.gl, pr = this.prog('slice');
    this.begin(w, h);
    this.bindVolume(pr);
    const u = pr.u;
    gl.uniform3fv(u.uCenter, p.center); gl.uniform3fv(u.uU, p.u); gl.uniform3fv(u.uV, p.v); gl.uniform3fv(u.uN, p.n);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform1f(u.uWC, p.wc); gl.uniform1f(u.uWW, p.ww); gl.uniform1i(u.uInvert, p.invert ? 1 : 0);
    const minSp = Math.min(...this.vol.spacing);
    const nSlab = p.slab > 0 ? Math.min(96, Math.max(2, Math.ceil(p.slab / (minSp * 0.75)) + 1)) : 1;
    gl.uniform1f(u.uSlab, p.slab || 0); gl.uniform1i(u.uSlabN, nSlab); gl.uniform1i(u.uSlabMode, p.slabMode || 0);
    const lab = this.lab && p.labelColors ? this.lab : null;
    gl.uniform1i(u.uHasLab, lab ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lab ? this.labTex : null);
    gl.uniform1i(u.uLab, 1);
    if (lab) {
      gl.uniformMatrix4fv(u.uW2L, false, lab.w2i);
      gl.uniform3i(u.uLabDims, lab.dims[0], lab.dims[1], lab.dims[2]);
      gl.uniform4fv(u.uLabCol, p.labelColors);
    }
    const fix = this.fix && this.fix.dims[0] === this.vol.nx && this.fix.dims[1] === this.vol.ny && this.fix.dims[2] === this.vol.nz ? this.fix : null;
    gl.uniform1i(u.uHasFix, fix ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, fix ? this.fixTex : null);
    gl.uniform1i(u.uFix, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blit(ctx, w, h);
  }

  /**
   * Ray-cast the volume. cam: { center, r, d, f (unit world axes: right, down, into screen), zoom (mm per px) }
   * opts: { mode: 'mip'|'surface', iso, wc, ww, color, quality (0..1 resolution scale) }
   */
  drawRaycast(ctx, w, h, cam, opts) {
    const gl = this.gl, pr = this.prog('ray');
    const q = opts.quality || 1;
    const rw = Math.max(8, Math.round(w * q)), rh = Math.max(8, Math.round(h * q));
    this.begin(rw, rh);
    this.bindVolume(pr);
    const u = pr.u, s = cam.zoom / q;
    gl.uniform3fv(u.uCenter, cam.center);
    gl.uniform3f(u.uU, cam.r[0] * s, cam.r[1] * s, cam.r[2] * s);
    gl.uniform3f(u.uV, cam.d[0] * s, cam.d[1] * s, cam.d[2] * s);
    gl.uniform3fv(u.uDir, cam.f);
    gl.uniform2f(u.uSize, rw, rh);
    gl.uniform1f(u.uRadius, this.vol.radius);
    gl.uniform1f(u.uStep, Math.min(...this.vol.spacing) * (q < 1 ? 1.2 : 0.7));
    gl.uniform1f(u.uIso, opts.iso); gl.uniform1f(u.uWC, opts.wc); gl.uniform1f(u.uWW, opts.ww);
    gl.uniform1i(u.uMode, opts.mode === 'mip' ? 0 : 1);
    gl.uniform3fv(u.uColor, opts.color || [0.93, 0.89, 0.8]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blit(ctx, rw, rh, w, h);
  }

  meshBuffers(m) {
    let b = this.meshBuf.get(m);
    if (b) return b;
    const gl = this.gl;
    if (!this.progs.mesh) this.progs.mesh = program(gl, VS_MESH, FS_MESH);
    const pr = this.progs.mesh;
    b = { vao: gl.createVertexArray(), count: m.indices.length };
    gl.bindVertexArray(b.vao);
    const mk = (data, name) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr.p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      return buf;
    };
    b.pos = mk(m.positions, 'aPos'); b.nor = mk(m.normals, 'aNor');
    b.idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshBuf.set(m, b);
    return b;
  }
  freeMesh(m) {
    const b = this.meshBuf.get(m);
    if (!b) return;
    const gl = this.gl;
    gl.deleteBuffer(b.pos); gl.deleteBuffer(b.nor); gl.deleteBuffer(b.idx); gl.deleteVertexArray(b.vao);
    this.meshBuf.delete(m);
  }

  /** Draw surface meshes: [{ mesh:{positions,normals,indices}, color:[r,g,b], opacity }] */
  drawMeshes(ctx, w, h, cam, items, radius, clip) {
    const gl = this.gl;
    if (!this.progs.mesh) this.progs.mesh = program(gl, VS_MESH, FS_MESH);
    const pr = this.progs.mesh, u = pr.u;
    this.begin(w, h);
    gl.clearColor(0.045, 0.06, 0.1, 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(pr.p);
    gl.uniform3fv(u.uCenter, cam.center); gl.uniform3fv(u.uR, cam.r); gl.uniform3fv(u.uD, cam.d); gl.uniform3fv(u.uF, cam.f);
    gl.uniform2f(u.uHalf, cam.zoom * w / 2, cam.zoom * h / 2);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform1i(u.uUseClip, clip ? 1 : 0);
    if (clip) gl.uniform4fv(u.uClip, clip);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    const draw = (it) => {
      const b = this.meshBuffers(it.mesh);
      gl.bindVertexArray(b.vao);
      gl.uniform3fv(u.uColor, it.color); gl.uniform1f(u.uOpacity, it.opacity);
      gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
    };
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const it of items) if (it.opacity >= 0.99) draw(it);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    for (const it of items) if (it.opacity < 0.99) draw(it);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null);
    this.blit(ctx, w, h);
  }
}
