import { ObjectRange } from "../types";
import { SceneState, getShaderKey, getRenderKey } from "./SceneState";

/** Move and rotation operation handling - preview and apply object transformations */
export class MoveOperations {
  // Component rotation tracking
  private componentCenter: { x: number; y: number } | null = null;
  private perObjectRotationOffsets: Map<number, { dx: number; dy: number }> = new Map();
  
  // Store original instance positions for rotation preview and cancel/restore
  private originalInstancePositions: Map<number, { x: number; y: number; packedRotVis: number }> = new Map();
  
  constructor(private sceneState: SceneState) {}

  /** Get current move offset for shader uniform */
  public getMoveOffset(): { x: number; y: number } {
    return { x: this.sceneState.globalMoveOffsetX, y: this.sceneState.globalMoveOffsetY };
  }

  /** Get current rotation offset for shader uniform (in radians) */
  public getRotationOffset(): number {
    // For component rotation, we handle rotation via position changes, not shader rotation
    // Return 0 so the shader doesn't also rotate individual pads
    if (this.componentCenter) {
      return 0;
    }
    return this.sceneState.globalRotationOffset;
  }
  
  /** Get per-object rotation translation offset for a specific object */
  public getObjectRotationOffset(objectId: number): { dx: number; dy: number } {
    return this.perObjectRotationOffsets.get(objectId) || { dx: 0, dy: 0 };
  }
  
  /** Check if we have valid component rotation set up */
  public hasComponentRotation(): boolean {
    return this.componentCenter !== null;
  }

  /** Start a move operation - marks objects as "moving" and stores original positions */
  public startMove(objects: ObjectRange[]) {
    this.sceneState.movingObjects = [...objects];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    this.sceneState.globalRotationOffset = 0;
    this.componentCenter = null;
    this.perObjectRotationOffsets.clear();
    this.originalInstancePositions.clear();
    
    // Store original positions for all instanced objects
    for (const range of objects) {
      this.setMovingFlag(range, true);
      
      // Store original position for instanced objects
      if (range.instance_index !== undefined && range.instance_index !== null) {
        const original = this.readInstancePosition(range);
        if (original) {
          this.originalInstancePositions.set(range.id, original);
        }
      }
    }
    console.log(`[Scene] Started move for ${objects.length} objects, stored ${this.originalInstancePositions.size} original positions`);
  }
  
  /** Set up component-based rotation using precomputed polar coordinates from Rust */
  public setupComponentRotation(objects: ObjectRange[]): boolean {
    if (objects.length === 0) return false;
    
    // Verify all objects belong to the same component and have polar coords
    const componentRef = objects[0].component_ref;
    if (!componentRef) {
      console.log('[Scene] Cannot set up component rotation: first object has no component_ref');
      return false;
    }
    
    // Check if we have precomputed polar coordinates (from Rust)
    const firstWithPolar = objects.find(o => o.component_center && o.polar_radius !== undefined);
    if (!firstWithPolar || !firstWithPolar.component_center) {
      console.log('[Scene] Cannot set up component rotation: no precomputed polar coordinates');
      return false;
    }
    
    for (const obj of objects) {
      if (obj.component_ref !== componentRef) {
        console.log('[Scene] Cannot set up component rotation: objects belong to different components');
        return false;
      }
    }
    
    // Use the precomputed component center from Rust
    this.componentCenter = {
      x: firstWithPolar.component_center[0],
      y: firstWithPolar.component_center[1]
    };
    
    // If we don't have polyline data yet, compute it now
    // This handles "rotate in place" where we need fresh polyline coords
    if (!this.hasComponentPolylineData()) {
      const hasBatchObjects = objects.some(o => o.obj_type === 0 || o.obj_type === 1);
      if (hasBatchObjects) {
        console.log('[Scene] Computing polyline local coords for rotation');
        this.computeComponentPolylineLocalCoords(objects);
      }
    }
    
    // If we have polyline data, clear the moving flag for polylines
    // We'll handle their movement directly via buffer writes, not shader moveOffset
    if (this.hasComponentPolylineData()) {
      for (const obj of objects) {
        if (obj.obj_type === 0 || obj.obj_type === 1) { // Polyline or polygon
          this.setMovingFlag(obj, false); // Set visibility to 2 (highlighted, not moving)
        }
      }
      console.log(`[Scene] Cleared moving flag for polylines - using direct buffer writes`);
    }
    
    console.log(`[Scene] Component rotation center (precomputed): (${this.componentCenter.x.toFixed(3)}, ${this.componentCenter.y.toFixed(3)}) for ${componentRef}`);
    return true;
  }

