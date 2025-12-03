import { LayerColor } from "../types";

/** Shows a color picker modal and returns the selected color via callback */
export function showColorPicker(
  layerId: string,
  currentColor: LayerColor,
  onSelect: (color: LayerColor) => void,
  onReset: () => void
) {
  document.getElementById("colorPickerModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "colorPickerModal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;";

  const picker = document.createElement("div");
  picker.style.cssText = "background:#2b2b2b;padding:20px;border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.5);border:1px solid #454545;";

  const toRgb = (r: number, g: number, b: number) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  const toHex = (c: LayerColor) => c.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

  // Track selected color (starts as current)
  let selectedColor: LayerColor = [...currentColor] as LayerColor;

  picker.innerHTML = `
    <div style="color:#fff;font:14px sans-serif;margin-bottom:12px;">Pick color for <strong>${layerId}</strong></div>
    <div id="colorGrid" style="display:grid;grid-template-columns:repeat(16,24px);gap:2px;margin-bottom:12px;"></div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
      <span style="color:#aaa;font:12px sans-serif;">Selected:</span>
      <div id="previewSwatch" style="width:40px;height:24px;background:${toRgb(currentColor[0], currentColor[1], currentColor[2])};border:1px solid #444;"></div>
      <input type="text" id="hexColorInput" value="${toHex(currentColor)}" maxlength="6" style="width:70px;padding:4px 6px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;font:11px monospace;text-transform:uppercase;" />
      <button id="resetColorBtn" style="padding:4px 10px;background:#555;color:#fff;border:none;border-radius:3px;cursor:pointer;font:11px sans-serif;">Reset</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cancelColorBtn" style="padding:6px 14px;background:#555;color:#fff;border:none;border-radius:3px;cursor:pointer;font:12px sans-serif;">Cancel</button>
      <button id="applyColorBtn" style="padding:6px 14px;background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font:12px sans-serif;">Apply</button>
    </div>
  `;

  const previewSwatch = picker.querySelector("#previewSwatch") as HTMLDivElement;
  const hexInput = picker.querySelector("#hexColorInput") as HTMLInputElement;

  const updatePreview = (color: LayerColor) => {
    selectedColor = color;
    previewSwatch.style.background = toRgb(color[0], color[1], color[2]);
    hexInput.value = toHex(color);
  };

  // Build color grid (greyscale + 12 HSL rows like original)
  const grid = picker.querySelector("#colorGrid")!;
  const cellStyle = "width:24px;height:24px;cursor:pointer;border:1px solid #444;";
  
  // Greyscale row
  for (let i = 0; i < 16; i++) {
    const g = i / 15;
    const cell = document.createElement("div");
    cell.style.cssText = cellStyle + `background:${toRgb(g, g, g)};`;
    cell.dataset.color = `${g},${g},${g}`;
    grid.appendChild(cell);
  }

  // 12 HSL color rows (matching original)
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 16; col++) {
      const hue = (col / 16) * 360;
      const sat = 0.3 + (row / 11) * 0.7;
      const light = 0.3 + (col % 2) * 0.2 + (row % 3) * 0.15;
      const [r, g, b] = hslToRgb(hue, sat, light);
      const cell = document.createElement("div");
      cell.style.cssText = cellStyle + `background:${toRgb(r, g, b)};`;
      cell.dataset.color = `${r},${g},${b}`;
      grid.appendChild(cell);
    }
  }

  modal.appendChild(picker);
  document.body.appendChild(modal);

  const close = () => modal.remove();

  // Click cell = update preview (not apply yet)
  grid.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement);
    if (!cell.dataset.color) return;
    const [r, g, b] = cell.dataset.color.split(",").map(parseFloat);
    updatePreview([r, g, b, 1]);
  });

  // Hex input changes update preview
  hexInput.addEventListener("input", () => {
    const hex = hexInput.value.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      previewSwatch.style.background = toRgb(r, g, b);
      selectedColor = [r, g, b, 1];
    }
  });

  // Apply button commits the color
  picker.querySelector("#applyColorBtn")?.addEventListener("click", () => {
    onSelect(selectedColor);
    close();
  });

  picker.querySelector("#resetColorBtn")?.addEventListener("click", () => { onReset(); close(); });
  picker.querySelector("#cancelColorBtn")?.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
}

/** Convert HSL to RGB (all values 0-1 except hue 0-360) */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [r + m, g + m, b + m];
}
