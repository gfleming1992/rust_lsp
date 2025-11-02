import { Polyline } from './Polyline.js';

// Generic batched triangle-list renderer for items that expose per-LOD CPU geometry caches.
export class BatchedGeneric {
  constructor({ items, colorProp='color' }) {
    this.items = items;
    this.itemCount = items.length;
    this.colorProp = colorProp; // 'color' for strokes, 'fill' for polygons
    this.storageBuffer = null;
    this.bindGroup = null;
    this._lastStorageBuffer = null;
    this._lastViewUniformBuffer = null;
  this._needsStorageRewrite = true; // force initial upload
    this._lodVertexBuffers = [];
    this._lodIndexBuffers = [];
    this._lodItemIndexBuffers = [];
    this._lodIndexCounts = [];
    this._lodBuilt = [];
    this._prebuildTargets = [0,2,4];
    this._prebuiltOnce = false;
  this._cachedAlphaOverride = null; // track last applied alpha
  this._layerRefs = items.map(it=>it.layerRef||null);
  this._cpuItemIndexLOD = [];
  this._visibleItemBuffer = null;
  this._lodItemRanges = []; // per LOD array of { itemIdx, firstIndex, indexCount, layerRef }
  }

  build(device) {
    if (!this._prebuiltOnce) {
      for (const t of this._prebuildTargets) this._buildBatchLOD(device, t);
      this._prebuiltOnce = true;
    }
  }

  _ensureItemLOD(device, item, lod) {
    if (item.ensureExpandedGeometry) item.ensureExpandedGeometry(device, lod);
    else if (item._ensureExpandedGeometry) item._ensureExpandedGeometry(device, lod);
  }