  /** Update move offset - shader applies this to "moving" objects */
  public updateMove(deltaX: number, deltaY: number) {
    // Store the logical move offset for endMove calculation
    this.sceneState.globalMoveOffsetX = deltaX;
    this.sceneState.globalMoveOffsetY = deltaY;
    
    // If we have component rotation, we write absolute positions directly to instance buffers
    // In this case, DON'T let the shader also add moveOffset (it would double-count)
    if (this.componentCenter) {
      for (const obj of this.sceneState.movingObjects) {
        const original = this.originalInstancePositions.get(obj.id);
        if (!original) continue;
        
        if (obj.instance_index !== undefined && obj.instance_index !== null) {
          const rotOffset = this.perObjectRotationOffsets.get(obj.id) || { dx: 0, dy: 0 };
          // Write absolute position: original + move + rotation offset
          // AND rotate individual pads by the component rotation angle
          this.writeInstancePositionPreview(obj,
            original.x + deltaX + rotOffset.dx,
            original.y + deltaY + rotOffset.dy,
            original.packedRotVis,
            this.sceneState.globalRotationOffset,  // Rotate pad by component rotation angle
            true  // DO rotate individual pad
          );
        }
      }
      
      // Also update polylines via direct buffer writes
      // (Their moving flag is cleared, so shader won't apply moveOffset)
      if (this.hasComponentPolylineData()) {
        this.rotateComponentPolylines(
          0, 0,  // Ignored - uses stored polylineComponentCenter
          this.sceneState.globalRotationOffset,
          deltaX,
          deltaY
        );
      }
    }
    
    this.sceneState.state.needsDraw = true;
  }

  /** Add rotation (90 degree increment by default) - rotates around component center using precomputed polar coords */
  public addRotation(angleDelta: number) {
    if (!this.componentCenter) {
      console.log('[Scene] Cannot rotate: no component center set up');
      return;
    }
    
    this.sceneState.globalRotationOffset += angleDelta;
    // Normalize to 0-2π range
    while (this.sceneState.globalRotationOffset >= Math.PI * 2) {
      this.sceneState.globalRotationOffset -= Math.PI * 2;
    }
    while (this.sceneState.globalRotationOffset < 0) {
      this.sceneState.globalRotationOffset += Math.PI * 2;
    }
    
    const cx = this.componentCenter.x;
    const cy = this.componentCenter.y;
    const rotationOffset = this.sceneState.globalRotationOffset;
    
    this.perObjectRotationOffsets.clear();
    
    for (const obj of this.sceneState.movingObjects) {
      const original = this.originalInstancePositions.get(obj.id);
      if (!original) continue;
      
      // Calculate rotation offset for this object using Cartesian rotation formula
      // (works for both instanced and batch objects)
      const objCenterX = (obj.bounds[0] + obj.bounds[2]) / 2;
      const objCenterY = (obj.bounds[1] + obj.bounds[3]) / 2;
      const relX = objCenterX - cx;
      const relY = objCenterY - cy;
      const cos = Math.cos(rotationOffset);
      const sin = Math.sin(rotationOffset);
      const newX = cx + relX * cos - relY * sin;
      const newY = cy + relX * sin + relY * cos;
      const dx = newX - objCenterX;
      const dy = newY - objCenterY;
      
      this.perObjectRotationOffsets.set(obj.id, { dx, dy });
      
      // Update preview: instanced objects get direct buffer writes, batch objects use shader uniform
      if (obj.instance_index !== undefined && obj.instance_index !== null && original) {
        // For component rotation: move pad position AND rotate the pad itself by the same angle
        this.writeInstancePositionPreview(obj, 
          original.x + this.sceneState.globalMoveOffsetX + dx,
          original.y + this.sceneState.globalMoveOffsetY + dy,
          original.packedRotVis,
          rotationOffset,  // Rotate pad by same angle as component rotation
          true  // DO rotate individual pad
        );
      }
      // Note: Batch objects (polylines/polygons) are handled separately below
    }
    
    // Rotate component polylines if we have their local coords
    if (this.hasComponentPolylineData()) {
      this.rotateComponentPolylines(
        cx, cy,
        rotationOffset,
        this.sceneState.globalMoveOffsetX,
        this.sceneState.globalMoveOffsetY
      );
    }
    
    this.sceneState.state.needsDraw = true;
    console.log(`[Scene] Rotation offset: ${(this.sceneState.globalRotationOffset * 180 / Math.PI).toFixed(1)}° around component center`);
  }

