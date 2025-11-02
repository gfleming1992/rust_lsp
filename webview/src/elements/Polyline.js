import { Xform } from "../index.js";
import { Base2DItem } from "../core/Base2DItem.js";

export class Polyline extends Base2DItem {
  constructor({ points, width=1, color=[0,0,0,1], xform=null, miter=true, miterLimit=4, join='miter', cap='round', roundSegments=16 }) {
    super();
    this.points = points; this.width=width; this.color=color; this.xform = xform || new Xform();
    this.miter = miter; this.miterLimit = miterLimit;
    this.join = (join||'miter').toLowerCase(); // 'miter', 'round', or 'bevel'
  this.cap = (cap||'round').toLowerCase();
    this.roundSegments = roundSegments;
    // LOD data
    this._lodPoints = null;          // Array<Array<{x,y}>> original + simplified levels (ascending tolerance)
    this._lodTolerances = null;      // Matching tolerances (0 for original)
    this._cpuVertsLOD = [];          // Expanded stroke verts per LOD
    this._cpuIndicesLOD = [];        // Expanded indices per LOD
    this._lastUsedLOD = -1;          // Cache last LOD used for direct (non-batch) rendering
  }

  // Global configurable screen-space error (in pixels) tolerated before switching to coarser LOD.
  static allowedScreenErrorPx = 0.005; // default; smaller => higher quality (later LOD drop), larger => earlier LOD drop

