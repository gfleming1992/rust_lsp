// Re-export modules for direct access if needed
export { SceneState, ScenePipelines, hashStr, getShaderKey, getRenderKey } from "./SceneState";
export { LayerLoader } from "./LayerLoader";
export { ObjectVisibility } from "./ObjectVisibility";
export { MoveOperations } from "./MoveOperations";
export { DrcOverlay } from "./DrcOverlay";

import { LayerJSON, LayerColor, ObjectRange, DrcRegion } from "../types";
import { SceneState, ScenePipelines } from "./SceneState";
import { LayerLoader } from "./LayerLoader";
import { ObjectVisibility } from "./ObjectVisibility";
import { MoveOperations } from "./MoveOperations";
import { DrcOverlay } from "./DrcOverlay";

/**
 * Unified Scene class - composes functionality from specialized modules
 * 
 * Modules:
 * - SceneState: Core state, colors, visibility settings
 * - LayerLoader: Loading layer geometry data
 * - ObjectVisibility: Hiding/showing/highlighting objects
 * - MoveOperations: Object movement (preview and apply)
 * - DrcOverlay: DRC violation regions display
 */
export class Scene {
  private sceneState: SceneState;
  private layerLoader: LayerLoader;
  private objectVisibility: ObjectVisibility;
  private moveOperations: MoveOperations;
  private drcOverlay: DrcOverlay;

  constructor() {
    this.sceneState = new SceneState();
    this.layerLoader = new LayerLoader(this.sceneState);
    this.objectVisibility = new ObjectVisibility(this.sceneState);
    this.moveOperations = new MoveOperations(this.sceneState);
    this.drcOverlay = new DrcOverlay(this.sceneState);
  }

  // ==================== State Access ====================
  
  /** Get the underlying state for direct access (e.g., by Renderer) */
  public getState() { return this.sceneState; }
  
  public get state() { return this.sceneState.state; }
  public get layerRenderData() { return this.sceneState.layerRenderData; }
  public get layerInfoMap() { return this.sceneState.layerInfoMap; }
  public get layerOrder() { return this.sceneState.layerOrder; }
  public set layerOrder(order: string[]) { this.sceneState.layerOrder = order; }
  public get layerColors() { return this.sceneState.layerColors; }
  public get layerVisible() { return this.sceneState.layerVisible; }
  public get viasVisible() { return this.sceneState.viasVisible; }
  public set viasVisible(v: boolean) { this.sceneState.viasVisible = v; }
  public get movingObjects() { return this.sceneState.movingObjects; }
  
  // DRC state access
  public get drcRegions() { return this.sceneState.drcRegions; }
  public get drcEnabled() { return this.sceneState.drcEnabled; }
  public set drcEnabled(v: boolean) { this.sceneState.drcEnabled = v; }
  public get drcCurrentIndex() { return this.sceneState.drcCurrentIndex; }
  public get drcVertexBuffer() { return this.sceneState.drcVertexBuffer; }
  public get drcTriangleCount() { return this.sceneState.drcTriangleCount; }

  // GPU access
  public get device() { return this.sceneState.device; }
  public get pipelines() { return this.sceneState.pipelines; }
  public get uniformData() { return this.sceneState.uniformData; }

  // ==================== Device Setup ====================

  public setDevice(device: GPUDevice, pipelines: ScenePipelines) {
    this.sceneState.setDevice(device, pipelines);
  }

  // ==================== Color Management ====================

  public getLayerColor(layerId: string): LayerColor {
    return this.sceneState.getLayerColor(layerId);
  }

  public setLayerColor(layerId: string, color: LayerColor) {
    this.sceneState.setLayerColor(layerId, color);
  }

  public resetLayerColor(layerId: string) {
    this.sceneState.resetLayerColor(layerId);
  }

  public toggleLayerVisibility(layerId: string, visible: boolean) {
    this.sceneState.toggleLayerVisibility(layerId, visible);
  }

  // ==================== Layer Loading ====================

  public loadLayerData(layerJson: LayerJSON) {
    this.layerLoader.loadLayerData(layerJson);
  }

  // ==================== Object Visibility ====================

  public hideObject(range: ObjectRange) {
    this.objectVisibility.hideObject(range);
  }

  public showObject(range: ObjectRange) {
    this.objectVisibility.showObject(range);
  }

  public highlightObject(range: ObjectRange) {
    this.objectVisibility.highlightObject(range);
  }

  public highlightMultipleObjects(ranges: ObjectRange[]) {
    this.objectVisibility.highlightMultipleObjects(ranges);
  }

  public clearHighlightObject() {
    this.objectVisibility.clearHighlightObject();
  }

  // ==================== Move Operations ====================

  public getMoveOffset() {
    return this.moveOperations.getMoveOffset();
  }

  public getRotationOffset() {
    return this.moveOperations.getRotationOffset();
  }

  public startMove(objects: ObjectRange[]) {
    this.moveOperations.startMove(objects);
  }
  
  public setupComponentRotation(objects: ObjectRange[]): boolean {
    return this.moveOperations.setupComponentRotation(objects);
  }
  
  public hasComponentRotation(): boolean {
    return this.moveOperations.hasComponentRotation();
  }

  public updateMove(deltaX: number, deltaY: number) {
    this.moveOperations.updateMove(deltaX, deltaY);
  }

  public addRotation(angleDelta: number) {
    this.moveOperations.addRotation(angleDelta);
  }

  public endMove() {
    return this.moveOperations.endMove();
  }

  public cancelMove() {
    this.moveOperations.cancelMove();
  }

  public applyMoveOffset(objects: ObjectRange[], deltaX: number, deltaY: number) {
    this.moveOperations.applyMoveOffset(objects, deltaX, deltaY);
  }

  public applyRotation(
    objects: ObjectRange[], 
    rotationDelta: number, 
    componentCenter?: { x: number; y: number },
    preCalculatedOffsets?: Map<number, { dx: number; dy: number }>
  ) {
    this.moveOperations.applyRotation(objects, rotationDelta, componentCenter, preCalculatedOffsets);
  }

  // ==================== Component Polyline Rotation ====================
  
  /**
   * Compute and store local coordinates for polylines in a component.
   * This enables polyline rotation by transforming vertices client-side.
   */
  public computeComponentPolylineLocalCoords(objects: ObjectRange[]) {
    this.moveOperations.computeComponentPolylineLocalCoords(objects);
  }
  
  /**
   * Clear stored component polyline data.
   * Called when selection changes or rotation is disabled.
   */
  public clearComponentPolylineData() {
    this.moveOperations.clearComponentPolylineData();
  }
  
  /**
   * Check if component polyline data is loaded for rotation.
   */
  public hasComponentPolylineData(): boolean {
    return this.moveOperations.hasComponentPolylineData();
  }

  // ==================== DRC Overlay ====================

  public loadDrcRegions(regions: DrcRegion[]) {
    this.drcOverlay.loadDrcRegions(regions);
  }

  public navigateToDrcRegion(index: number) {
    return this.drcOverlay.navigateToDrcRegion(index);
  }

  public nextDrcRegion() {
    return this.drcOverlay.navigateToNextDrcRegion();
  }

  public prevDrcRegion() {
    return this.drcOverlay.navigateToPreviousDrcRegion();
  }

  public clearDrc() {
    this.drcOverlay.clearDrcRegions();
  }

  public getCurrentDrcRegion(): DrcRegion | null {
    const regions = this.sceneState.drcRegions;
    const index = this.sceneState.drcCurrentIndex;
    return regions.length > 0 ? regions[index] : null;
  }
}