  /** Finalize move - apply delta to positions, clear moving flags */
  public endMove(): { 
    deltaX: number; 
    deltaY: number; 
    rotationDelta: number;
    perObjectOffsets: Map<number, { dx: number; dy: number }>;
    componentCenter: { x: number; y: number } | null;
  } {
    const result = { 
      deltaX: this.sceneState.globalMoveOffsetX, 
      deltaY: this.sceneState.globalMoveOffsetY,
      rotationDelta: this.sceneState.globalRotationOffset,
      perObjectOffsets: new Map(this.perObjectRotationOffsets),
      componentCenter: this.componentCenter
    };
    
    for (const range of this.sceneState.movingObjects) {
      if (this.componentCenter) {
        // Component rotation: finalize with moving flag cleared
        if (range.instance_index !== undefined && range.instance_index !== null) {
          const original = this.originalInstancePositions.get(range.id);
          if (original) {
            // Use Cartesian rotation formula (same as preview)
            const rotOffset = this.perObjectRotationOffsets.get(range.id) || { dx: 0, dy: 0 };
            const finalX = original.x + result.deltaX + rotOffset.dx;
            const finalY = original.y + result.deltaY + rotOffset.dy;
            
            // For component rotation: rotate individual pads by the component rotation angle
            // Calculate final rotation = original + component rotation delta
            const originalRotBits = (original.packedRotVis >>> 16) & 0xFFFF;
            const originalAngle = (originalRotBits / 65535) * Math.PI * 2;
            let finalAngle = originalAngle + result.rotationDelta;
            while (finalAngle >= Math.PI * 2) finalAngle -= Math.PI * 2;
            while (finalAngle < 0) finalAngle += Math.PI * 2;
            const finalRotBits = Math.round((finalAngle / (Math.PI * 2)) * 65535) & 0xFFFF;
            const flagBits = original.packedRotVis & 0x3; // keep visible and highlighted, clear moving
            const finalPacked = (finalRotBits << 16) | flagBits;
            
            // Write to CPU buffers and sync to GPU
            this.finalizeInstancePosition(range, finalX, finalY, finalPacked);
          }
        } else {
          // Batch objects during component rotation
          // Check if this object is handled by our polyline rotation system
          const isHandledByPolylineRotation = this.componentPolylineData.has(range.id);
          
          if (isHandledByPolylineRotation) {
            // Polylines with rotation data: positions already written to buffer during preview
            // Just clear the moving flag (already cleared in setupComponentRotation, but ensure it)
            this.setMovingFlag(range, false);
          } else {
            // Other batch objects not in our polyline system
            const rotOffset = this.perObjectRotationOffsets.get(range.id) || { dx: 0, dy: 0 };
            const totalDx = result.deltaX + rotOffset.dx;
            const totalDy = result.deltaY + rotOffset.dy;
            this.applyDeltaToBatch(range, totalDx, totalDy, 0);
            this.setMovingFlag(range, false);
          }
        }
      } else {
        // Regular move (no component rotation): apply delta normally
        const rotOffset = this.perObjectRotationOffsets.get(range.id) || { dx: 0, dy: 0 };
        const totalDx = result.deltaX + rotOffset.dx;
        const totalDy = result.deltaY + rotOffset.dy;
        
        if (range.instance_index !== undefined && range.instance_index !== null) {
          this.applyDeltaToInstance(range, totalDx, totalDy, result.rotationDelta);
        } else {
          this.applyDeltaToBatch(range, totalDx, totalDy, result.rotationDelta);
        }
        this.setMovingFlag(range, false);
      }
    }
    
    // Finalize component polyline data (update originalCoords, localCoords, center)
    // Do this for ANY move with component rotation, not just when there's rotation
    if (this.hasComponentPolylineData() && this.componentCenter) {
      const hasMoved = Math.abs(result.deltaX) > 0.0001 || Math.abs(result.deltaY) > 0.0001;
      const hasRotated = Math.abs(result.rotationDelta) > 0.0001;
      
      if (hasMoved || hasRotated) {
        const newCenterX = this.componentCenter.x + result.deltaX;
        const newCenterY = this.componentCenter.y + result.deltaY;
        this.finalizeComponentPolylineRotation(
          newCenterX, newCenterY,
          result.rotationDelta,
          result.deltaX, result.deltaY
        );
      }
    }
    
    // Clear polyline rotation data - will be recomputed fresh on next highlight
    this.clearComponentPolylineData();
    
    this.sceneState.movingObjects = [];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    this.sceneState.globalRotationOffset = 0;
    this.componentCenter = null;
    this.perObjectRotationOffsets.clear();
    this.originalInstancePositions.clear();
    this.sceneState.state.needsDraw = true;
    
    console.log(`[Scene] Move ended, delta: (${result.deltaX.toFixed(3)}, ${result.deltaY.toFixed(3)}), rotation: ${(result.rotationDelta * 180 / Math.PI).toFixed(1)}°`);
    return result;
  }

