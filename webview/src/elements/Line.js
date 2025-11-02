import { Xform } from "../index.js";
import { Base2DItem } from "../core/Base2DItem.js";

export class Line extends Base2DItem {
  constructor({ startX, startY, endX, endY, width=1, color=[0,0,0,1], xform=null, cap='round', roundSegments=12 }) {
    super();
    this.startX = startX; this.startY = startY; this.endX = endX; this.endY = endY;
    this.width = width; this.color = color; this.xform = xform || new Xform();
  this.cap = (cap||'round').toLowerCase();
    this.roundSegments = roundSegments;
  }

  build(device) {
    if (!this.dirty) return;
    // Represent a line as a quad (two triangles) expanded in CPU for now
    const dx = this.endX - this.startX;
    const dy = this.endY - this.startY;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // normal
    const ny = dx / len;
    const w = this.width * 0.5;

    // Adjust for square cap (extend along direction by half width each side)
    let sx = this.startX, sy = this.startY, ex = this.endX, ey = this.endY;
    if (this.cap === 'square') {
      sx -= dx/len * w; sy -= dy/len * w;
      ex += dx/len * w; ey += dy/len * w;
    }
    const p0 = [sx + nx*w, sy + ny*w];
    const p1 = [ex + nx*w, ey + ny*w];
    const p2 = [ex - nx*w, ey - ny*w];
    const p3 = [sx - nx*w, sy - ny*w];
    const verts = [];
    const indices = [];
    function pushQuad(a,b,c,d){
      const base = verts.length/2;
      verts.push(a[0],a[1], b[0],b[1], c[0],c[1], d[0],d[1]);
      indices.push(base, base+1, base+2, base, base+2, base+3);
    }
    pushQuad(p0,p1,p2,p3);

  if (this.cap === 'round') {
      // Add semicircle at start (behind start point)
      const segs = Math.max(3, this.roundSegments|0);
      const baseAngle = Math.atan2(dy, dx);
      const r = w;
      // start cap: half circle behind start along -direction
      const startBase = verts.length/2;
      verts.push(sx, sy); // center
      for (let i=0;i<=segs;i++) {
        const t = i / segs;
        const ang = baseAngle + Math.PI/2 + t*Math.PI; // sweep from +90 to +270 (== -90) => behind start
        verts.push(sx + Math.cos(ang)*r, sy + Math.sin(ang)*r);
      }
      for (let i=0;i<segs;i++) indices.push(startBase, startBase+1+i, startBase+2+i);
  // end cap: forward half circle
      const endBase = verts.length/2;
      verts.push(ex, ey);
      for (let i=0;i<=segs;i++) {
        const t = i / segs;
        const ang = baseAngle - Math.PI/2 + t*Math.PI;
        verts.push(ex + Math.cos(ang)*r, ey + Math.sin(ang)*r);
      }
      for (let i=0;i<segs;i++) indices.push(endBase, endBase+1+i, endBase+2+i);
    }

    const vertsArr = new Float32Array(verts);
    const idx = new Uint16Array(indices);

    this.vertexBuffer = device.createBuffer({ size: vertsArr.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertsArr);
    this.indexBuffer = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, idx);
    this.indexCount = idx.length;
    this.dirty = false;
  }

  draw({ device, pass, pipelines, view }) {
    this.build(device);
    this.ensureUniformBuffer(device);
    this.writeUniforms(device, this.color, this.xform.toMat3(), view);
    this.ensureBindGroup(device, pipelines.uniformBindGroupLayout);

    pass.setPipeline(pipelines.pipelineLine);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.setBindGroup(0, this.bindGroup);
    pass.drawIndexed(this.indexCount);
  }
}
