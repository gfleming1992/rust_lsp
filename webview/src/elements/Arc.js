import { Xform } from "../index.js";
import { Base2DItem } from "../core/Base2DItem.js";

// Arc tessellated into a thick polyline (quad strip). For simplicity, build as triangle list.
export class Arc extends Base2DItem {
  constructor({ startX, startY, endX, endY, centerX, centerY, clockwise=false, width=1, color=[0,0,0,1], xform=null }) {
    super();
    this.startX=startX; this.startY=startY; this.endX=endX; this.endY=endY; this.centerX=centerX; this.centerY=centerY;
    this.clockwise=!!clockwise; this.width=width; this.color=color; this.xform=xform || new Xform();
    // LOD caches
    this._lodStepCounts = null; // array of segment counts (index 0 = full detail)
    this._lodTolerances = null; // approximate sagitta error per LOD (world units)
    this._cpuVertsLOD = [];
    this._cpuIndicesLOD = [];
    this._lastUsedLOD = -1;
  }

  static allowedScreenErrorPx = 0.75; // can sync with Polyline.allowedScreenErrorPx externally if desired

  _ensureLODs() {
    if (this._lodStepCounts) return;
    const cx=this.centerX, cy=this.centerY;
    const sAng = Math.atan2(this.startY - cy, this.startX - cx);
    const eAng = Math.atan2(this.endY - cy, this.endX - cx);
    let delta = eAng - sAng;
    if (this.clockwise) { if (delta > 0) delta -= Math.PI*2; } else { if (delta < 0) delta += Math.PI*2; }
    const fullSteps = Math.max(8, Math.ceil(Math.abs(delta) * 16));
    // Build descending detail list: full, /2, /4, ... until <=8
    const stepCounts = [];
    let sc = fullSteps;
    while (sc >= 8) { stepCounts.push(sc); sc = Math.floor(sc/2); }
    if (stepCounts[stepCounts.length-1] !== 8) stepCounts.push(8);
    // Approximate sagitta error for each step setting: s = r - r*cos(a/2)
    const r = Math.hypot(this.startX - cx, this.startY - cy);
    const tolerances = [];
    for (const steps of stepCounts) {
      const a = Math.abs(delta) / steps; // angle per segment
      const sag = r * (1 - Math.cos(a/2));
      tolerances.push(sag);
    }
    // Sort ascending tolerance (highest detail first has smallest sag). We want tolerances ascending.
    // Current order: stepCounts descending -> sag descending? Actually fewer steps => bigger a => bigger sag.
    // Our loop made stepCounts: fullSteps, full/2, ... decreasing => a increases => sag increases.
    // So tolerances already ascending index 0 smallest -> good.
    this._lodStepCounts = stepCounts;
    this._lodTolerances = tolerances;
    // Mark dirty so first build triggers upload.
  }

  _ensureExpandedGeometry(device, lodIndex) {
    this._ensureLODs();
    if (lodIndex >= this._lodStepCounts.length) lodIndex = this._lodStepCounts.length - 1;
    if (this._cpuVertsLOD[lodIndex] && this._cpuIndicesLOD[lodIndex]) return;
    const cx=this.centerX, cy=this.centerY;
    const sAng = Math.atan2(this.startY - cy, this.startX - cx);
    const eAng = Math.atan2(this.endY - cy, this.endX - cx);
    let delta = eAng - sAng;
    if (this.clockwise) { if (delta > 0) delta -= Math.PI*2; } else { if (delta < 0) delta += Math.PI*2; }
    const steps = this._lodStepCounts[lodIndex];
    const outer=[]; const inner=[];
    const r = Math.hypot(this.startX - cx, this.startY - cy);
    const w = this.width * 0.5;
    for (let i=0;i<=steps;i++) {
      const t=i/steps; const ang = sAng + delta * t;
      const x = cx + Math.cos(ang)*r; const y = cy + Math.sin(ang)*r;
      const nx = (x - cx)/r, ny=(y - cy)/r;
      outer.push(x + nx*w, y + ny*w);
      inner.push(x - nx*w, y - ny*w);
    }
    const verts = new Float32Array(outer.length + inner.length);
    verts.set(outer,0); verts.set(inner, outer.length);
    const idx=[];
    for (let i=0;i<steps;i++) {
      const a=i, b=i+1, c=(i+1)+(steps+1), d=i+(steps+1);
      idx.push(a,b,c, a,c,d);
    }
    this._cpuVertsLOD[lodIndex] = verts;
    this._cpuIndicesLOD[lodIndex] = new Uint32Array(idx);
  }

  _getLODForZoom(zoom) {
    this._ensureLODs();
    const threshold = Arc.allowedScreenErrorPx / Math.max(zoom,1e-6);
    let choice = 0;
    for (let i=1;i<this._lodTolerances.length;i++) {
      if (this._lodTolerances[i] <= threshold) choice = i; else break; }
    return choice;
  }

  build(device, { zoom=1 } = {}) {
    const lodIndex = this._getLODForZoom(zoom);
    this._ensureExpandedGeometry(device, lodIndex);
    if (lodIndex === this._lastUsedLOD && !this.dirty) return;
    const v = this._cpuVertsLOD[lodIndex];
    const id = this._cpuIndicesLOD[lodIndex];
    this.vertexBuffer = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, v);
    this.indexBuffer = device.createBuffer({ size: id.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, id);
    this.indexCount = id.length; this.indexFormat='uint32';
    this._lastUsedLOD = lodIndex; this.dirty=false;
    if (!this._cpuVerts) { this._cpuVerts = this._cpuVertsLOD[0]; this._cpuIndices = this._cpuIndicesLOD[0]; }
  }

  draw({ device, pass, pipelines, view, zoom=1 }) {
    this.build(device, { zoom });
    this.ensureUniformBuffer(device);
    this.writeUniforms(device, this.color, this.xform.toMat3(), view);
    this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);

    pass.setPipeline(pipelines.pipelineArc);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, this.indexFormat || 'uint16');
    pass.setBindGroup(0, this.bindGroup);
    pass.drawIndexed(this.indexCount);
  }
}
