import { Xform } from '../index.js';
import { Base2DItem } from '../core/Base2DItem.js';
// Simple pad / via representation: annular ring + hole. Rendered as two concentric polygons (outer ring minus inner) or approximated.
// For now: approximate ring with triangle strip (fan) for simplicity; hole rendered as filled black (cutout placeholder).
// Future: real stencil/cutout support via masking or depth.
export class Pad extends Base2DItem {
  constructor({ x=0, y=0, holeDiameter=0.4, ringWidth=0.1, layerRef=null, color=[0.85,0.65,0.05,1], xform=null }) {
    super();
    this.x = x; this.y = y; this.holeDiameter = holeDiameter; this.ringWidth = ringWidth; this.layerRef = layerRef; this.color = color; this.xform = xform || new Xform();
    this._cpuVertsLOD = []; this._cpuIndicesLOD = []; this._lodTolerances = [0];
  }
  _ensureLODs(){ if(this._cpuVertsLOD[0]) return; // generate circle approximation
    const outerR = (this.holeDiameter*0.5 + this.ringWidth);
    const innerR = this.holeDiameter*0.5;
    const segments = 32; // could adapt with LOD later
    const verts=[]; const idx=[];
    // Build ring as triangles (two vertices per segment for inner+outer) -> triangles
    for(let i=0;i<=segments;i++){
      const a = (i/segments)*Math.PI*2; const ca=Math.cos(a), sa=Math.sin(a);
      verts.push(this.x + ca*outerR, this.y + sa*outerR); // outer
      verts.push(this.x + ca*innerR, this.y + sa*innerR); // inner
    }
    for(let i=0;i<segments;i++){
      const o = i*2; // outer/inner pair start index (in pair units)
      // Indices referencing vertex pairs (2 verts per step)
      const i0 = o; const i1 = o+1; const i2 = o+2; const i3 = o+3;
      // Two triangles per quad strip
      idx.push(i0, i1, i2, i2, i1, i3);
    }
    this._cpuVertsLOD[0] = new Float32Array(verts);
    this._cpuIndicesLOD[0] = new Uint32Array(idx);
  }
  ensureExpandedGeometry(device, lod=0){ this._ensureLODs(); }
  draw({ device, pass, pipelines, view, zoom=1 }){
    this.ensureUniformBuffer(device);
    if(!this.vertexBuffer){ this._ensureLODs(); const v=this._cpuVertsLOD[0]; const id=this._cpuIndicesLOD[0]; this.vertexBuffer=device.createBuffer({ size:v.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(this.vertexBuffer,0,v); this.indexBuffer=device.createBuffer({ size:id.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(this.indexBuffer,0,id); this.indexCount=id.length; }
    this.writeUniforms(device, this.color, this.xform.toMat3(), view);
    this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);
    pass.setPipeline(pipelines.pipelinePoly); // reuse polygon pipeline (solid color)
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer,'uint32');
    pass.setBindGroup(0, this.bindGroup);
    pass.drawIndexed(this.indexCount);
    // Hole fill (black): reuse inner vertices only as triangle fan
    // Simple approach: build once
    if(!this._holeBuffer){
      const innerR = this.holeDiameter*0.5; const seg=32; const hv=[]; hv.push(this.x,this.y);
      for(let i=0;i<=seg;i++){ const a=(i/seg)*Math.PI*2; hv.push(this.x+Math.cos(a)*innerR, this.y+Math.sin(a)*innerR); }
      const hVerts=new Float32Array(hv); this._holeBuffer=device.createBuffer({ size:hVerts.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(this._holeBuffer,0,hVerts); this._holeCount=seg+2; }
    // Write uniforms with black color (temporarily overriding color) -> Could optimize by second pipeline, keeping same transform
    this.writeUniforms(device, [0,0,0,1], this.xform.toMat3(), view);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this._holeBuffer);
    pass.draw(this._holeCount);
    // Restore original color uniform for future if needed (not strictly required each frame since we re-write per draw)
  }
}