  /** Cancel move - clear moving flags without applying, restore original positions */
  public cancelMove() {
    // Restore original positions if we were doing component rotation
    if (this.componentCenter) {
      for (const range of this.sceneState.movingObjects) {
        const original = this.originalInstancePositions.get(range.id);
        if (original && range.instance_index !== undefined && range.instance_index !== null) {
          // Restore to original position AND original rotation
          this.writeInstancePositionPreview(range, original.x, original.y, original.packedRotVis, 0, true);
        }
      }
      
      // Restore polylines to original positions
      if (this.hasComponentPolylineData()) {
        this.restoreComponentPolylines();
      }
    }
    
    for (const range of this.sceneState.movingObjects) {
      this.setMovingFlag(range, false);
    }
    
    // Clear polyline rotation data
    this.clearComponentPolylineData();
    
    this.sceneState.movingObjects = [];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    this.sceneState.globalRotationOffset = 0;
    this.componentCenter = null;
    this.perObjectRotationOffsets.clear();
    this.originalInstancePositions.clear();
    this.sceneState.state.needsDraw = true;
    console.log('[Scene] Move cancelled');
  }

  /** Apply delta to objects directly (for undo/redo) */
  public applyMoveOffset(objects: ObjectRange[], deltaX: number, deltaY: number) {
    console.log(`[MoveOps.applyMoveOffset] deltaX=${deltaX.toFixed(4)}, deltaY=${deltaY.toFixed(4)}, objects=${objects.length}`);
    for (const range of objects) {
      if (range.instance_index !== undefined && range.instance_index !== null) {
        this.applyDeltaToInstance(range, deltaX, deltaY, 0);
      } else {
        console.log(`[MoveOps.applyMoveOffset] Batch obj id=${range.id} type=${range.obj_type}`);
        this.applyDeltaToBatch(range, deltaX, deltaY, 0);
      }
    }
    this.sceneState.state.needsDraw = true;
  }

  /** Apply rotation to objects directly (for undo/redo) with component center
   * If preCalculatedOffsets is provided, use those instead of calculating from bounds */
  public applyRotation(
    objects: ObjectRange[], 
    rotationDelta: number, 
    componentCenter?: { x: number; y: number },
    preCalculatedOffsets?: Map<number, { dx: number; dy: number }>
  ) {
    // Use pre-calculated offsets if provided, otherwise calculate from bounds
    let perObjectOffsets: Map<number, { dx: number; dy: number }> | null = preCalculatedOffsets || null;
    
    if (!perObjectOffsets && componentCenter) {
      perObjectOffsets = new Map();
      const cos = Math.cos(rotationDelta);
      const sin = Math.sin(rotationDelta);
      
      for (const obj of objects) {
        const objCenterX = (obj.bounds[0] + obj.bounds[2]) / 2;
        const objCenterY = (obj.bounds[1] + obj.bounds[3]) / 2;
        const relX = objCenterX - componentCenter.x;
        const relY = objCenterY - componentCenter.y;
        const newX = componentCenter.x + relX * cos - relY * sin;
        const newY = componentCenter.y + relX * sin + relY * cos;
        perObjectOffsets.set(obj.id, { dx: newX - objCenterX, dy: newY - objCenterY });
      }
    }
    
    for (const range of objects) {
      if (range.instance_index !== undefined && range.instance_index !== null) {
        const offset = perObjectOffsets?.get(range.id) || { dx: 0, dy: 0 };
        this.applyDeltaToInstance(range, offset.dx, offset.dy, rotationDelta);
      } else if (componentCenter) {
        // Batch objects (polylines/polygons): rotate ALL vertices around component center
        this.rotateBatchAroundCenter(range, rotationDelta, componentCenter);
      }
    }
    this.sceneState.state.needsDraw = true;
  }
  
  /** Rotate batch object vertices around a center point (for undo/redo) */
  private rotateBatchAroundCenter(range: ObjectRange, rotationDelta: number, center: { x: number; y: number }) {
    console.log(`[MoveOps.rotateBatchAroundCenter] id=${range.id} rotDelta=${rotationDelta.toFixed(6)} (${(rotationDelta*180/Math.PI).toFixed(2)}°) center=(${center.x.toFixed(4)}, ${center.y.toFixed(4)})`);
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const cos = Math.cos(rotationDelta);
    const sin = Math.sin(rotationDelta);
    const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVertexBuffers.length);
    