  _buildBatchLOD(device, lodIndex) {
    if (this._lodBuilt[lodIndex]) return;
    const vertsCollect=[]; const idxCollect=[]; const itemIndexCollect=[]; const ranges=[]; let vertBase=0;
    for (let itemIdx=0; itemIdx<this.items.length; itemIdx++) {
      const it = this.items[itemIdx];
      const maxAvail = (it._lodTolerances ? it._lodTolerances.length - 1 : 0);
      const useLOD = Math.min(lodIndex, Math.max(0, maxAvail));
      this._ensureItemLOD(device, it, useLOD);
      const v = it._cpuVertsLOD && it._cpuVertsLOD[useLOD];
      const id = it._cpuIndicesLOD && it._cpuIndicesLOD[useLOD];
      if (!v || !id || v.length===0 || id.length===0) continue;
      for (let i=0;i<v.length;i+=2){ vertsCollect.push(v[i], v[i+1]); itemIndexCollect.push(itemIdx); }
      for (let i=0;i<id.length;i++) idxCollect.push(id[i] + vertBase);
      const added = id.length; const firstIndex = idxCollect.length - added;
      ranges.push({ itemIdx, firstIndex, indexCount: added, layerRef: it.layerRef||null });
      vertBase += v.length/2;
    }
    if (!vertsCollect.length || !idxCollect.length) { this._lodBuilt[lodIndex]=true; this._lodIndexCounts[lodIndex]=0; return; }
    const vArr=new Float32Array(vertsCollect); const idArr=new Uint32Array(idxCollect);
  const itemIdxF32=new Float32Array(itemIndexCollect.length); for (let i=0;i<itemIndexCollect.length;i++) itemIdxF32[i]=itemIndexCollect[i];
  this._cpuItemIndexLOD[lodIndex] = itemIdxF32.slice();
    const vbuf=device.createBuffer({ size:vArr.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(vbuf,0,vArr);
    const ibuf=device.createBuffer({ size:idArr.byteLength, usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(ibuf,0,idArr);
    const itemBuf=device.createBuffer({ size:itemIdxF32.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(itemBuf,0,itemIdxF32);
  this._lodVertexBuffers[lodIndex]=vbuf; this._lodIndexBuffers[lodIndex]=ibuf; this._lodItemIndexBuffers[lodIndex]=itemBuf; this._lodIndexCounts[lodIndex]=idArr.length; this._lodBuilt[lodIndex]=true; this._lodItemRanges[lodIndex]=ranges;
  }

  _chooseBatchLOD(zoom) {
    if (!this.items.length) return 0;
    const first=this.items[0];
    const tolerances = first._lodTolerances || [0];
    const threshold = (Polyline.allowedScreenErrorPx || 0.75) / Math.max(zoom,1e-6);
    let desired=0; for (let i=1;i<tolerances.length;i++){ if (tolerances[i] <= threshold) desired=i; else break; }
    let chosen=0; for (const t of this._prebuildTargets){ if (t <= desired && this._lodBuilt[t]) chosen=t; }
    if (!this._lodBuilt[chosen]) chosen=0; return chosen;
  }

  ensureStorage(device) {
    const floatsPerItem = 16;
    if (!this.itemCount) return;
    if (!this.storageBuffer || this._needsStorageRewrite) {
      const f=new Float32Array(this.itemCount*floatsPerItem);
      const u32=new Uint32Array(f.buffer);
      for (let i=0;i<this.items.length;i++) {
        const it=this.items[i];
        const color = it[this.colorProp] || it.color || it.fill || [1,1,1,1];
        const r=Math.min(255,Math.max(0,(color[0]*255)|0));
        const g=Math.min(255,Math.max(0,(color[1]*255)|0));
        const b=Math.min(255,Math.max(0,(color[2]*255)|0));
        const a=Math.min(255,Math.max(0,(color[3]*255)|0));
        const packed=(r)|(g<<8)|(b<<16)|(a<<24);
        const model=it.xform.toMat3();
        const o=i*floatsPerItem;
        u32[o]=packed; f[o+1]=0; f[o+2]=0; f[o+3]=0;
        f.set([model[0],model[1],model[2],0], o+4);
        f.set([model[3],model[4],model[5],0], o+8);
        f.set([model[6],model[7],model[8],0], o+12);
      }
      const bytes = f.byteLength;
      if (!this.storageBuffer || this.storageBuffer.size < bytes) {
        this.storageBuffer = device.createBuffer({ size:bytes, usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(this.storageBuffer,0,f);
      this._needsStorageRewrite = false;
    }
  }

  // Public: update alpha for all items (used for dynamic transparency changes without rebuild)
  updateAlpha(device, alpha) {
    alpha = Math.max(0, Math.min(1, alpha));
    if (!this.items || !this.items.length) return;
    for (const it of this.items) {
      const col = it[this.colorProp] || it.color || it.fill;
      if (col && col.length>=4) col[3] = alpha;
    }
    this._needsStorageRewrite = true; // trigger buffer rewrite next draw
  }

  draw({ device, pass, pipelines, viewUniformBuffer, zoom=1, canvasWidth=800, canvasHeight=600, instanceBuffer=null, instanceCount=0, layerVisibility=null }) {
    this.build(device);
    const lod = this._chooseBatchLOD(zoom);
    this._buildBatchLOD(device, lod);
    this.ensureStorage(device);
    const vbuf=this._lodVertexBuffers[lod]; const ibuf=this._lodIndexBuffers[lod]; const itemBuf=this._lodItemIndexBuffers[lod]; const idxCount=this._lodIndexCounts[lod]||0;
    if (!vbuf || !ibuf || !itemBuf || idxCount===0) return;
    const ranges = this._lodItemRanges[lod] || [];
    if (!this.bindGroup || this._lastStorageBuffer!==this.storageBuffer || this._lastViewUniformBuffer!==viewUniformBuffer) {
      this.bindGroup = device.createBindGroup({ layout: pipelines.storageBindGroupLayout, entries:[
        { binding:0, resource:{ buffer:this.storageBuffer } },
        { binding:1, resource:{ buffer:viewUniformBuffer } }
      ]});
      this._lastStorageBuffer=this.storageBuffer; this._lastViewUniformBuffer=viewUniformBuffer;
    }
  // Dynamic alpha handled via _needsStorageRewrite flag.
    const pipeline = instanceBuffer && instanceCount>0 ? pipelines.pipelinePolylineBatchInstanced : pipelines.pipelinePolylineBatch;
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vbuf);
    if (instanceBuffer && instanceCount>0) pass.setVertexBuffer(1, instanceBuffer);
    const itemSlot = instanceBuffer && instanceCount>0 ? 2 : 1;
    pass.setVertexBuffer(itemSlot, itemBuf);
    pass.setIndexBuffer(ibuf,'uint32');
    pass.setBindGroup(0, this.bindGroup);
    // Optional: coarse cull of items whose stroke width projects < 0.5 px at current zoom.
    // For fill batches (polygons) we keep them; only outline-like (colorProp==='color' && items[0].width) considered.
    if (this.colorProp==='color' && this.items.length && this.items[0].width) {
      const minPx = 0.5;
      const worldWidth = this.items[0].width; // assume similar widths in batch bucket
      if (worldWidth * zoom < minPx) {
        // Skip drawing entirely; below visibility threshold
        return;
      }
    }
    
    // Cull polygons by screen area (for fill batches only)
    const minScreenAreaPx = 4.0; // Same threshold as Polygon class
    const cullByArea = this.colorProp === 'fill';
    
    let needSeg=false;
    if (layerVisibility || cullByArea) {
      for (const r of ranges) { 
        if (r.layerRef && layerVisibility && layerVisibility[r.layerRef]===false) { 
          needSeg=true; 
          break; 
        }
        if (cullByArea) {
          const item = this.items[r.itemIdx];
          if (item && item._computeWorldBounds) {
            const bounds = item._computeWorldBounds();
            const worldWidth = bounds.maxX - bounds.minX;
            const worldHeight = bounds.maxY - bounds.minY;
            const screenArea = (worldWidth * zoom) * (worldHeight * zoom);
            if (screenArea < minScreenAreaPx) {
              needSeg = true;
              break;
            }
          }
        }
      }
    }
    const drawMult = instanceBuffer && instanceCount>0 ? instanceCount : 1;
    if (!needSeg) { pass.drawIndexed(idxCount, drawMult); return; }
    let runFirst=-1, runCount=0, anyDraw=false;
    function flush(){ if (runFirst>=0 && runCount>0){ pass.drawIndexed(runCount, drawMult, runFirst); } runFirst=-1; runCount=0; }
    for (const r of ranges) {
      let vis = !r.layerRef || !layerVisibility || layerVisibility[r.layerRef]!==false;
      
      // Also check screen area culling for polygons
      if (vis && cullByArea) {
        const item = this.items[r.itemIdx];
        if (item && item._computeWorldBounds) {
          const bounds = item._computeWorldBounds();
          const worldWidth = bounds.maxX - bounds.minX;
          const worldHeight = bounds.maxY - bounds.minY;
          const screenArea = (worldWidth * zoom) * (worldHeight * zoom);
          if (screenArea < minScreenAreaPx) {
            vis = false;
          }
        }
      }
      
      if (vis) {
        if (runFirst<0) { runFirst=r.firstIndex; runCount=r.indexCount; }
        else if (runFirst+runCount===r.firstIndex) { runCount+=r.indexCount; }
        else { flush(); runFirst=r.firstIndex; runCount=r.indexCount; }
        anyDraw=true;
      } else flush();
    }
    flush();
    if (!anyDraw) return;
  }
}
