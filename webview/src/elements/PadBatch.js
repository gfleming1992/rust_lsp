// Batched rendering for pads (vias): draws all rings, then holes.
// Simplified: constant ring color (gold) and black holes; geometry pre-expanded in world space.
export class PadBatch {
  constructor({ pads = [], segments = 24, ringColor = [0.85,0.65,0.05,1] } = {}) {
    this.pads = pads; // [{x,y,holeDiameter,ringWidth,layerRef}]
    this.segments = segments;
    this.ringColor = ringColor;
    // A batch may span multiple layers; viewer will already have filtered pad placements by layer if needed.
    this.layerRef = null;
    this._ringVertexBuffer = null;
    this._ringIndexBuffer = null;
    this._holeVertexBuffer = null;
    this._uniformBuffer = null;
    this._ringIndexCount = 0;
    this._holeVertexCount = 0;
    this._built = false;
  }
  _build(device) {
    if (this._built) return;
    const seg = this.segments;
    const ringVerts = []; const ringIdx = [];
    const holeVerts = []; const holeIdx = [];
    let ringVertexBase = 0; let holeVertexBase = 0;
    for (const p of this.pads) {
      const holeR = (p.holeDiameter||0) * 0.5;
      const ringWidth = p.ringWidth || 0;
      // Optional ring (only if plated / ringWidth>0)
      if (ringWidth > 0) {
        const outerR = holeR + ringWidth;
        for (let i=0;i<=seg;i++) {
          const a = (i/seg)*Math.PI*2; const ca=Math.cos(a), sa=Math.sin(a);
          ringVerts.push(p.x + ca*outerR, p.y + sa*outerR); // outer
          ringVerts.push(p.x + ca*holeR,  p.y + sa*holeR);  // inner
        }
        for (let i=0;i<seg;i++) {
          const o = ringVertexBase + i*2;
          ringIdx.push(o, o+1, o+2,  o+2, o+1, o+3);
        }
        ringVertexBase += (seg+1)*2;
      }
      // Hole (black filled circle) as triangle fan converted to triangle list via indices
      const centerIndex = holeVertexBase; holeVerts.push(p.x, p.y); holeVertexBase++;
      for (let i=0;i<=seg;i++) { const a=(i/seg)*Math.PI*2; holeVerts.push(p.x+Math.cos(a)*holeR, p.y+Math.sin(a)*holeR); holeVertexBase++; }
      // Add triangles: center, i, i+1
      for (let i=0;i<seg;i++) { holeIdx.push(centerIndex, centerIndex + 1 + i, centerIndex + 1 + i + 1); }
    }
    if (ringVerts.length) {
      const ringVArr = new Float32Array(ringVerts);
      const ringIArr = new Uint32Array(ringIdx);
      this._ringVertexBuffer = device.createBuffer({ size:ringVArr.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this._ringVertexBuffer,0,ringVArr);
      this._ringIndexBuffer = device.createBuffer({ size:ringIArr.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this._ringIndexBuffer,0,ringIArr);
      this._ringIndexCount = ringIArr.length;
    } else {
      this._ringIndexCount = 0;
    }
    const holeVArr = new Float32Array(holeVerts); const holeIArr = new Uint32Array(holeIdx);
    this._holeVertexBuffer = device.createBuffer({ size:holeVArr.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this._holeVertexBuffer,0,holeVArr);
    this._holeIndexBuffer = device.createBuffer({ size:holeIArr.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this._holeIndexBuffer,0,holeIArr);
    this._holeIndexCount = holeIArr.length;
    // 16 floats * 4 bytes = 64 bytes (vec4 color + 3 vec4 rows) per Base2DItem convention
    this._uniformBuffer = device.createBuffer({ size:16*4, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
    this._built = true;
  }
  _writeUniform(device, color, view) {
    const f = new Float32Array(16);
    f[0]=color[0]; f[1]=color[1]; f[2]=color[2]; f[3]=color[3];
    f[4]=view[0]; f[5]=view[1]; f[6]=view[2]; f[7]=0;
    f[8]=view[3]; f[9]=view[4]; f[10]=view[5]; f[11]=0;
    f[12]=view[6]; f[13]=view[7]; f[14]=view[8]; f[15]=0;
    device.queue.writeBuffer(this._uniformBuffer,0,f);
  }
  draw({ device, pass, pipelines, view }) {
    if (!this.pads.length) return;
    this._build(device);
    const bindGroup = device.createBindGroup({ layout: pipelines.uniformBindGroupLayout, entries:[{ binding:0, resource:{ buffer:this._uniformBuffer }}] });
    pass.setPipeline(pipelines.pipelinePoly);
    if (this._ringIndexCount > 0) {
      this._writeUniform(device, this.ringColor, view);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, this._ringVertexBuffer);
      pass.setIndexBuffer(this._ringIndexBuffer,'uint32');
      pass.drawIndexed(this._ringIndexCount);
    }
    // Holes always
    this._writeUniform(device, [0,0,0,1], view);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this._holeVertexBuffer);
    pass.setIndexBuffer(this._holeIndexBuffer,'uint32');
    pass.drawIndexed(this._holeIndexCount);
  }
}