  // Public: ensure all LOD point sets computed
  ensureLODs() {
    if (this._lodPoints) return;
    const original = this.points;
  if (!original || original.length === 0) { this._lodPoints = [ [] ]; this._lodTolerances=[0]; return; }
    const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of original) { if (p.x<bbox.minX) bbox.minX=p.x; if (p.y<bbox.minY) bbox.minY=p.y; if (p.x>bbox.maxX) bbox.maxX=p.x; if (p.y>bbox.maxY) bbox.maxY=p.y; }
    const dx=bbox.maxX-bbox.minX, dy=bbox.maxY-bbox.minY; const diag = Math.hypot(dx,dy)||1;
    // Base tolerance progression (t0=0 exact). Choose factors ~4x each level until point count small or tolerance fraction reached.
    const baseTol = diag * 0.0005; // adjustable
    const maxTol = diag * 0.02;
    const tolerances = [0];
    while (tolerances[tolerances.length-1] < maxTol && tolerances.length < 6) {
      const next = tolerances.length===1 ? baseTol : tolerances[tolerances.length-1]*4;
      tolerances.push(Math.min(next, maxTol));
    }
    const lodPoints = [original];
    for (let i=1;i<tolerances.length;i++) {
      lodPoints.push(douglasPeucker(original, tolerances[i]));
    }
    this._lodPoints = lodPoints;
    this._lodTolerances = tolerances;
  }

  getLODIndexForZoom(zoom) {
    this.ensureLODs();
  // World error threshold = allowedScreenErrorPx / zoom (approx since uniform scaling)
  const threshold = Polyline.allowedScreenErrorPx / Math.max(zoom, 1e-6);
    // Pick largest tolerance <= threshold; tolerances are ascending
    let choice = 0;
    for (let i=1;i<this._lodTolerances.length;i++) {
      if (this._lodTolerances[i] <= threshold) choice = i; else break;
    }
    return choice;
  }

  // Ensure expanded geometry for particular LOD index
  ensureExpandedGeometry(device, lodIndex) {
    this.ensureLODs();
  if (!this._lodPoints || lodIndex < 0) return;
  if (lodIndex >= this._lodPoints.length) lodIndex = this._lodPoints.length -1;
  if (this._cpuVertsLOD[lodIndex] && this._cpuIndicesLOD[lodIndex]) return;
    // Temporarily build using selected points without mutating this.points permanently
    const saved = this.points;
    this.points = this._lodPoints[lodIndex];
  if (!this.points) { this.points = saved; return; }
    // Force build regardless of global dirty state for that LOD
    const verts=[]; const idx=[];
  const savedCap = this.cap;
  // For higher LODs (coarser) drop expensive round/square caps to reduce vertex count
  if (lodIndex >= 2 && this.cap !== 'butt') this.cap = 'butt';
  this._buildStrokeFromPoints(verts, idx); // internal stroke expansion
  this.cap = savedCap;
    const v = new Float32Array(verts);
    const id = new Uint32Array(idx);
    this._cpuVertsLOD[lodIndex]=v; this._cpuIndicesLOD[lodIndex]=id;
    this.points = saved; // restore
  }

  // Internal previous build logic extracted so we can reuse for each LOD without writing GPU buffers each time.
  _buildStrokeFromPoints(verts, idx) {
    const pts = this.points;
    const n = pts.length;
    const halfW = this.width * 0.5;

    if (n < 2) {
      return; }

    if (!this.miter) {
      // Fallback: independent quads
      for (let i=0;i<n-1;i++) {
        const p0 = pts[i], p1 = pts[i+1];
        const dx = p1.x - p0.x, dy = p1.y - p0.y; const len = Math.hypot(dx,dy)||1;
        const nx = -dy/len, ny = dx/len;
        const a=[p0.x+nx*halfW, p0.y+ny*halfW], b=[p1.x+nx*halfW, p1.y+ny*halfW], c=[p1.x-nx*halfW, p1.y-ny*halfW], d=[p0.x-nx*halfW, p0.y-ny*halfW];
        const base = verts.length/2;
        verts.push(a[0],a[1], b[0],b[1], c[0],c[1], d[0],d[1]);
        idx.push(base+0, base+1, base+2, base+0, base+2, base+3);
      }
  return;
    }

    const segDir = [];
    const segNorm = [];
    const segLen = [];
    for (let i=0;i<n-1;i++) {
      const p0=pts[i], p1=pts[i+1];
      let dx=p1.x-p0.x, dy=p1.y-p0.y; let len=Math.hypot(dx,dy);
      if (len < 1e-12) { segDir.push({x:1,y:0}); segNorm.push({x:0,y:1}); segLen.push(0); continue; }
      dx/=len; dy/=len; segDir.push({x:dx,y:dy}); segNorm.push({x:-dy,y:dx}); segLen.push(len);
    }

    if (this.join === 'round') {
      const pairFrom = (point, normal) => ({
        left: { x: point.x + normal.x * halfW, y: point.y + normal.y * halfW },
        right: { x: point.x - normal.x * halfW, y: point.y - normal.y * halfW }
      });

      const pairs = [];
      pairs.push(pairFrom(pts[0], segNorm[0] || { x: 0, y: 1 }));

      for (let i=0;i<n-1;i++) {
        const endPoint = pts[i+1];
        const currNorm = segNorm[i];
        const endPair = pairFrom(endPoint, currNorm);
        pairs.push(endPair);

        if (i < n-2) {
          const nextNorm = segNorm[i+1];
          const cross = segDir[i].x * segDir[i+1].y - segDir[i].y * segDir[i+1].x;
          if (Math.abs(cross) < 1e-6) {
            continue;
          }

          const isLeftTurn = cross > 0;
          const center = pts[i+1];
          const nextPair = pairFrom(center, nextNorm);

          const outerStart = isLeftTurn ? endPair.left : endPair.right;
          const outerEnd = isLeftTurn ? nextPair.left : nextPair.right;
          const innerStart = isLeftTurn ? endPair.right : endPair.left;
          const innerEnd = isLeftTurn ? nextPair.right : nextPair.left;

          let startAngle = Math.atan2(outerStart.y - center.y, outerStart.x - center.x);
          let endAngle = Math.atan2(outerEnd.y - center.y, outerEnd.x - center.x);
          let sweep = endAngle - startAngle;
          if (isLeftTurn) {
            while (sweep <= 0) sweep += Math.PI * 2;
          } else {
            while (sweep >= 0) sweep -= Math.PI * 2;
          }

          const angleSpan = Math.abs(sweep);
          const numSegs = Math.max(4, Math.ceil(angleSpan / (Math.PI / 18)));

          for (let s = 1; s <= numSegs; s++) {
            const t = s / numSegs;
            const ang = startAngle + sweep * t;
            const outerPoint = {
              x: center.x + Math.cos(ang) * halfW,
              y: center.y + Math.sin(ang) * halfW
            };
            const innerPoint = {
              x: innerStart.x + (innerEnd.x - innerStart.x) * t,
              y: innerStart.y + (innerEnd.y - innerStart.y) * t
            };
            if (isLeftTurn) {
              pairs.push({ left: outerPoint, right: innerPoint });
            } else {
              pairs.push({ left: innerPoint, right: outerPoint });
            }
          }
        }
      }

      const baseIndex = verts.length / 2;
      for (const pair of pairs) {
        verts.push(pair.left.x, pair.left.y, pair.right.x, pair.right.y);
      }
      for (let i=0;i<pairs.length-1;i++) {
        const base = baseIndex + i*2;
        idx.push(base, base+2, base+3, base, base+3, base+1);
      }

      if (this.cap === 'square') {
        const startPair = pairs[0];
        const endPairCap = pairs[pairs.length-1];
        const d0 = segDir[0];
        const d1 = segDir[segDir.length-1];
        const sShiftX = -d0.x*halfW, sShiftY = -d0.y*halfW;
        const vStart = verts.length/2;
        verts.push(
          startPair.left.x + sShiftX,
          startPair.left.y + sShiftY,
          startPair.right.x + sShiftX,
          startPair.right.y + sShiftY
        );
        idx.push(vStart, baseIndex, baseIndex+1, vStart, baseIndex+1, vStart+1);

        const eShiftX = d1.x*halfW, eShiftY = d1.y*halfW;
        const vEnd = verts.length/2;
        verts.push(
          endPairCap.left.x + eShiftX,
          endPairCap.left.y + eShiftY,
          endPairCap.right.x + eShiftX,
          endPairCap.right.y + eShiftY
        );
        const lastBase = baseIndex + (pairs.length-1)*2;
        idx.push(lastBase, vEnd, vEnd+1, lastBase, vEnd+1, lastBase+1);
      } else if (this.cap === 'round') {
        const segs = Math.max(6, this.roundSegments|0);
        const startDir = segDir[0];
        const startCenter = pts[0];
        const fanStartBase = verts.length/2;
        verts.push(startCenter.x, startCenter.y);
        const startAngle = Math.atan2(startDir.y, startDir.x);
        for (let i=0;i<=segs;i++) {
          const t=i/segs;
          const ang = startAngle + Math.PI/2 + t*Math.PI;
          verts.push(startCenter.x + Math.cos(ang)*halfW, startCenter.y + Math.sin(ang)*halfW);
        }
        for (let i=0;i<segs;i++) idx.push(fanStartBase, fanStartBase+1+i, fanStartBase+2+i);

        const endDir = segDir[segDir.length-1];
        const endCenter = pts[n-1];
        const fanEndBase = verts.length/2;
        verts.push(endCenter.x, endCenter.y);
        const endAngle = Math.atan2(endDir.y, endDir.x);
        for (let i=0;i<=segs;i++) {
          const t=i/segs;
          const ang = endAngle - Math.PI/2 + t*Math.PI;
          verts.push(endCenter.x + Math.cos(ang)*halfW, endCenter.y + Math.sin(ang)*halfW);
        }
        for (let i=0;i<segs;i++) idx.push(fanEndBase, fanEndBase+1+i, fanEndBase+2+i);
      }

      return;
    }

    const left = new Array(n); const right = new Array(n);

    function add(a,b){ return {x:a.x+b.x, y:a.y+b.y}; }
    function norm(v){ const l=Math.hypot(v.x,v.y); return l? {x:v.x/l,y:v.y/l}:{x:0,y:0}; }
    function dot(a,b){ return a.x*b.x + a.y*b.y; }

    for (let i=0;i<n;i++) {
      if (i===0) {
        const n0 = segNorm[0];
        left[i] = { x: pts[i].x + n0.x*halfW, y: pts[i].y + n0.y*halfW };
        right[i]= { x: pts[i].x - n0.x*halfW, y: pts[i].y - n0.y*halfW };
      } else if (i===n-1) {
        const nPrev = segNorm[i-1];
        left[i] = { x: pts[i].x + nPrev.x*halfW, y: pts[i].y + nPrev.y*halfW };
        right[i]= { x: pts[i].x - nPrev.x*halfW, y: pts[i].y - nPrev.y*halfW };
      } else {
        const nPrev = segNorm[i-1];
        const nNext = segNorm[i];
        // Handle nearly straight line: reuse nPrev
        let join = add(nPrev, nNext);
        const joinLenSq = join.x*join.x + join.y*join.y;
        if (joinLenSq < 1e-8) { // 180 degrees
          left[i] = { x: pts[i].x + nPrev.x*halfW, y: pts[i].y + nPrev.y*halfW };
          right[i]= { x: pts[i].x - nPrev.x*halfW, y: pts[i].y - nPrev.y*halfW };
          continue;
        }
        join = norm(join);
        const dp = dot(join, nPrev); // cos of half-angle
        const miterScale = 1 / Math.max(dp, 1e-4); // avoid division by 0
        
        if (this.join === 'bevel' || miterScale > this.miterLimit) {
          // Bevel: use previous and next normals to form two corners
          const mxPrev = nPrev.x*halfW, myPrev = nPrev.y*halfW;
          const mxNext = nNext.x*halfW, myNext = nNext.y*halfW;
          left[i] = { x: pts[i].x + mxPrev, y: pts[i].y + myPrev };
          right[i]= { x: pts[i].x - mxNext, y: pts[i].y - myNext };
        } else {
          // Miter join
          const mx = join.x * halfW * miterScale;
          const my = join.y * halfW * miterScale;
          left[i] = { x: pts[i].x + mx, y: pts[i].y + my };
          right[i]= { x: pts[i].x - mx, y: pts[i].y - my };
        }
      }
    }

    // Build triangle indices (quad per segment from left/right pairs)
    for (let i=0;i<n;i++) {
      verts.push(left[i].x, left[i].y, right[i].x, right[i].y);
    }
    for (let i=0;i<n-1;i++) {
      const base = i*2;
      // Tri 1: left_i, left_{i+1}, right_{i+1}
      // Tri 2: left_i, right_{i+1}, right_i
      idx.push(base, base+2, base+3, base, base+3, base+1);
    }
    if (this.cap === 'square') {
      // Extend start and end by half width along segment tangents: create extra quads
      const halfW = this.width*0.5;
      const d0 = segDir[0]; const d1 = segDir[segDir.length-1];
      // Start extension: build a quad between current first edge and shifted version
      const sShiftX = -d0.x*halfW, sShiftY=-d0.y*halfW;
      const baseVerts = verts.slice(); // reference for current positions
      // Insert new first pair (shifted) then connect
      const L0x = left[0].x + sShiftX, L0y = left[0].y + sShiftY;
      const R0x = right[0].x + sShiftX, R0y = right[0].y + sShiftY;
      // shift existing indexing by adding two vertices at front: easier just push at end and add indices (creates small extra quad overlapping start). Simpler: add extra quad.
      const vStart = verts.length/2;
      verts.push(L0x,L0y,R0x,R0y);
      // Quad between new cap edge (L0x,R0x) and original (left[0],right[0])
      // new edge indices vStart,vStart+1 ; original edge indices 0,1
      idx.push(vStart, 0, 1, vStart, 1, vStart+1);
      // End extension
      const eShiftX = d1.x*halfW, eShiftY=d1.y*halfW;
      const Ln_1x = left[n-1].x + eShiftX, Ln_1y = left[n-1].y + eShiftY;
      const Rn_1x = right[n-1].x + eShiftX, Rn_1y = right[n-1].y + eShiftY;
      const endBase = verts.length/2;
      verts.push(Ln_1x,Ln_1y,Rn_1x,Rn_1y);
      const origL = (n-1)*2; const origR = (n-1)*2+1;
      idx.push(origL, endBase, endBase+1, origL, endBase+1, origR);
  } else if (this.cap === 'round') {
      const halfW = this.width*0.5;
      const r = halfW; const segs = Math.max(6, this.roundSegments|0);
      // Start cap fan
      const d0 = segDir[0];
      const baseAngle0 = Math.atan2(d0.y, d0.x);
      const centerStart = { x: this.points[0].x, y: this.points[0].y };
      const fanStartBase = verts.length/2;
      verts.push(centerStart.x, centerStart.y);
      for (let i=0;i<=segs;i++) {
        const t=i/segs; const ang = baseAngle0 + Math.PI/2 + t*Math.PI; // sweep behind start (-direction)
        verts.push(centerStart.x + Math.cos(ang)*r, centerStart.y + Math.sin(ang)*r);
      }
      for (let i=0;i<segs;i++) idx.push(fanStartBase, fanStartBase+1+i, fanStartBase+2+i);
      // End cap fan
      const d1 = segDir[segDir.length-1];
      const baseAngle1 = Math.atan2(d1.y, d1.x);
      const centerEnd = { x: this.points[this.points.length-1].x, y: this.points[this.points.length-1].y };
      const fanEndBase = verts.length/2;
      verts.push(centerEnd.x, centerEnd.y);
      for (let i=0;i<=segs;i++) {
        const t=i/segs; const ang = baseAngle1 - Math.PI/2 + t*Math.PI; // forward half circle (direction)
        verts.push(centerEnd.x + Math.cos(ang)*r, centerEnd.y + Math.sin(ang)*r);
      }
      for (let i=0;i<segs;i++) idx.push(fanEndBase, fanEndBase+1+i, fanEndBase+2+i);
    }

    // This method only populates verts & idx arrays passed by reference
  }

  build(device, { zoom=1 } = {}) {
    // Determine needed LOD
    const lodIndex = this.getLODIndexForZoom(zoom);
    this.ensureExpandedGeometry(device, lodIndex);
    if (lodIndex === this._lastUsedLOD && !this.dirty) return; // GPU buffers up to date
    // Upload selected LOD geometry to GPU
    const v = this._cpuVertsLOD[lodIndex];
    const id = this._cpuIndicesLOD[lodIndex];
    this.vertexBuffer = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, v);
    this.indexBuffer = device.createBuffer({ size: id.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, id);
    this.indexCount = id.length;
    this.indexFormat = 'uint32';
    this._lastUsedLOD = lodIndex;
    this.dirty = false;
    // Also expose canonical (highest detail) for batching compatibility (LOD 0) if not yet set
    if (!this._cpuVerts) { this._cpuVerts = this._cpuVertsLOD[0]; this._cpuIndices = this._cpuIndicesLOD[0]; }
  }

  draw({ device, pass, pipelines, view, zoom=1, instanceBuffer=null, instanceCount=0 }) {
    this.build(device, { zoom });
    this.ensureUniformBuffer(device);
    this.writeUniforms(device, this.color, this.xform.toMat3(), view);
    this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);

    // Only switch to instanced path if we actually have more than one instance to draw
    // (instance 0 == base geometry). This avoids relying on instanced pipeline for single copy
    // which can help isolate issues if the instanced shader / vertex layout is problematic.
  // Use instanced path for any instanceCount>0 so that a single remaining visible instance
  // (after culling) with a non-zero offset still renders at the correct translated position.
  if (instanceBuffer && instanceCount>0) {
      pass.setPipeline(pipelines.pipelinePolylineInstanced);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setVertexBuffer(1, instanceBuffer);
      pass.setIndexBuffer(this.indexBuffer, this.indexFormat || 'uint16');
      pass.setBindGroup(0, this.bindGroup);
      pass.drawIndexed(this.indexCount, instanceCount);
    } else {
      pass.setPipeline(pipelines.pipelinePolyline);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, this.indexFormat || 'uint16');
      pass.setBindGroup(0, this.bindGroup);
      pass.drawIndexed(this.indexCount);
    }
    if (!this.indexCount) {
      // Lightweight one-time warning to help debug blank canvas situations.
      if (!this._warnedEmpty) {
        console.warn('Polyline drew with zero indices. Width or points may be invalid.', { points: this.points, width: this.width });
        this._warnedEmpty = true;
      }
    }
  }
}

