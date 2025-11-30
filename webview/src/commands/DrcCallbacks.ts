/**
 * DrcCallbacks - Sets up DRC-related UI callbacks
 */

import { Scene } from "../Scene";
import { Renderer } from "../Renderer";
import { UI } from "../UI";
import { IApiClient } from "../api/types";

export interface DrcCallbacksDeps {
    scene: Scene;
    renderer: Renderer;
    ui: UI;
    api: IApiClient;
}

/**
 * Sets up all DRC-related callbacks
 */
export function setupDrcCallbacks(deps: DrcCallbacksDeps): void {
    const { scene, renderer, ui, api } = deps;
    
    // Run full DRC
    ui.setOnRunDrc(() => {
        console.log('[DRC] Running Full DRC...');
        api.send({ command: 'RunDRCWithRegions', clearance_mm: 0.15, force_full: true });
    });
    
    // Run incremental DRC
    ui.setOnIncrementalDrc(() => {
        console.log('[DRC] Running Incremental DRC...');
        api.send({ command: 'RunDRCWithRegions', clearance_mm: 0.15, force_full: false });
    });
    
    // DRC navigation (prev/next)
    ui.setOnDrcNavigate((direction: 'prev' | 'next') => {
        const region = direction === 'next' ? scene.nextDrcRegion() : scene.prevDrcRegion();
        if (region) {
            // Fit camera to the violation region
            renderer.fitToBounds(region.bounds, 0.3);
            
            // Show only the affected layer
            for (const [layerId] of scene.layerVisible) {
                scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
            }
            ui.updateLayerVisibility(new Set([region.layer_id]));
            
            ui.updateDrcPanel(scene.drcRegions.length, scene.drcCurrentIndex, region, true);
        }
    });
    
    // DRC selection by index
    ui.setOnDrcSelect((index: number) => {
        const region = scene.navigateToDrcRegion(index);
        if (region) {
            // Fit camera to the violation region
            renderer.fitToBounds(region.bounds, 0.3);
            
            // Show only the affected layer
            for (const [layerId] of scene.layerVisible) {
                scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
            }
            ui.updateLayerVisibility(new Set([region.layer_id]));
            
            ui.updateDrcPanel(scene.drcRegions.length, index, region, true);
        }
    });
}
