import { Xform } from "../index.js";
import { Base2DItem } from "../core/Base2DItem.js";
import earcut from "earcut";

export class Outline extends Base2DItem {
  constructor({ points, width=1, color=[0,0,0,1], xform=null }) {
    super();
    this.points=points; this.width=width; this.color=color; this.xform = xform || new Xform();
    this._lodPoints = null; // array of point arrays
    this._lodTolerances = null; // world error per LOD
    this._cpuVertsLOD = [];
    this._cpuIndicesLOD = [];
    this._lastUsedLOD = -1;
  }

  static allowedScreenErrorPx = 0.75;

  _ensureLODs() {
    if (this._lodPoints) return;
    const original = this.points;
    if (!original || original.length < 3) { this._lodPoints=[original]; this._lodTolerances=[0]; return; }
    // Simple Douglas-Peucker reuse (inline minimal) for polygon ring (treat open list and close later)
    function douglas(pts, tol){
      if (tol<=0 || pts.length<4) return pts.slice();
      const sqTol = tol*tol; const keep=new Uint8Array(pts.length); keep[0]=1; keep[pts.length-1]=1;
      function sqSegDist(p,a,b){ let x=a.x,y=a.y; let dx=b.x-x, dy=b.y-y; if (dx||dy){ const t=((p.x-x)*dx+(p.y-y)*dy)/(dx*dx+dy*dy); if(t>1){x=b.x;y=b.y;} else if(t>0){x+=dx*t;y+=dy*t;} } const rx=p.x-x, ry=p.y-y; return rx*rx+ry*ry; }
      const stack=[[0,pts.length-1]]; while(stack.length){ const [s,e]=stack.pop(); let max=0, idx=-1; const A=pts[s], B=pts[e]; for(let i=s+1;i<e;i++){ const d=sqSegDist(pts[i],A,B); if(d>max){max=d; idx=i;} } if(max>sqTol && idx!==-1){ keep[idx]=1; stack.push([s,idx],[idx,e]); } }
      const out=[]; for(let i=0;i<pts.length;i++) if(keep[i]) out.push(pts[i]); return out;
    }
    // Build tolerances similar to Polyline
    const bbox={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
    for(const p of original){ if(p.x<bbox.minX)bbox.minX=p.x; if(p.y<bbox.minY)bbox.minY=p.y; if(p.x>bbox.maxX)bbox.maxX=p.x; if(p.y>bbox.maxY)bbox.maxY=p.y; }
    const diag=Math.hypot(bbox.maxX-bbox.minX,bbox.maxY-bbox.minY)||1;
    const baseTol=diag*0.0005, maxTol=diag*0.02; const tolerances=[0];
    while(tolerances[tolerances.length-1] < maxTol && tolerances.length<6){ const next=tolerances.length===1? baseTol: tolerances[tolerances.length-1]*4; tolerances.push(Math.min(next,maxTol)); }
    const lodPoints=[original]; for(let i=1;i<tolerances.length;i++) lodPoints.push(douglas(original, tolerances[i]));
    this._lodPoints=lodPoints; this._lodTolerances=tolerances;
  }

  _getLODForZoom(zoom){ this._ensureLODs(); const threshold = Outline.allowedScreenErrorPx / Math.max(zoom,1e-6); let choice=0; for(let i=1;i<this._lodTolerances.length;i++){ if(this._lodTolerances[i] <= threshold) choice=i; else break; } return choice; }

  build(device, { zoom=1 } = {}) {
    const lodIndex = this._getLODForZoom(zoom);
    this._ensureExpandedGeometry(device, lodIndex);
    if (lodIndex === this._lastUsedLOD && !this.dirty) return;
    const v = this._cpuVertsLOD[lodIndex]; const id = this._cpuIndicesLOD[lodIndex];
    this.vertexBuffer = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, v);
    this.indexBuffer = device.createBuffer({ size: id.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, id);
    this.indexCount = id.length; this.indexFormat='uint32';
    this._lastUsedLOD = lodIndex; this.dirty=false;
    if (!this._cpuVerts) { this._cpuVerts=this._cpuVertsLOD[0]; this._cpuIndices=this._cpuIndicesLOD[0]; }
  }

  _ensureExpandedGeometry(device, lodIndex){
    this._ensureLODs(); if (lodIndex >= this._lodPoints.length) lodIndex = this._lodPoints.length-1;
    if (this._cpuVertsLOD[lodIndex] && this._cpuIndicesLOD[lodIndex]) return;
    const basePts = this._lodPoints[lodIndex];
    if (!basePts || basePts.length < 2){
      this._cpuVertsLOD[lodIndex]=new Float32Array(); this._cpuIndicesLOD[lodIndex]=new Uint32Array();
      return;
    }
    const eps=1e-6; const pts=[];
    for(const p of basePts){
      if(!pts.length || Math.hypot(p.x-pts[pts.length-1].x,p.y-pts[pts.length-1].y)>eps) pts.push({x:p.x,y:p.y});
    }
    if (pts.length < 2){
      this._cpuVertsLOD[lodIndex]=new Float32Array(); this._cpuIndicesLOD[lodIndex]=new Uint32Array();
      return;
    }
    const first=pts[0], last=pts[pts.length-1];
    const closed=Math.hypot(first.x-last.x, first.y-last.y)<=eps;
    if (closed && pts.length>1) pts.pop();
    const count=pts.length; const isClosed=closed && count>2;
    if (count<2){
      this._cpuVertsLOD[lodIndex]=new Float32Array(); this._cpuIndicesLOD[lodIndex]=new Uint32Array();
      return;
    }
    const w = this.width*0.5; const left=[]; const right=[];
    const pushNormal = (nx, ny, pt) => { left.push(pt.x+nx*w, pt.y+ny*w); right.push(pt.x-nx*w, pt.y-ny*w); };
    const angleNorm = v => Math.atan2(v.y, v.x);
    const wrapDelta = delta => { if (delta > Math.PI) delta -= 2*Math.PI; if (delta < -Math.PI) delta += 2*Math.PI; return delta; };
    const sampleArc = (startAngle, endAngle, center) => {
      const delta = wrapDelta(endAngle-startAngle);
      const steps = Math.max(1, Math.ceil(Math.abs(delta)/(Math.PI/12)));
      for (let s=1; s<=steps; s++){
        const ang = startAngle + delta*(s/steps);
        pushNormal(Math.cos(ang), Math.sin(ang), center);
      }
      return endAngle;
    };

    if (isClosed){
      const dirs=[];
      for (let i=0;i<count;i++){
        const a=pts[i]; const b=pts[(i+1)%count];
        const dx=b.x-a.x, dy=b.y-a.y; const len=Math.hypot(dx,dy)||1;
        dirs.push({x:dx/len,y:dy/len});
      }
      const normals = dirs.map(dir => ({x:-dir.y, y:dir.x}));
      let prevAngle = angleNorm(normals[0]);
      pushNormal(normals[0].x, normals[0].y, pts[0]);
      for (let i=1;i<=count;i++){
        const idxVert = i % count;
        const nextAngle = angleNorm(normals[idxVert]);
        prevAngle = sampleArc(prevAngle, nextAngle, pts[idxVert]);
      }
      // remove duplicate closing pair
      left.splice(left.length-2,2); right.splice(right.length-2,2);
    } else {
      const dirs=[];
      for (let i=0;i<count-1;i++){
        const dx=pts[i+1].x-pts[i].x, dy=pts[i+1].y-pts[i].y; const len=Math.hypot(dx,dy)||1;
        dirs.push({x:dx/len,y:dy/len});
      }
      if (!dirs.length){
        this._cpuVertsLOD[lodIndex]=new Float32Array(); this._cpuIndicesLOD[lodIndex]=new Uint32Array();
        return;
      }
      const normals = dirs.map(dir => ({x:-dir.y, y:dir.x}));
      let prevAngle = angleNorm(normals[0]);
      pushNormal(normals[0].x, normals[0].y, pts[0]);
      for (let i=1;i<count-1;i++){
        const nextAngle = angleNorm(normals[i]);
        prevAngle = sampleArc(prevAngle, nextAngle, pts[i]);
      }
      pushNormal(normals[normals.length-1].x, normals[normals.length-1].y, pts[count-1]);
    }

    const pairCount = left.length/2;
    if (pairCount < (isClosed?3:2)){
      this._cpuVertsLOD[lodIndex]=new Float32Array(); this._cpuIndicesLOD[lodIndex]=new Uint32Array();
      return;
    }

    const idx=[]; const extraVerts=[];
    if (!isClosed){
      const capSegs = 16;
      const startCenter = pts[0];
      const startCenterIdx = pairCount*2 + extraVerts.length/2;
      extraVerts.push(startCenter.x, startCenter.y);
      const startLeft = { x: left[0], y: left[1] };
      const startRight = { x: right[0], y: right[1] };
      let startAngle = Math.atan2(startLeft.y-startCenter.y, startLeft.x-startCenter.x);
      let endAngle = Math.atan2(startRight.y-startCenter.y, startRight.x-startCenter.x);
      if (endAngle <= startAngle) endAngle += 2*Math.PI;
      for (let s=1; s<capSegs; s++){
        const ang=startAngle + (endAngle-startAngle)*(s/capSegs);
        extraVerts.push(startCenter.x + Math.cos(ang)*w, startCenter.y + Math.sin(ang)*w);
      }
      let prevIdx = 0;
      for (let s=1; s<capSegs; s++){
        const arcIdx = startCenterIdx + s;
        idx.push(prevIdx, arcIdx, startCenterIdx);
        prevIdx = arcIdx;
      }
      idx.push(prevIdx, pairCount, startCenterIdx);

      const endCenter = pts[count-1];
      const endCenterIdx = pairCount*2 + extraVerts.length/2;
      extraVerts.push(endCenter.x, endCenter.y);
      const rightEnd = { x: right[(pairCount-1)*2], y: right[(pairCount-1)*2+1] };
      const leftEnd = { x: left[(pairCount-1)*2], y: left[(pairCount-1)*2+1] };
      let capStart = Math.atan2(rightEnd.y-endCenter.y, rightEnd.x-endCenter.x);
      let capEnd = Math.atan2(leftEnd.y-endCenter.y, leftEnd.x-endCenter.x);
      if (capEnd <= capStart) capEnd += 2*Math.PI;
      let prevCapIdx = pairCount*2-1;
      for (let s=1; s<capSegs; s++){
        const ang=capStart + (capEnd-capStart)*(s/capSegs);
        extraVerts.push(endCenter.x + Math.cos(ang)*w, endCenter.y + Math.sin(ang)*w);
        const arcIdx = endCenterIdx + s;
        idx.push(prevCapIdx, arcIdx, endCenterIdx);
        prevCapIdx = arcIdx;
      }
      idx.push(prevCapIdx, pairCount-1, endCenterIdx);
    }

    const allVerts = new Float32Array([...left,...right,...extraVerts]);
    if (isClosed){
      const segs = pairCount;
      for (let i=0;i<segs;i++){
        const a=i;
        const b=(i+1)%pairCount;
        const c=b+pairCount;
        const d=i+pairCount;
        idx.push(a,b,c,a,c,d);
      }
    } else {
      for (let i=0;i<pairCount-1;i++){
        const a=i;
        const b=i+1;
        const c=b+pairCount;
        const d=i+pairCount;
        idx.push(a,b,c,a,c,d);
      }
    }
    this._cpuVertsLOD[lodIndex]=allVerts; this._cpuIndicesLOD[lodIndex]=new Uint32Array(idx);
  }

  draw({ device, pass, pipelines, view, zoom=1 }) {
    this.build(device, { zoom });
    this.ensureUniformBuffer(device);
    this.writeUniforms(device, this.color, this.xform.toMat3(), view);
  this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);

  pass.setPipeline(pipelines.pipelineOutline);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, this.indexFormat || 'uint16');
  pass.setBindGroup(0, this.bindGroup);
    pass.drawIndexed(this.indexCount);
  }
}