    for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
      const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
      const gpuBuffer = renderData.lodBuffers[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const [start, count] = range.vertex_ranges[lodIndex] || [0, 0];
      if (count === 0) continue;
      
      const floatStart = start * 2;
      const floatCount = count * 2;
      if (floatStart + floatCount > cpuBuffer.length) continue;
      
      // Rotate each vertex around the center
      // Log first vertex before/after for debugging
      if (count > 0) {
        const firstX = cpuBuffer[floatStart];
        const firstY = cpuBuffer[floatStart + 1];
        console.log(`[MoveOps.rotateBatchAroundCenter] LOD${lodIndex} count=${count} firstVertex BEFORE: (${firstX.toFixed(4)}, ${firstY.toFixed(4)})`);
      }
      for (let i = 0; i < count; i++) {
        const idx = floatStart + i * 2;
        const x = cpuBuffer[idx];
        const y = cpuBuffer[idx + 1];
        
        // Translate to origin, rotate, translate back
        const relX = x - center.x;
        const relY = y - center.y;
        const newX = center.x + relX * cos - relY * sin;
        const newY = center.y + relX * sin + relY * cos;
        
        cpuBuffer[idx] = newX;
        cpuBuffer[idx + 1] = newY;
      }
      // Log first vertex after
      if (count > 0) {
        const firstX = cpuBuffer[floatStart];
        const firstY = cpuBuffer[floatStart + 1];
        console.log(`[MoveOps.rotateBatchAroundCenter] LOD${lodIndex} firstVertex AFTER: (${firstX.toFixed(4)}, ${firstY.toFixed(4)})`);
      }
      
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, floatStart * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + floatStart * 4, floatCount * 4
      );
    }
  }

  // ==================== Private Helpers ====================

  /** Read current instance position from CPU buffer */
  private readInstancePosition(range: ObjectRange): { x: number; y: number; packedRotVis: number } | null {
    if (range.instance_index === undefined || range.instance_index === null) return null;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return null;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData || renderData.cpuInstanceBuffers.length === 0) return null;
    
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    const lodIndex = shapeIdx; // LOD 0
    
    if (lodIndex >= totalLODs) return null;
    
    const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
    if (!cpuBuffer) return null;
    
    const offset = range.instance_index * 3;
    if (offset + 2 >= cpuBuffer.length) return null;
    
    const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
    return {
      x: cpuBuffer[offset],
      y: cpuBuffer[offset + 1],
      packedRotVis: view.getUint32((offset + 2) * 4, true)
    };
  }

  /** Write instance position for preview (updates CPU buffer and GPU)
   * @param rotateIndividualPad - if true, also rotates the pad itself; if false, only moves position (for component rotation)
   */
  private writeInstancePositionPreview(range: ObjectRange, x: number, y: number, originalPackedRotVis: number, rotationDelta: number, rotateIndividualPad: boolean = true) {
    if (range.instance_index === undefined || range.instance_index === null) return;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    // Update all LOD levels
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const offset = range.instance_index * 3;
      if (offset + 2 >= cpuBuffer.length) continue;
      
      // Update position
      cpuBuffer[offset] = x;
      cpuBuffer[offset + 1] = y;
      
      // Update packed rotation/flags
      // ALWAYS clear moving bit (bit 2) since we're writing absolute positions
      // The shader should NOT add moveOffset on top
      const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
      let newPacked: number;
      
      // Preserve visible & highlighted (bits 0-1), CLEAR moving bit (bit 2)
      const flagBits = originalPackedRotVis & 0x3;
      
      if (rotateIndividualPad && Math.abs(rotationDelta) > 0.001) {
        // Rotate the pad itself (add delta to original rotation)
        const originalAngleU16 = originalPackedRotVis >>> 16;
        const originalAngle = (originalAngleU16 / 65535) * Math.PI * 2;
        
        let newAngle = originalAngle + rotationDelta;
        while (newAngle >= Math.PI * 2) newAngle -= Math.PI * 2;
        while (newAngle < 0) newAngle += Math.PI * 2;
        
        const newAngleU16 = Math.round((newAngle / (Math.PI * 2)) * 65535) & 0xFFFF;
        newPacked = (newAngleU16 << 16) | flagBits;
      } else {
        // Keep original rotation
        const rotBits = originalPackedRotVis & 0xFFFF0000;
        newPacked = rotBits | flagBits;
      }
      
      view.setUint32((offset + 2) * 4, newPacked, true);
      
      // Write to GPU
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 12
      );
    }
  }

  /** Finalize instance position after component rotation (write absolute values, clear moving flag) */
  private finalizeInstancePosition(range: ObjectRange, x: number, y: number, packedValue: number) {
    if (range.instance_index === undefined || range.instance_index === null) return;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    // Update all LOD levels
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const offset = range.instance_index * 3;
      if (offset + 2 >= cpuBuffer.length) continue;
      
      // Write absolute position
      cpuBuffer[offset] = x;
      cpuBuffer[offset + 1] = y;
      
      // Write packed rotation + flags (moving flag should be cleared already)
      const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
      view.setUint32((offset + 2) * 4, packedValue, true);
      
      // Write to GPU
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 12
      );
    }
  }

  /** Update instance position in CPU buffer during move preview (without applying permanently) */
  private updateInstancePosition(range: ObjectRange, totalDx: number, totalDy: number) {
    if (range.instance_index === undefined || range.instance_index === null) return;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    // We need to store original positions to compute the preview offset
    // For now, we'll rely on the shader's moveOffset uniform for batch move
    // and only update instance buffer for rotation-induced translation
    // This is handled in the shader via moveOffset uniform + per-instance rotation offset
    // So we don't need to do anything here for the preview - the shader handles it
    // The permanent apply happens in applyDeltaToInstance when endMove is called
  }

  private setMovingFlag(range: ObjectRange, moving: boolean) {
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    if (shaderKey === 'batch' || shaderKey === 'batch_colored') {
      // Batch: visibility 3.0 = moving, 2.0 = highlighted
      const targetVis = moving ? 3.0 : 2.0;
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const [start, count] = range.vertex_ranges[lodIndex] || [0, 0];
        if (count === 0) continue;
        
        for (let i = start; i < start + count && i < cpuBuffer.length; i++) {
          cpuBuffer[i] = targetVis;
        }
        
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4
        );
      }
    } else if (range.instance_index !== undefined && range.instance_index !== null) {
      // Instanced: bit 2 (value 4) = moving flag
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs) continue;
        
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const offset = range.instance_index * 3 + 2;
        if (offset >= cpuBuffer.length) continue;
        
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        const newPacked = moving ? (packed | 4) : (packed & ~4);
        view.setUint32(offset * 4, newPacked, true);
        
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4
        );
      }
    }
  }

  private applyDeltaToInstance(range: ObjectRange, deltaX: number, deltaY: number, rotationDelta: number) {
    if (range.instance_index === undefined || range.instance_index === null) return;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const offset = range.instance_index * 3;
      if (offset + 2 >= cpuBuffer.length) continue;
      
      // Apply translation delta
      cpuBuffer[offset] += deltaX;
      cpuBuffer[offset + 1] += deltaY;
      
      // Apply rotation delta if non-zero
      if (Math.abs(rotationDelta) > 0.001) {
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32((offset + 2) * 4, true);
        
        // Extract current angle (top 16 bits)
        const currentAngleU16 = packed >>> 16;
        const currentAngle = (currentAngleU16 / 65535) * Math.PI * 2;
        
        // Add delta and normalize
        let newAngle = currentAngle + rotationDelta;
        while (newAngle >= Math.PI * 2) newAngle -= Math.PI * 2;
        while (newAngle < 0) newAngle += Math.PI * 2;
        
        // Pack back into top 16 bits
        const newAngleU16 = Math.round((newAngle / (Math.PI * 2)) * 65535) & 0xFFFF;
        const newPacked = (packed & 0xFFFF) | (newAngleU16 << 16);
        view.setUint32((offset + 2) * 4, newPacked, true);
      }
      
      // Write all 3 floats (x, y, packed) to GPU
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 12
      );
    }
  }

  private applyDeltaToBatch(range: ObjectRange, deltaX: number, deltaY: number, _rotationDelta: number) {
    // Note: rotationDelta is ignored for batch objects - would require re-tessellation
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVertexBuffers.length);
    console.log(`[MoveOps.applyDeltaToBatch] id=${range.id} delta=(${deltaX.toFixed(4)}, ${deltaY.toFixed(4)}) numLods=${numLods}`);
    
    for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
      const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
      const gpuBuffer = renderData.lodBuffers[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const [start, count] = range.vertex_ranges[lodIndex] || [0, 0];
      if (count === 0) continue;
      
      const floatStart = start * 2;
      const floatCount = count * 2;
      if (floatStart + floatCount > cpuBuffer.length) continue;
      
      // Log first vertex before
      if (count > 0) {
        console.log(`[MoveOps.applyDeltaToBatch] LOD${lodIndex} count=${count} firstVertex BEFORE: (${cpuBuffer[floatStart].toFixed(4)}, ${cpuBuffer[floatStart+1].toFixed(4)})`);
      }
      
      for (let i = 0; i < count; i++) {
        const idx = floatStart + i * 2;
        cpuBuffer[idx] += deltaX;
        cpuBuffer[idx + 1] += deltaY;
      }
      
      // Log first vertex after
      if (count > 0) {
        console.log(`[MoveOps.applyDeltaToBatch] LOD${lodIndex} firstVertex AFTER: (${cpuBuffer[floatStart].toFixed(4)}, ${cpuBuffer[floatStart+1].toFixed(4)})`);
      }
      
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, floatStart * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + floatStart * 4, floatCount * 4
      );
    }
  }

  // ==================== Component Polyline Rotation ====================
  
  /** 
   * Stored polyline data for component rotation.
   * Maps object_id to per-LOD local coordinates and buffer locations.
   */
  private componentPolylineData: Map<number, {
    layerId: string;
    lods: Array<{
      floatStart: number;  // Start index in CPU vertex buffer
      floatCount: number;  // Number of floats (count * 2)
      localCoords: Float32Array;  // [lx0, ly0, lx1, ly1, ...] relative to component center
      originalCoords: Float32Array;  // [x0, y0, x1, y1, ...] original world coords
    }>;
  }> = new Map();
  
  /** Component center for polyline rotation (separate from instance rotation center) */
  private polylineComponentCenter: { x: number; y: number } | null = null;

  /**
   * Compute and store local coordinates for polylines in a component.
   * This enables polyline rotation by transforming vertices client-side.
   * Called when a single component is highlighted.
   */
  public computeComponentPolylineLocalCoords(objects: ObjectRange[]) {
    this.componentPolylineData.clear();
    this.polylineComponentCenter = null;
    
    // Find polylines (obj_type 0) and polygons (obj_type 1) - batch rendered objects
    const batchObjects = objects.filter(o => o.obj_type === 0 || o.obj_type === 1);
    
    if (batchObjects.length === 0) {
      console.log('[MoveOps] No polylines/polygons in component selection');
      return;
    }
    
    // Get component center from any object with polar coords
    const objWithCenter = objects.find(o => o.component_center);
    if (!objWithCenter || !objWithCenter.component_center) {
      console.log('[MoveOps] No component center found in selection');
      return;
    }
    
    const centerX = objWithCenter.component_center[0];
    const centerY = objWithCenter.component_center[1];
    this.polylineComponentCenter = { x: centerX, y: centerY };
    
    console.log(`[MoveOps] Computing local coords for ${batchObjects.length} batch objects, center: (${centerX.toFixed(3)}, ${centerY.toFixed(3)})`);
    
    let totalVertices = 0;
    
    for (const obj of batchObjects) {
      const shaderKey = getShaderKey(obj.obj_type);
      if (!shaderKey) continue;
      
      const renderKey = getRenderKey(obj.layer_id, shaderKey);
      const renderData = this.sceneState.layerRenderData.get(renderKey);
      if (!renderData) continue;
      
      const numLods = Math.min(obj.vertex_ranges.length, renderData.cpuVertexBuffers.length);
      const lods: Array<{
        floatStart: number;
        floatCount: number;
        localCoords: Float32Array;
        originalCoords: Float32Array;
      }> = [];
      
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
        if (!cpuBuffer) continue;
        
        const vertexRange = obj.vertex_ranges[lodIndex];
        if (!vertexRange) continue;
        
        const [start, count] = vertexRange;
        if (count === 0) continue;
        
        const floatStart = start * 2;
        const floatCount = count * 2;
        if (floatStart + floatCount > cpuBuffer.length) continue;
        
        // Extract and compute local coordinates for this LOD
        const localCoords = new Float32Array(floatCount);
        const originalCoords = new Float32Array(floatCount);
        
        for (let i = 0; i < count; i++) {
          const idx = floatStart + i * 2;
          const worldX = cpuBuffer[idx];
          const worldY = cpuBuffer[idx + 1];
          
          originalCoords[i * 2] = worldX;
          originalCoords[i * 2 + 1] = worldY;
          
          localCoords[i * 2] = worldX - centerX;
          localCoords[i * 2 + 1] = worldY - centerY;
        }
        
        lods.push({ floatStart, floatCount, localCoords, originalCoords });
        totalVertices += count;
      }
      
      if (lods.length > 0) {
        this.componentPolylineData.set(obj.id, { layerId: obj.layer_id, lods });
      }
    }
    
    console.log(`[MoveOps] Stored local coords for ${this.componentPolylineData.size} polylines (${totalVertices} vertices total)`);
  }
  
  /**
   * Clear stored component polyline data.
   */
  public clearComponentPolylineData() {
    this.componentPolylineData.clear();
    this.polylineComponentCenter = null;
    console.log('[MoveOps] Cleared component polyline data');
  }
  
  /**
   * Check if component polyline data is loaded.
   */
  public hasComponentPolylineData(): boolean {
    return this.componentPolylineData.size > 0 && this.polylineComponentCenter !== null;
  }
  
  /**
   * Rotate component polylines by transforming their vertices.
   * Called from addRotation to update polyline geometry during rotation preview.
   */
  public rotateComponentPolylines(
    _centerX: number, _centerY: number,  // Ignored - use stored polylineComponentCenter
    totalRotation: number,
    deltaX: number, deltaY: number
  ) {
    if (!this.hasComponentPolylineData() || !this.polylineComponentCenter) return;
    
    // MUST use polylineComponentCenter since local coords were computed relative to it
    const centerX = this.polylineComponentCenter.x;
    const centerY = this.polylineComponentCenter.y;
    
    const cos = Math.cos(totalRotation);
    const sin = Math.sin(totalRotation);
    
    for (const [objId, data] of this.componentPolylineData) {
      const shaderKey = 'batch'; // Polylines/polygons use batch
      const renderKey = getRenderKey(data.layerId, shaderKey);
      const renderData = this.sceneState.layerRenderData.get(renderKey);
      if (!renderData) continue;
      
      // Update ALL LODs using per-LOD stored local coords
      for (let lodIndex = 0; lodIndex < data.lods.length; lodIndex++) {
        const lodData = data.lods[lodIndex];
        if (!lodData) continue;
        
        const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
        const gpuBuffer = renderData.lodBuffers[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const { floatStart, floatCount, localCoords } = lodData;
        const count = floatCount / 2;
        
        if (floatStart + floatCount > cpuBuffer.length) continue;
        
        // Use this LOD's stored local coords
        for (let i = 0; i < count; i++) {
          const lx = localCoords[i * 2];
          const ly = localCoords[i * 2 + 1];
          
          // Rotate local coords around origin, then translate to moved center
          const newX = centerX + deltaX + lx * cos - ly * sin;
          const newY = centerY + deltaY + lx * sin + ly * cos;
          
          const idx = floatStart + i * 2;
          cpuBuffer[idx] = newX;
          cpuBuffer[idx + 1] = newY;
        }
        
        // Write to GPU
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer,
          floatStart * 4,
          cpuBuffer.buffer,
          cpuBuffer.byteOffset + floatStart * 4,
          floatCount * 4
        );
      }
    }
    
    this.sceneState.state.needsDraw = true;
  }
  
  /**
   * Restore component polylines to their original positions.
   * Called when canceling a rotation or on undo.
   */
  public restoreComponentPolylines() {
    if (!this.hasComponentPolylineData()) return;
    
    console.log(`[MoveOps] Restoring ${this.componentPolylineData.size} polylines to original positions`);
    
    for (const [objId, data] of this.componentPolylineData) {
      const shaderKey = 'batch';
      const renderKey = getRenderKey(data.layerId, shaderKey);
      const renderData = this.sceneState.layerRenderData.get(renderKey);
      if (!renderData) continue;
      
      // Restore ALL LODs using per-LOD stored original coords
      for (let lodIndex = 0; lodIndex < data.lods.length; lodIndex++) {
        const lodData = data.lods[lodIndex];
        if (!lodData) continue;
        
        const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
        const gpuBuffer = renderData.lodBuffers[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const { floatStart, floatCount, originalCoords } = lodData;
        const count = floatCount / 2;
        
        if (floatStart + floatCount > cpuBuffer.length) continue;
        
        // Restore original coordinates for this LOD
        for (let i = 0; i < count; i++) {
          const idx = floatStart + i * 2;
          cpuBuffer[idx] = originalCoords[i * 2];
          cpuBuffer[idx + 1] = originalCoords[i * 2 + 1];
        }
        
        // Write to GPU
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer,
          floatStart * 4,
          cpuBuffer.buffer,
          cpuBuffer.byteOffset + floatStart * 4,
          floatCount * 4
        );
      }
    }
    
    this.sceneState.state.needsDraw = true;
  }
  
  /**
   * Finalize component polyline rotation - update stored local coords for subsequent rotations.
   * Called after a rotation is applied (in endMove).
   */
  public finalizeComponentPolylineRotation(
    newCenterX: number, newCenterY: number,
    totalRotation: number,
    deltaX: number, deltaY: number
  ) {
    if (!this.hasComponentPolylineData() || !this.polylineComponentCenter) return;
    
    const oldCenter = this.polylineComponentCenter;
    const cos = Math.cos(totalRotation);
    const sin = Math.sin(totalRotation);
    
    console.log(`[MoveOps] Finalizing polyline rotation: center (${oldCenter.x.toFixed(3)}, ${oldCenter.y.toFixed(3)}) -> (${newCenterX.toFixed(3)}, ${newCenterY.toFixed(3)}), angle=${(totalRotation * 180 / Math.PI).toFixed(1)}°`);
    
    for (const [_objId, data] of this.componentPolylineData) {
      const vertexCount = data.floatCount / 2;
      
      for (let i = 0; i < vertexCount; i++) {
        const lx = data.localCoords[i * 2];
        const ly = data.localCoords[i * 2 + 1];
        
        // Compute new world position
        const newX = oldCenter.x + deltaX + lx * cos - ly * sin;
        const newY = oldCenter.y + deltaY + lx * sin + ly * cos;
        
        // Update original coords to new world position
        data.originalCoords[i * 2] = newX;
        data.originalCoords[i * 2 + 1] = newY;
        
        // Update local coords relative to new center
        data.localCoords[i * 2] = newX - newCenterX;
        data.localCoords[i * 2 + 1] = newY - newCenterY;
      }
    }
    
    // Update stored center
    this.polylineComponentCenter = { x: newCenterX, y: newCenterY };
  }
}
