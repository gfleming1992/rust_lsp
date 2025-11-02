# Tessellation Test System

## Overview

This test system emulates a VS Code extension loading tessellation data from the Rust backend and rendering it to canvas using WebGPU.

**Key Features:**
- ✅ Simulates VS Code extension message API (`postMessage`)
- ✅ Loads tessellation JSON files from test data directory
- ✅ Renders 5-LOD tessellated geometry to WebGPU canvas
- ✅ Auto-selects LOD based on zoom level
- ✅ Full interactive controls: pan, zoom, layer visibility
- ✅ Performance metrics and debug logging

## Test Case Files

### Available Test Cases

1. **`layer_LAYER_Design.json`** (tinytapeout-demo.xml)
   - Extracted from `tinytapeout-demo.xml` via Rust pipeline
   - Contains 13,800+ polylines from design layer
   - 5 LOD levels with automatic tessellation
   - File size: ~9.9 MB (base64-encoded geometry)
   - Use case: Comprehensive test with real PCB data

## Running Tests

### Local Development (Vite)

```bash
cd webview/
npm run dev
```

Then open: `http://localhost:5173/test.html`

### Build and Test

```bash
cd webview/
npm run build
npm run preview  # Serves dist/ on port 5173
```

Then open: `http://localhost:5173/test.html`

## Test Architecture

### Message Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (webview/test.html)                                │
│  ┌─────────────────────────────────────────────────────────┐
│  │  window.__TESSELLATION_TEST = 'layer_LAYER_Design'      │
│  │  ↓                                                        │
│  │  main.ts loaded                                           │
│  │  ↓                                                        │
│  │  setupTestListeners() called                             │
│  │  ↓                                                        │
│  │  tests.ts initializes test mode                          │
│  │  ├─ Creates mock window.vscode API                       │
│  │  └─ Calls handleTestMessage()                            │
│  │      ↓                                                    │
│  │      Fetches /src/test-data/layer_LAYER_Design.json     │
│  │      ↓                                                    │
│  │      Dispatches message event to window                  │
│  │      ↓                                                    │
│  │      main.ts receives message in window.addEventListener │
│  │      ├─ loadLayerData(layerJson)                         │
│  │      ├─ Creates GPU buffers for all 5 LOD levels        │
│  │      ├─ Sets LOD0 as default                            │
│  │      └─ Triggers render loop                             │
│  │                                                           │
│  │  Render Loop:                                             │
│  │  ├─ selectLODForZoom(state.zoom)                         │
│  │  ├─ Binds vertex/index/alpha buffers                     │
│  │  ├─ Issues draw call to batch.wgsl shader                │
│  │  └─ Updates canvas with rendered geometry                │
│  │                                                           │
│  │  Interaction:                                             │
│  │  ├─ Mouse wheel: Zoom (auto-selects LOD)                 │
│  │  ├─ Drag: Pan view                                       │
│  │  └─ Layer toggle: Show/hide geometry                     │
│  └─────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

### Files Structure

```
webview/
├── src/
│   ├── main.ts                    # Main viewer (exports types, receives messages)
│   ├── tests.ts                   # Test API (simulates extension API)
│   ├── test-data/
│   │   └── layer_LAYER_Design.json # Tessellation test data
│   ├── shaders/
│   │   └── basic.wgsl             # WebGPU shader
│   └── ...
├── test.html                      # Test page (sets __TESSELLATION_TEST)
├── index.html                     # Production page
└── vite.config.ts
```

## Adding New Test Cases

To add new test data:

1. **Generate JSON from Rust:**
   ```bash
   cd rust_extension/
   cargo test --release -- --nocapture
   # Output: output/layer_*.json
   ```

2. **Copy to test data directory:**
   ```bash
   cp output/layer_*.json webview/src/test-data/
   ```

3. **Update test.html:**
   ```html
   <button class="test-case-btn" onclick="switchTestCase('layer_NEW_LAYER')">
     📊 New Layer Name
   </button>
   ```

## Debugging

### Browser Console

```javascript
// View test case name
window.__TESSELLATION_TEST

// Start new test dynamically
import('./src/tests.ts').then(m => m.startTest('layer_LAYER_Design'))

// Get available test cases
import('./src/tests.ts').then(m => m.getAvailableTestCases()).then(console.log)
```

### Logging

- **Test API logs**: `[TEST]` prefix
- **Main viewer logs**: Default console
- **WebGPU logs**: Browser DevTools

### Performance Metrics

The UI shows real-time metrics:
- **FPS**: Frames per second
- **Parse**: JSON parse time
- **Rebuild**: GPU buffer creation time
- **FirstFrame**: Total time to first render
- **GPU Buffers**: Number of GPU buffers + total memory

## LOD Auto-Selection

The viewer automatically selects LOD based on zoom level:

```typescript
if (zoom >= 10) return 0;      // Full detail
if (zoom >= 5)  return 1;      // 75% reduced
if (zoom >= 2)  return 2;      // 93% reduced  
if (zoom >= 0.5) return 3;     // 98% reduced
return 4;                       // 99% reduced (coarsest)
```

This mimics the reference implementation in `BatchedPolylines.js`.

## Test Validation Checklist

- [ ] Geometry renders on canvas (not black screen)
- [ ] Pan works (drag mouse)
- [ ] Zoom works (mouse wheel)
- [ ] LOD changes visible as zoom changes
- [ ] Layer toggle hides/shows geometry
- [ ] FPS is smooth (>30 FPS)
- [ ] No console errors
- [ ] No GPU validation errors
- [ ] Memory usage stable (no leaks)

## VS Code Extension Integration

When integrating into actual VS Code extension:

1. **Replace test.html with extension's webview**
2. **Replace test message flow with real extension API:**
   ```typescript
   // Extension sends:
   vscode.postMessage({
     command: 'loadLayer',
     layerId: 'LAYER:TopCopper',
     data: layerJson
   });
   
   // Webview receives:
   window.addEventListener('message', event => {
     const { command, data } = event.data;
     if (command === 'loadLayer') {
       loadLayerData(data);
     }
   });
   ```

3. **Authentication**: Add check to remove `setupTestListeners()` in production

## Related Files

- `output/layer_*.json` - Generated tessellation data (Rust output)
- `src/xml_draw.rs` - Rust tessellation module
- `webview/src/main.ts` - Main viewer and GPU rendering
- `webview/src/shaders/basic.wgsl` - WebGPU shader for geometry

## Troubleshooting

### "Failed to fetch /src/test-data/..."
- Ensure JSON file is in `webview/src/test-data/`
- Check Vite is running with `npm run dev`
- Verify file path matches `window.__TESSELLATION_TEST` value

### Black screen
- Check browser console for errors
- Verify WebGPU is supported: `navigator.gpu`
- Check GPU buffers were created: "GPU Buffers: X" in UI

### Low FPS
- Reduce zoom level (switch to coarser LOD)
- Check GPU memory usage
- Profile in Chrome DevTools: Performance tab

### Memory issues
- Clear browser cache
- Check GPU buffer cleanup on layer change
- Monitor: `device.createBuffer` calls
