import earcut from "earcut";
import { Xform } from "../index.js";
import { Base2DItem } from "../core/Base2DItem.js";

export class Polygon extends Base2DItem {
  constructor({ points, holes=[], fill=[0,0,0,1], stroke=null, xform=null }) {
    super();
    this.points = points; // [{x,y}] closed implied
    this.holes = holes;   // array of [{x,y}] arrays
    this.fill = fill; this.stroke = stroke; this.xform = xform || new Xform();
    // LOD data
    this._lodOuter = null;      // Array of outer ring point arrays (LOD0=original)
    this._lodHoles = null;      // Array of arrays (per hole: array of LOD arrays)
    this._lodTolerances = null; // ascending tolerances
    this._cpuVertsLOD = [];
    this._cpuIndicesLOD = [];
    this._lastUsedLOD = -1;
  }

  static allowedScreenErrorPx = 0.75;
  static minScreenAreaPx = 4.0; // Cull polygons smaller than this in screen space

  _computeWorldBounds() {
    if (this._worldBounds) return this._worldBounds;
    const points = this.points;
    if (!points || points.length === 0) {
      this._worldBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      return this._worldBounds;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this._worldBounds = { minX, minY, maxX, maxY };
    return this._worldBounds;
  }

  _getScreenAreaPx(zoom, canvasWidth, canvasHeight) {
    const bounds = this._computeWorldBounds();
    const worldWidth = bounds.maxX - bounds.minX;
    const worldHeight = bounds.maxY - bounds.minY;
    
    // Convert world size to screen pixels
    const screenWidth = worldWidth * zoom;
    const screenHeight = worldHeight * zoom;
    
    return screenWidth * screenHeight;
  }

  _ensureLODs() {
    if (this._lodOuter) return;
    const originalOuter = this.points;
    const holeRings = this.holes;
    // Compute bounding box diag for tolerance scale
    const bbox={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
    for (const p of originalOuter){ if(p.x<bbox.minX)bbox.minX=p.x; if(p.y<bbox.minY)bbox.minY=p.y; if(p.x>bbox.maxX)bbox.maxX=p.x; if(p.y>bbox.maxY)bbox.maxY=p.y; }
    for (const h of holeRings) for(const p of h){ if(p.x<bbox.minX)bbox.minX=p.x; if(p.y<bbox.minY)bbox.minY=p.y; if(p.x>bbox.maxX)bbox.maxX=p.x; if(p.y>bbox.maxY)bbox.maxY=p.y; }
    const diag=Math.hypot(bbox.maxX-bbox.minX, bbox.maxY-bbox.minY)||1;
    const baseTol = diag*0.0005, maxTol = diag*0.02;
    const tolerances=[0]; while(tolerances[tolerances.length-1] < maxTol && tolerances.length<6){ const next=tolerances.length===1? baseTol: tolerances[tolerances.length-1]*4; tolerances.push(Math.min(next,maxTol)); }
    function douglas(points, tol){ if(tol<=0 || points.length<4) return points.slice(); const sqTol=tol*tol; const keep=new Uint8Array(points.length); keep[0]=1; keep[points.length-1]=1; function sqSegDist(p,a,b){ let x=a.x,y=a.y; let dx=b.x-x, dy=b.y-y; if(dx||dy){ const t=((p.x-x)*dx+(p.y-y)*dy)/(dx*dx+dy*dy); if(t>1){x=b.x;y=b.y;} else if(t>0){x+=dx*t;y+=dy*t;} } const rx=p.x-x, ry=p.y-y; return rx*rx+ry*ry; } const stack=[[0,points.length-1]]; while(stack.length){ const [s,e]=stack.pop(); let max=0, idx=-1; const A=points[s], B=points[e]; for(let i=s+1;i<e;i++){ const d=sqSegDist(points[i],A,B); if(d>max){max=d; idx=i;} } if(max>sqTol && idx!==-1){ keep[idx]=1; stack.push([s,idx],[idx,e]); } } const out=[]; for(let i=0;i<points.length;i++) if(keep[i]) out.push(points[i]); return out; }
    const lodOuter=[originalOuter]; for(let i=1;i<tolerances.length;i++) lodOuter.push(douglas(originalOuter, tolerances[i]));
    const lodHoles = holeRings.map(hole=>{ const arr=[hole]; for(let i=1;i<tolerances.length;i++) arr.push(douglas(hole, tolerances[i])); return arr; });
    this._lodOuter = lodOuter; this._lodHoles = lodHoles; this._lodTolerances = tolerances;
  }

  _getLODForZoom(zoom){ this._ensureLODs(); const threshold = Polygon.allowedScreenErrorPx / Math.max(zoom,1e-6); let choice=0; for(let i=1;i<this._lodTolerances.length;i++){ if(this._lodTolerances[i] <= threshold) choice=i; else break; } return choice; }

  _ensureExpandedGeometry(device, lodIndex){ this._ensureLODs(); if(lodIndex>=this._lodTolerances.length) lodIndex=this._lodTolerances.length-1; if(this._cpuVertsLOD[lodIndex] && this._cpuIndicesLOD[lodIndex]) return; const outer=this._lodOuter[lodIndex]; const holesSets=this._lodHoles; const flat=[]; for(const p of outer) flat.push(p.x,p.y); const holesIdx=[]; let cursor = flat.length/2; for(const h of holesSets){ const ring = h[lodIndex] || h[h.length-1]; if(ring && ring.length>=3){ holesIdx.push(cursor); for(const p of ring) flat.push(p.x,p.y); cursor = flat.length/2; } } const indices = earcut(flat, holesIdx, 2); const verts = new Float32Array(flat); const id = new Uint32Array(indices); this._cpuVertsLOD[lodIndex]=verts; this._cpuIndicesLOD[lodIndex]=id; }

  build(device, { zoom=1 } = {}) {
    const lodIndex = this._getLODForZoom(zoom);
    this._ensureExpandedGeometry(device, lodIndex);
    if (lodIndex === this._lastUsedLOD && !this.dirty) return;
    const v=this._cpuVertsLOD[lodIndex]; const id=this._cpuIndicesLOD[lodIndex];
    this.vertexBuffer = device.createBuffer({ size:v.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(this.vertexBuffer,0,v);
    this.indexBuffer = device.createBuffer({ size:id.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(this.indexBuffer,0,id);
    this.indexCount=id.length; this.indexFormat='uint32'; this._lastUsedLOD=lodIndex; this.dirty=false; if(!this._cpuVerts){ this._cpuVerts=this._cpuVertsLOD[0]; this._cpuIndices=this._cpuIndicesLOD[0]; }
  }

  draw({ device, pass, pipelines, view, zoom=1, canvasWidth=800, canvasHeight=600 }) {
    // Cull very small polygons when zoomed out
    const screenArea = this._getScreenAreaPx(zoom, canvasWidth, canvasHeight);
    if (screenArea < Polygon.minScreenAreaPx) {
      return; // Skip drawing this polygon
    }
    
    this.build(device, { zoom });
    this.ensureUniformBuffer(device);
  // Always write uniforms (color may change alpha globally)
  this.writeUniforms(device, this.fill, this.xform.toMat3(), view);
  this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);

  pass.setPipeline(pipelines.pipelinePoly);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, this.indexFormat || 'uint16');
  pass.setBindGroup(0, this.bindGroup);
    pass.drawIndexed(this.indexCount);

    // Optional stroke: re-use polygon edges as a thin triangle list (approximate)
  if (this.stroke) {
      // Future improvement: use specialized pipeline for strokes
    }
  }
}