// Douglas-Peucker simplification (iterative) for array of {x,y}
function douglasPeucker(points, tol) {
  if (tol <= 0 || points.length < 3) return points.slice();
  const sqTol = tol*tol;
  const stack = [[0, points.length-1]];
  const keep = new Uint8Array(points.length);
  keep[0]=1; keep[points.length-1]=1;
  function sqSegDist(p, a, b){
    let x=a.x, y=a.y; let dx=b.x - x, dy=b.y - y;
    if (dx!==0 || dy!==0){
      const t=((p.x - x)*dx + (p.y - y)*dy)/(dx*dx+dy*dy);
      if (t>1){ x=b.x; y=b.y; }
      else if (t>0){ x += dx*t; y += dy*t; }
    }
    const rx=p.x - x, ry=p.y - y; return rx*rx+ry*ry;
  }
  while (stack.length) {
    const [start,end]=stack.pop();
    let maxSq=0, idx=-1;
    const a=points[start], b=points[end];
    for (let i=start+1;i<end;i++) {
      const d = sqSegDist(points[i], a, b);
      if (d>maxSq){ maxSq=d; idx=i; }
    }
    if (maxSq > sqTol && idx!==-1) {
      keep[idx]=1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out=[]; for (let i=0;i<points.length;i++) if (keep[i]) out.push(points[i]);
  return out;
}
