import { mat3 } from '../core/math/mat3.js';
import { Polyline } from './Polyline.js';

// Represents many polylines merged into a single vertex/index buffer plus per-item entry table.
export class BatchedPolylines {
  constructor({ items }) {
    this.items = items; // original Polyline instances (for rebuild invalidation if needed)
    this.itemCount = items.length;
    this.storageBuffer = null;   // array of {color, m0,m1,m2} (model matrix rows only)
    this.bindGroup = null;       // created per frame with view uniform
    this.dirty = true; // marks storage rebuild needed (model transforms change)
    this._lastStorageBuffer = null; // for bind group caching
    this._lastViewUniformBuffer = null;
  this._lastVisibilityVersion = 0; // track scene visibility cache

    // Multi-LOD aggregated geometry (built on demand)
    this._lodVertexBuffers = [];
    this._lodIndexBuffers = [];
    this._lodItemIndexBuffers = [];
    this._lodIndexCounts = [];
    this._lodBuilt = []; // boolean flags
    this._lastUsedLOD = -1;
    this._prebuildTargets = [0,2,4]; // candidate LOD indices to build (will clamp to available)
  this._layerRefs = items.map(it=>it.layerRef||null);
  this._visibleItemMap = null; // Float32Array mapping vertex-> packed itemIndex of visible subset
  this._visibleItemBuffer = null;
  this._visibleVersion = 0; // increment when visibility changes
  this._lodItemRanges = []; // per LOD: array of { itemIdx, firstIndex, indexCount, layerRef }
  }
  // Lines thinner than this many screen pixels will be culled when zoomed far out.
  static minVisiblePixelWidth = 0.4; // adjustable (e.g. window.setMinLinePixelWidth)

  build(device, pipelines) {
    // Pre-build target LODs lazily only once
    if (!this._prebuiltOnce) {
      for (const t of this._prebuildTargets) this._buildBatchLOD(device, t);
      this._prebuiltOnce = true;
    }
  }

