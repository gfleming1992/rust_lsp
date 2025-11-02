export type LayerColor = [number, number, number, number];

export interface LayerInfo {
  id: string;
  name: string;
  defaultColor: LayerColor;
}

export const STORAGE_KEY = "layerColorOverrides";
export const SAMPLE_LAYER_ID = "TopCopper";

export const SAMPLE_LAYERS: LayerInfo[] = [
  { id: SAMPLE_LAYER_ID, name: "Top Copper", defaultColor: [0.85, 0.7, 0.2, 1] }
];

export const BASE_PALETTE: LayerColor[] = [
  [0.95, 0.95, 0.95, 1],
  [0.95, 0.2, 0.2, 1],
  [0.2, 0.8, 0.2, 1],
  [0.3, 0.6, 1.0, 1],
  [1.0, 0.85, 0.2, 1],
  [1.0, 0.4, 0.75, 1],
  [0.95, 0.55, 0.2, 1],
  [0.8, 0.3, 1.0, 1],
  [0.2, 0.9, 0.9, 1],
  [1.0, 0.6, 0.3, 1],
  [0.5, 1.0, 0.3, 1],
  [0.3, 0.4, 0.8, 1],
  [0.9, 0.5, 0.7, 1],
  [0.7, 0.9, 0.5, 1],
  [0.5, 0.7, 0.9, 1],
  [0.9, 0.7, 0.4, 1]
];

export const ZOOM_CONFIG = {
  speed: 0.005,
  min: 0.1,
  max: 500
};
