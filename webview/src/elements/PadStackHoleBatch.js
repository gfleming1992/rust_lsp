// Batched rendering for pad stack holes + optional annular rings.
// Draw order: rings (gold) then holes (black) so hole masks ring center.
export class PadStackHoleBatch {
  constructor({ pads = [], segments = 24, ringColor = [1.0,0.9,0.25,1], holeColor=[0,0,0,1], lod=true } = {}) {
    // pads: [{x,y,holeDiameter,ringWidth,layerRef}]
    this.pads = pads;
    this.segments = segments;
    this.ringColor = ringColor;
    this.holeColor = holeColor;
    this.layerRef = null; // spans many layers potentially
    // Grouped geometry (size buckets) for per-size LOD decisions
    // Each group: { key, maxOuterR, ringVB, ringIB, ringIndexCount, holeVB, holeIB, holeIndexCount, uniformRing, uniformHole }
    this._groups = [];
    this._built = false;
    this._lod = lod; // enable LOD logic
  }
  _build(device){
    if (this._built) return;
    const seg = this.segments;
    // Bucket pads by outer radius (quantize) so LOD can differ per size bucket
    const buckets = new Map(); // key -> { pads:[], maxOuterR }
    for (const p of this.pads){
      const holeR = (p.holeDiameter||0)*0.5;
      const outerR = holeR + (p.ringWidth||0);
      // Quantize to 0.05 world units to reduce bucket explosion
      const q = Math.round(outerR / 0.05) * 0.05;
      const key = q.toFixed(2);
      let b = buckets.get(key);
      if (!b){ b = { pads:[], maxOuterR:0 }; buckets.set(key,b); }
      b.pads.push({ p, holeR, outerR });
      if (outerR > b.maxOuterR) b.maxOuterR = outerR;
    }
    for (const [key, b] of buckets.entries()){
      const ringVerts=[]; const ringIdx=[]; let ringVertexBase=0;
      const holeVerts=[]; const holeIdx=[]; let holeVertexBase=0;
      let padsWithRing=0;
      for (const entry of b.pads){
        const { p, holeR, outerR } = entry;
        const ringWidth = (p.ringWidth||0);
        if (ringWidth>0){
          padsWithRing++;
          for (let i=0;i<=seg;i++){ const a=(i/seg)*Math.PI*2; const ca=Math.cos(a), sa=Math.sin(a); ringVerts.push(p.x + ca*outerR, p.y + sa*outerR); ringVerts.push(p.x + ca*holeR, p.y + sa*holeR); }
          for (let i=0;i<seg;i++){ const o = ringVertexBase + i*2; ringIdx.push(o,o+1,o+2, o+2,o+1,o+3); }
          ringVertexBase += (seg+1)*2;
        }
        // Hole fan
        const centerIndex = holeVertexBase; holeVerts.push(p.x, p.y); holeVertexBase++;
        for (let i=0;i<=seg;i++){ const a=(i/seg)*Math.PI*2; holeVerts.push(p.x+Math.cos(a)*holeR, p.y+Math.sin(a)*holeR); holeVertexBase++; }
        for (let i=0;i<seg;i++){ holeIdx.push(centerIndex, centerIndex+1+i, centerIndex+1+i+1); }
      }
      const group = { key, maxOuterR: b.maxOuterR, ringIndexCount:0, holeIndexCount:0 };
      if (ringVerts.length){
        const vArr = new Float32Array(ringVerts); const iArr=new Uint32Array(ringIdx);
        group.ringVB = device.createBuffer({ size:vArr.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(group.ringVB,0,vArr);
        group.ringIB = device.createBuffer({ size:iArr.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(group.ringIB,0,iArr);
        group.ringIndexCount = iArr.length;
      }
      const hvArr = new Float32Array(holeVerts); const hiArr = new Uint32Array(holeIdx);
      group.holeVB = device.createBuffer({ size:hvArr.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(group.holeVB,0,hvArr);
      group.holeIB = device.createBuffer({ size:hiArr.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(group.holeIB,0,hiArr);
      group.holeIndexCount = hiArr.length;
      group.uniformRing = device.createBuffer({ size:16*4, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
      group.uniformHole = device.createBuffer({ size:16*4, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
      this._groups.push(group);
    }
  // Debug log removed for production cleanliness
    this._built = true;
  }
  _writeUniform(device, buffer, color, view){
    const f = new Float32Array(16);
    f[0]=color[0]; f[1]=color[1]; f[2]=color[2]; f[3]=color[3];
    f[4]=view[0]; f[5]=view[1]; f[6]=view[2]; f[7]=0;
    f[8]=view[3]; f[9]=view[4]; f[10]=view[5]; f[11]=0;
    f[12]=view[6]; f[13]=view[7]; f[14]=view[8]; f[15]=0;
    device.queue.writeBuffer(buffer,0,f);
  }
  draw({ device, pass, pipelines, view, instanceBuffer, instanceCount, zoom=1 }){
    if (!this.pads.length) return;
    this._build(device);
    const instanced = instanceBuffer && instanceCount>0;
    for (const g of this._groups){
      const pipelinePoly = instanced ? pipelines.pipelinePolyInstanced : pipelines.pipelinePoly;
      // Per-group LOD thresholds
      const showRingMinPx = 1.0;  // ring disappears (none) below this radius
      const solidDiscMinPx =3.0; // use solid disc below this
      let mode='full';
      if (this._lod){
        const pxR = g.maxOuterR * zoom;
        if (pxR < showRingMinPx) mode='none';
        else if (pxR < solidDiscMinPx) mode='solid';
      }
      if (mode==='none') continue;
      // Draw ring (or outer disc) if any ring geometry
      if (g.ringIndexCount>0){
        this._writeUniform(device, g.uniformRing, this.ringColor, view);
        const bg = device.createBindGroup({ layout:pipelines.uniformBindGroupLayout, entries:[{ binding:0, resource:{ buffer:g.uniformRing }}] });
        pass.setPipeline(pipelinePoly);
        pass.setBindGroup(0, bg);
        pass.setVertexBuffer(0, g.ringVB);
        if (instanced) pass.setVertexBuffer(1, instanceBuffer);
        pass.setIndexBuffer(g.ringIB,'uint32');
        pass.drawIndexed(g.ringIndexCount, instanced ? instanceCount : 1);
      }
      if (mode==='full' || mode==='solid'){
        // Draw hole (black only in full mode; ringColor in solid mode to create full disc)
        const holeCol = mode==='solid' ? this.ringColor : this.holeColor;
        this._writeUniform(device, g.uniformHole, holeCol, view);
        const bgH = device.createBindGroup({ layout:pipelines.uniformBindGroupLayout, entries:[{ binding:0, resource:{ buffer:g.uniformHole }}] });
        pass.setPipeline(pipelinePoly);
        pass.setBindGroup(0, bgH);
        pass.setVertexBuffer(0, g.holeVB);
        if (instanced) pass.setVertexBuffer(1, instanceBuffer);
        pass.setIndexBuffer(g.holeIB,'uint32');
        pass.drawIndexed(g.holeIndexCount, instanced ? instanceCount : 1);
      }
    }
  }
}