  _buildBatchLOD(device, lodIndex) {
    if (this._lodBuilt[lodIndex]) return;
    const vertsCollect = [];
    const idxCollect = [];
    const itemIndexCollect = [];
  const ranges = [];
    let vertBase = 0;
    let builtPolys = 0, skippedNoGeom = 0, skippedMissing = 0;
    for (let itemIdx=0; itemIdx<this.items.length; itemIdx++) {
      const pl = this.items[itemIdx];
      // Ensure polyline has requested LOD geometry
      pl.ensureLODs();
  // Previously we used _cpuVertsLOD.length-1 which is -1 before any builds, causing useLOD=-1 and skips.
  // Instead base availability on point LODs (computed by ensureLODs). Then build geometry on demand.
  const maxAvailable = (pl._lodPoints ? pl._lodPoints.length - 1 : -1);
  if (maxAvailable < 0) { skippedMissing++; continue; }
  const useLOD = Math.min(lodIndex, maxAvailable);
      pl.ensureExpandedGeometry(device, useLOD);
      const vSrc = pl._cpuVertsLOD[useLOD];
      const iSrc = pl._cpuIndicesLOD[useLOD];
      if (!vSrc || !iSrc) {
        skippedMissing++;
        if (itemIdx < 5) {
          console.warn('Batch skip: missing geom', { itemIdx, useLOD, hasVerts: !!vSrc, hasIdx: !!iSrc, pointsLen: pl.points?.length, lodPoints0: pl._lodPoints && pl._lodPoints[0] ? pl._lodPoints[0].length : 'n/a' });
        }
        continue;
      }
      if (vSrc.length === 0 || iSrc.length === 0) {
        skippedNoGeom++;
        if (itemIdx < 5) {
          console.warn('Batch skip: empty geom arrays', { itemIdx, useLOD, vLen: vSrc.length, iLen: iSrc.length });
        }
        continue;
      }
      for (let i=0;i<vSrc.length;i+=2) {
        vertsCollect.push(vSrc[i], vSrc[i+1]);
        itemIndexCollect.push(itemIdx);
      }
  for (let i=0;i<iSrc.length;i++) idxCollect.push(iSrc[i] + vertBase);
  // Record index range for this item (contiguous because we append sequentially)
  const addedIndexCount = iSrc.length;
  const firstIndex = idxCollect.length - addedIndexCount;
  ranges.push({ itemIdx, firstIndex, indexCount: addedIndexCount, layerRef: pl.layerRef || null });
      vertBase += vSrc.length/2;
      builtPolys++;
    }
    if (!vertsCollect.length || !idxCollect.length) { 
      this._lodBuilt[lodIndex]=true; this._lodIndexCounts[lodIndex]=0; 
      if(!this._debugEmptyOnce){
        console.warn('Batch LOD empty', lodIndex, { builtPolys, skippedMissing, skippedNoGeom, total:this.items.length }); 
        this._debugEmptyOnce=true;
      } 
      return; 
    }
    const v = new Float32Array(vertsCollect);
    const id = new Uint32Array(idxCollect);
  const itemIdxF32 = new Float32Array(itemIndexCollect.length);
  for (let i=0;i<itemIndexCollect.length;i++) itemIdxF32[i] = itemIndexCollect[i];
  if (!this._cpuItemIndexLOD) this._cpuItemIndexLOD = [];
  this._cpuItemIndexLOD[lodIndex] = itemIdxF32.slice();
    const vbuf = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbuf, 0, v);
    const ibuf = device.createBuffer({ size: id.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ibuf, 0, id);
    const itemBuf = device.createBuffer({ size: itemIdxF32.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(itemBuf, 0, itemIdxF32);
    this._lodVertexBuffers[lodIndex] = vbuf;
    this._lodIndexBuffers[lodIndex] = ibuf;
    this._lodItemIndexBuffers[lodIndex] = itemBuf;
  this._lodIndexCounts[lodIndex] = id.length;
  this._lodBuilt[lodIndex] = true;
  this._lodItemRanges[lodIndex] = ranges;
  if(!this._debugBuiltLODOnce){ console.log('Built batch LOD', lodIndex, 'verts', v.length/2, 'indices', id.length, { builtPolys, skippedMissing, skippedNoGeom }); this._debugBuiltLODOnce=true; }
  }

  // TODO: Future improvement: maintain multiple batched LODs or dynamically re-batch when overall zoom causes
  // vertex count threshold exceedances. For now, batching always uses full-detail geometry while individual
  // (non-batched) draws leverage per-item LOD.

  ensureStorage(device, pipelines) {
    // Packed layout: u32 packedColor + 3 vec4 rows (we keep rows f32x4 for simplicity)
    // Total floats per item after packing color into one u32 occupying 4 bytes inside first vec4 slot: we store as f32 array but color unpacked by shader reading a u32 buffer separately soon.
    // For now keep same buffer but encode color into first row's w component as uint via reinterpret. Simpler: pack color into a separate Uint32Array parallel and then copy into f32 view.
    const floatsPerItem = 16; // keep alignment (we repurpose first 4 floats: colorRGBA packed into single float via uintBitsToFloat encoding)
    const f = new Float32Array(this.itemCount * floatsPerItem);
    const u32 = new Uint32Array(f.buffer);
    for (let i=0;i<this.items.length;i++) {
      const it = this.items[i];
      const c = it.color || [1,1,1,1];
      const r = Math.min(255, Math.max(0, (c[0]*255)|0));
      const g = Math.min(255, Math.max(0, (c[1]*255)|0));
      const b = Math.min(255, Math.max(0, (c[2]*255)|0));
      const a = Math.min(255, Math.max(0, (c[3]*255)|0));
      const packed = (r) | (g<<8) | (b<<16) | (a<<24);
      const model = it.xform.toMat3();
      const o = i*floatsPerItem;
      // Store packed color as first 32 bits, then leave next 3 floats for potential future use (padding)
      u32[(o)>>0] = packed;
      f[o+1] = 0; f[o+2]=0; f[o+3]=0;
      f.set([model[0],model[1],model[2],0], o+4);
      f.set([model[3],model[4],model[5],0], o+8);
      f.set([model[6],model[7],model[8],0], o+12);
    }
    const byteLength = f.byteLength;
    if (!this.storageBuffer || this.storageBuffer.size < byteLength) {
      this.storageBuffer = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(this.storageBuffer, 0, f);
  }

  draw({ device, pass, pipelines, viewUniformBuffer, zoom=1, instanceBuffer=null, instanceCount=0, layerVisibility=null }) {
    this.build(device, pipelines);
    // Choose an appropriate batch LOD based on zoom + available prebuilt LODs.
    let lodIndex = this._chooseBatchLOD(zoom);
    this._buildBatchLOD(device, lodIndex);
    this.ensureStorage(device, pipelines);
  const vbufFinal = this._lodVertexBuffers[lodIndex];
  const ibufFinal = this._lodIndexBuffers[lodIndex];
  let itemIdxBufFinal = this._lodItemIndexBuffers[lodIndex];
    const idxCountFinal = this._lodIndexCounts[lodIndex]||0;
    if (!vbufFinal || !ibufFinal || !itemIdxBufFinal || idxCountFinal===0) {
      console.warn('No batch geometry after build');
      return;
    }
    // Cache bind group (viewUniformBuffer reused / contents updated externally)
    if (!this.bindGroup || this._lastStorageBuffer !== this.storageBuffer || this._lastViewUniformBuffer !== viewUniformBuffer) {
      this.bindGroup = device.createBindGroup({ layout: pipelines.storageBindGroupLayout, entries: [
        { binding:0, resource:{ buffer:this.storageBuffer } },
        { binding:1, resource:{ buffer:viewUniformBuffer } }
      ] });
      this._lastStorageBuffer = this.storageBuffer;
      this._lastViewUniformBuffer = viewUniformBuffer;
    }
    const ranges = this._lodItemRanges[lodIndex] || [];
    let needSegmentation = false;
    const widthCullPx = BatchedPolylines.minVisiblePixelWidth || 0;
    let anyVisibleDueToWidth = false;
    if (layerVisibility || widthCullPx>0) {
      for (const r of ranges) {
        const item = this.items[r.itemIdx];
        const layerHidden = (layerVisibility && r.layerRef && layerVisibility[r.layerRef]===false);
        const tooThin = widthCullPx>0 && item && (item.width * zoom < widthCullPx);
        if (layerHidden || tooThin) { needSegmentation = true; }
        else anyVisibleDueToWidth = true;
        if (needSegmentation && anyVisibleDueToWidth) break;
      }
    }
    if (!anyVisibleDueToWidth && widthCullPx>0) {
      // All lines culled by pixel width
      return;
    }
    const pipeline = instanceBuffer && instanceCount>0 ? pipelines.pipelinePolylineBatchInstanced : pipelines.pipelinePolylineBatch;
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vbufFinal);
    if (instanceBuffer && instanceCount>0) pass.setVertexBuffer(1, instanceBuffer);
    const itemSlot = instanceBuffer && instanceCount>0 ? 2 : 1;
    pass.setVertexBuffer(itemSlot, itemIdxBufFinal);
    pass.setIndexBuffer(ibufFinal, 'uint32');
    pass.setBindGroup(0, this.bindGroup);
    if (!needSegmentation) {
      pass.drawIndexed(idxCountFinal, instanceBuffer && instanceCount>0 ? instanceCount : 1);
      return;
    }
    // Segmented draws merging contiguous visible index runs
    let runFirst = -1, runCount = 0; let anyDraw=false;
    const drawMult = instanceBuffer && instanceCount>0 ? instanceCount : 1;
    function flush() {
      if (runFirst>=0 && runCount>0) { pass.drawIndexed(runCount, drawMult, runFirst); }
      runFirst=-1; runCount=0;
    }
    for (const r of ranges) {
      const item = this.items[r.itemIdx];
      const layerHidden = layerVisibility && r.layerRef && layerVisibility[r.layerRef]===false;
      const widthTooSmall = widthCullPx>0 && item && (item.width * zoom < widthCullPx);
      const vis = !layerHidden && !widthTooSmall;
      if (vis) {
        if (runFirst<0) { runFirst = r.firstIndex; runCount = r.indexCount; }
        else if (runFirst + runCount === r.firstIndex) { runCount += r.indexCount; }
        else { flush(); runFirst = r.firstIndex; runCount = r.indexCount; }
        anyDraw=true;
      } else flush();
    }
    flush();
    if (!anyDraw) return;
  }

  // Multi-LOD batching implemented (LOD0 forced currently for debug)
  _chooseBatchLOD(zoom) {
    if (!this.items.length) return 0;
    const first = this.items[0];
    first.ensureLODs();
    const tolerances = first._lodTolerances || [0];
    const threshold = Polyline.allowedScreenErrorPx / Math.max(zoom,1e-6);
    let desired = 0;
    for (let i=1;i<tolerances.length;i++) { if (tolerances[i] <= threshold) desired = i; else break; }
    let chosen = 0;
    for (const t of this._prebuildTargets) { if (t <= desired && this._lodBuilt[t]) chosen = t; }
    if (!this._lodBuilt[chosen]) chosen = 0;
    return chosen;
  }
}
