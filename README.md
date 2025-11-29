# IPC-2581 PCB Viewer

A high-performance VS Code extension for viewing IPC-2581 PCB layout files with WebGPU-accelerated rendering.

## Overview

The IPC-2581 PCB Viewer is a Visual Studio Code extension that provides interactive visualization of PCB (Printed Circuit Board) layouts encoded in the IPC-2581 XML format. It leverages a hybrid Rust/TypeScript architecture where Rust handles XML parsing and geometry tessellation, while TypeScript/WebGPU powers the real-time rendering.

**Key Features:**
- Hardware-accelerated WebGPU rendering with 60+ FPS on complex designs
- Level-of-Detail (LOD) geometry for smooth zooming across 5 detail levels
- Real-time layer visibility and color controls
- Object selection with net/component highlighting
- Box selection for multi-object operations
- Delete/Undo/Redo operations with XML persistence
- Efficient binary protocol between Rust server and WebGPU client
- Memory-efficient design that drops parsed XML after loading

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           VS Code Extension                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────┐      JSON-RPC/Binary      ┌─────────────────┐ │
│  │   extension.ts       │◄────────────────────────►│  lsp_server.exe │ │
│  │   (Extension Host)   │         (stdio)           │   (Rust LSP)    │ │
│  └──────────┬───────────┘                           └────────┬────────┘ │
│             │                                                 │          │
│             │ postMessage                                     │          │
│             ▼                                                 │          │
│  ┌──────────────────────────────────────────────┐            │          │
│  │            WebView Panel                      │            │          │
│  │  ┌─────────────────────────────────────────┐ │            │          │
│  │  │              main.ts                     │ │            │          │
│  │  │  ┌─────────┐ ┌────────┐ ┌─────────────┐ │ │            │          │
│  │  │  │ Scene   │ │Renderer│ │    Input    │ │ │            │          │
│  │  │  │         │ │(WebGPU)│ │  (Events)   │ │ │            │          │
│  │  │  └────┬────┘ └───┬────┘ └──────┬──────┘ │ │            │          │
│  │  │       │          │             │        │ │            │          │
│  │  │       └──────────┼─────────────┘        │ │            │          │
│  │  │                  │                       │ │            │          │
│  │  │         ┌────────▼────────┐             │ │            │          │
│  │  │         │   GPU Buffers   │             │ │            │          │
│  │  │         │  (Vertex/Index) │             │ │            │          │
│  │  │         └─────────────────┘             │ │            │          │
│  │  └─────────────────────────────────────────┘ │            │          │
│  └──────────────────────────────────────────────┘            │          │
│                                                               │          │
└───────────────────────────────────────────────────────────────┘          │
                                                                           │
┌──────────────────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Rust LSP Server                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────┐                                                  │
│  │   ServerState     │  In-memory state for active document             │
│  ├───────────────────┤                                                  │
│  │ • xml_file_path   │  Original file path for saving                   │
│  │ • layers          │  Pre-tessellated LayerJSON data                  │
│  │ • layer_colors    │  Original colors from file                       │
│  │ • modified_colors │  User-modified colors (for save)                 │
│  │ • spatial_index   │  R-tree for O(log n) selection                   │
│  │ • padstack_defs   │  PTH/Via definitions                             │
│  │ • deleted_objects │  Tracked deletions for undo/save                 │
│  │ • hidden_layers   │  Layer visibility state                          │
│  └───────────────────┘                                                  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Processing Pipeline                             │  │
│  │                                                                    │  │
│  │  XML File ──► parse_xml ──► extract_layers ──► tessellate ──►     │  │
│  │                                                    │               │  │
│  │                           ┌────────────────────────┘               │  │
│  │                           ▼                                        │  │
│  │                    ┌─────────────────┐                             │  │
│  │                    │  LayerBinary    │  Optimized binary format    │  │
│  │                    │  (base64 over   │  for WebGPU upload          │  │
│  │                    │   JSON-RPC)     │                             │  │
│  │                    └─────────────────┘                             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. VS Code Extension (`src/extension.ts`)

The extension host component that:
- Registers the `ipc2581.openLayout` command
- Spawns and manages the Rust LSP server process
- Creates WebView panels with `retainContextWhenHidden: true`
- Routes messages between WebView and LSP server
- Handles file save operations and user notifications

**Key Functions:**
- `startLspServer()` - Spawns lsp_server.exe with stdio communication
- `sendToLspServer()` - Sends JSON-RPC requests with response handling
- `sendBinaryTessellation()` - Requests and forwards binary geometry data
- `sendCloseToLspServer()` - Cleans up LSP state when panel closes

### 2. Rust LSP Server (`src/bin/lsp_server.rs`)

A standalone executable that processes IPC-2581 XML files and serves tessellated geometry:

**Supported Methods:**
| Method | Description |
|--------|-------------|
| `Load` | Parse XML file, tessellate all layers, build spatial index |
| `GetLayers` | Return list of layer IDs |
| `GetTessellationBinary` | Return binary geometry for a specific layer |
| `UpdateLayerColor` | Update layer color (tracked for save) |
| `SetLayerVisibility` | Toggle layer visibility |
| `Select` | Point-based selection with R-tree query |
| `BoxSelect` | Rectangle-based multi-selection |
| `Delete` | Mark objects as deleted (reversible) |
| `Undo` | Restore last deleted object |
| `Redo` | Re-delete last undone object |
| `Save` | Write modified XML back to file |
| `HighlightSelectedNets` | Find all objects with same net name |
| `HighlightSelectedComponents` | Find all objects in same component |
| `QueryNetAtPoint` | Get net/component info at coordinates |
| `GetMemory` | Return current process memory usage |
| `Close` | Clear all state to free memory |

### 3. WebView Application (`webview/src/`)

A TypeScript application rendered in VS Code's WebView:

#### Core Components

**`main.ts`** - Application entry point
- Initializes WebGPU context
- Sets up message handlers for VS Code communication
- Coordinates Scene, Renderer, UI, and Input modules

**`Scene.ts`** - State and data management
- Manages layer render data (`Map<string, LayerRenderData>`)
- Handles layer visibility and color states
- Creates and destroys GPU buffers
- Tracks selection and highlight states

**`Renderer.ts`** - WebGPU rendering
- Creates render pipelines for different geometry types
- Manages uniform buffers for view transforms
- Executes render passes with proper depth ordering
- Tracks GPU memory usage for debugging

**`Input.ts`** - User interaction
- Mouse/keyboard event handling
- Pan, zoom, and drag operations
- Selection box for multi-select
- Context menu management
- Hover tooltip with net information

**`UI.ts`** - User interface
- Layer panel with visibility toggles and color pickers
- Coordinate overlay with world/screen positions
- FPS counter and debug statistics
- Selection highlight rendering

---

## Data Flow

### 1. Loading a PCB File

```
User opens .xml file
        │
        ▼
extension.ts receives URI
        │
        ▼
Creates WebView panel
        │
        ▼
WebView sends "ready" message
        │
        ▼
Extension sends Load request to LSP
        │
        ▼
LSP Server:
  1. parse_xml_file() - Builds XmlNode tree
  2. extract_and_generate_layers() - Traverses XML
  3. For each LayerFeature:
     a. Collect polylines, polygons, pads, vias
     b. Tessellate to triangles
     c. Generate LOD levels (Douglas-Peucker)
     d. Pack into LayerBinary format
  4. Build R-tree spatial index
  5. Drop XmlNode (memory optimization)
  6. Return layer list
        │
        ▼
Extension requests GetTessellationBinary for each layer
        │
        ▼
LSP returns base64-encoded binary data
        │
        ▼
WebView parses binary, creates GPU buffers
        │
        ▼
Renderer draws all layers
```

### 2. Binary Layer Format

The `LayerBinary` format is designed for efficient transmission and GPU upload:

```
┌────────────────────────────────────────────────────────────────┐
│ Header                                                          │
├───────────────┬────────────────────────────────────────────────┤
│ Magic (8B)    │ "IPC2581B" (ASCII)                             │
├───────────────┼────────────────────────────────────────────────┤
│ Layer ID      │ u32 length + UTF-8 string + padding            │
├───────────────┼────────────────────────────────────────────────┤
│ Layer Name    │ u32 length + UTF-8 string + padding            │
├───────────────┼────────────────────────────────────────────────┤
│ Color (16B)   │ 4 × f32 (RGBA)                                 │
└───────────────┴────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ Geometry Sections                                               │
├───────────────┬────────────────────────────────────────────────┤
│ Batch LODs    │ Polylines without alpha (opaque traces)        │
│ (5 levels)    │ Each: vertex_count + index_count + data        │
├───────────────┼────────────────────────────────────────────────┤
│ BatchColored  │ Polygons with per-vertex alpha                 │
│ LODs          │ (fills, pours with transparency)               │
├───────────────┼────────────────────────────────────────────────┤
│ Instanced     │ Axis-aligned pads (circles, rectangles)        │
│               │ Shared shape + instance transforms             │
├───────────────┼────────────────────────────────────────────────┤
│ InstancedRot  │ Rotated pads and vias                          │
│               │ Packed rotation + visibility in f32            │
└───────────────┴────────────────────────────────────────────────┘
```

### 3. Selection Pipeline

```
Click at (screenX, screenY)
        │
        ▼
Input.ts: Convert to world coordinates
        │
        ▼
Send Select request to LSP
        │
        ▼
LSP Server:
  1. R-tree coarse query: AABB contains point
  2. Fine phase: point_hits_object()
     - For polylines: distance to line segments
     - For polygons: point-in-polygon test
     - For instanced: transformed bounds check
  3. Sort by priority (net > type)
  4. Return ObjectRange array
        │
        ▼
WebView receives selection
        │
        ▼
Scene updates highlight state
        │
        ▼
Renderer draws with highlight color
```

---

## Geometry Processing

### Tessellation (`src/draw/tessellation.rs`)

All PCB geometry is converted to triangles for GPU rendering:

**Polylines (Traces)**
- Stroked as quads along each segment
- Round/square/butt line end caps
- Miter/bevel joints for angles
- Width-aware stroke generation

**Polygons (Copper Pours)**
- Triangulated using earcut algorithm
- Supports holes (cutouts) for clearances
- `Contour` elements parsed with outer ring + `Cutout` children

**Circles (Pads, Vias)**
- Approximated with 32-64 segment polygons
- Instanced rendering for efficiency
- Annular rings for PTH holes

### Level of Detail (LOD)

5 LOD levels are generated using Douglas-Peucker simplification:

| LOD | Tolerance | Use Case |
|-----|-----------|----------|
| 0 | 0 (exact) | Maximum zoom |
| 1 | 0.1% diagonal | High detail |
| 2 | 0.5% diagonal | Medium detail |
| 3 | 2% diagonal | Low detail |
| 4 | 8% diagonal | Overview |

LOD selection based on:
```typescript
const pixelSize = 1 / (zoom * dpr);
if (pixelSize < 0.01) return 0;      // LOD0
if (pixelSize < 0.05) return 1;      // LOD1
if (pixelSize < 0.2) return 2;       // LOD2
if (pixelSize < 0.8) return 3;       // LOD3
return 4;                             // LOD4
```

---

## WebGPU Rendering

### Shader Programs

| Shader | Purpose | Input |
|--------|---------|-------|
| `basic.wgsl` | Opaque geometry with alpha | Per-vertex alpha |
| `basic_noalpha.wgsl` | Fully opaque geometry | Uniform color |
| `instanced.wgsl` | Axis-aligned instances | Instance transforms |
| `instanced_rot.wgsl` | Rotated instances | Packed rotation+visibility |

### Render Pipeline

```
Frame Start
    │
    ▼
Calculate view matrix from pan/zoom/flip
    │
    ▼
Determine current LOD level
    │
    ▼
For each visible layer (front to back):
    │
    ├──► Batch geometry (polylines)
    │    └── Draw with pipelineNoAlpha
    │
    ├──► BatchColored geometry (polygons)
    │    └── Draw with pipelineWithAlpha (blending enabled)
    │
    ├──► Instanced geometry (pads)
    │    └── Draw with pipelineInstanced
    │
    └──► InstancedRot geometry (rotated pads/vias)
         └── Draw with pipelineInstancedRot
    │
    ▼
Present frame
```

### GPU Buffer Management

Buffers are created when layer data arrives and destroyed on layer removal:

```typescript
interface LayerRenderData {
  uniformBuffer: GPUBuffer;      // View/color uniforms
  
  // Batch geometry (polylines)
  vertexBuffer?: GPUBuffer;
  indexBuffer?: GPUBuffer;
  
  // BatchColored geometry (polygons)
  vertexBufferColored?: GPUBuffer;
  indexBufferColored?: GPUBuffer;
  
  // Instanced geometry (pads)
  instancedShapeBuffer?: GPUBuffer;
  instancedTransformBuffer?: GPUBuffer;
  
  // InstancedRot geometry (rotated pads/vias)
  instancedRotShapeBuffer?: GPUBuffer;
  instancedRotTransformBuffer?: GPUBuffer;
}
```

---

## IPC-2581 XML Parsing

### Supported Elements

**Content Structure:**
- `IPC-2581` root element
- `Content` / `Ecad` / `CadData` hierarchy
- `Step` elements with board instances

**Layer Elements:**
- `LayerFeature` - Layer geometry container
- `Set` - Feature group with net/component attributes
- `Polyline` - Multi-segment traces
- `Line` - Single segment traces
- `Polygon` - Filled shapes
- `Contour` - Polygon with `Cutout` holes (copper pours)

**Pad/Via Elements:**
- `PadStack` - Via/pad stack definition
- `LayerPad` - Pad on specific layer
- `LayerHole` - Drill hole definition
- `StandardPrimitiveRef` - Reference to primitive shape

**Dictionary Elements:**
- `DictionaryStandard` - Standard primitives (Circle, Rectangle, etc.)
- `DictionaryUser` - Custom primitives
- `DictionaryColor` - Named colors
- `DictionaryLineDesc` - Line descriptors

### Geometry Extraction Flow

```
LayerFeature
    │
    ├──► Set (net="GND", componentRef="U1")
    │    │
    │    ├──► Polyline
    │    │    └── Parse points, LineDescRef
    │    │
    │    ├──► Line
    │    │    └── Parse start/end, LineDescRef
    │    │
    │    ├──► Polygon
    │    │    └── Parse PolyBegin/PolyStepSegment
    │    │
    │    └──► Contour
    │         ├── Polygon (outer ring)
    │         └── Cutout* (holes)
    │
    └──► (recurse into children)
```

---

## Memory Management

### Rust Server Memory

The LSP server is designed for minimal memory footprint:

1. **XML Node Dropping**: After extracting geometry, the `XmlNode` tree is set to `None`, freeing ~125 MB for a 14 MB XML file

2. **Lazy Re-parsing**: On save, the original file is re-parsed instead of keeping the DOM in memory

3. **State Cleanup**: The `Close` method clears all state when a viewer is closed:
   ```rust
   state.layers.clear();
   state.layer_colors.clear();
   state.spatial_index = None;
   state.padstack_defs.clear();
   state.deleted_objects.clear();
   ```

### WebView Memory

1. **TypedArray Copying**: Binary data is copied from the message ArrayBuffer to prevent memory leaks:
   ```typescript
   const vertices = new Float32Array(vertexData.length);
   vertices.set(vertexData); // Copy, don't reference
   ```

2. **Buffer Cleanup**: GPU buffers are explicitly destroyed when layers are removed:
   ```typescript
   if (data.vertexBuffer) data.vertexBuffer.destroy();
   if (data.indexBuffer) data.indexBuffer.destroy();
   ```

3. **Web Worker Pool**: Binary parsing uses a worker pool to avoid blocking the main thread

---

## Save/Export

### Modified Data Tracking

The server tracks modifications separately from the original file:

- `deleted_objects`: HashMap of deleted object IDs → ObjectRange
- `modified_colors`: HashMap of layer ID → new RGBA color

### Save Process

```
Save Request
    │
    ▼
Re-parse original XML file
    │
    ▼
Apply deleted_objects:
  - Remove matching elements from DOM
    │
    ▼
Apply modified_colors:
  - Update/insert EntryColor in DictionaryColor
    │
    ▼
Serialize XmlNode back to XML string
    │
    ▼
Write to _serialized.xml file
    │
    ▼
Return success with new file path
```

---

## Development

### Project Structure

```
rust_extension/
├── src/
│   ├── bin/
│   │   └── lsp_server.rs      # Rust LSP server
│   ├── draw/
│   │   ├── geometry.rs        # Data structures
│   │   ├── tessellation.rs    # Triangle generation
│   │   ├── generation.rs      # LayerJSON creation
│   │   └── parsing.rs         # XML → geometry extraction
│   ├── extension.ts           # VS Code extension host
│   ├── parse_xml.rs           # XML parser
│   └── serialize_xml.rs       # XML serializer
├── webview/
│   └── src/
│       ├── main.ts            # WebView entry point
│       ├── Scene.ts           # State management
│       ├── Renderer.ts        # WebGPU rendering
│       ├── Input.ts           # User interaction
│       ├── UI.ts              # Interface components
│       ├── binaryParser.ts    # Binary format parser
│       └── shaders/           # WGSL shader files
├── assets/
│   └── webview.html           # WebView HTML template
├── tests/                     # Sample IPC-2581 files
└── package.json               # Extension manifest
```

### Build Commands

```bash
# Full build (clean + rust + extension + webview)
npm run build:all

# Individual builds
npm run build:rust          # Cargo build --release
npm run build:extension     # TypeScript compilation
npm run build:webview       # esbuild bundle

# Development with hot reload
npm run dev                 # Starts dev server with watch

# Clean processes (Windows)
npm run clean               # Kills lsp_server and port 5173
```

### Debug Logging

**Rust Server:**
```rust
eprintln!("[LSP Server] message");  // Stderr for debugging
log_to_file("message");             // logs/lsp_debug.txt
```

**Extension:**
```typescript
console.log('[Extension] message'); // Debug Console
```

**WebView:**
```typescript
console.log('[Webview] message');   // Forwarded to Extension console
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PROFILE_TIMING` | Enable timing logs in Rust |
| `DEBUG_TESSELLATION_LAYER` | Comma-separated layer IDs for debug output |

---

## Performance Characteristics

### Typical Load Times (14 MB XML, ~400k vertices)

| Stage | Time |
|-------|------|
| XML Parsing | ~500 ms |
| Layer Extraction | ~200 ms |
| Tessellation | ~300 ms |
| Binary Encoding | ~100 ms |
| GPU Upload | ~50 ms |
| **Total** | **~1.2 s** |

### Rendering Performance

- 60 FPS at 1080p with 100+ layers
- LOD system reduces vertex count by 80-95% at low zoom
- Instanced rendering for 10,000+ pads with minimal overhead
- R-tree selection queries in <1 ms

### Memory Usage

| Component | Typical Usage |
|-----------|---------------|
| LSP Server (loaded) | 150-300 MB |
| LSP Server (idle) | 20-50 MB |
| WebView GPU Buffers | 50-100 MB |
| WebView JS Heap | 30-80 MB |

---

## Troubleshooting

### Common Issues

**WebGPU Not Available**
- Ensure Chrome/Edge 113+ or enable experimental features
- Check `chrome://gpu` for WebGPU status

**LSP Server Crashes**
- Check `logs/lsp_debug.txt` for error messages
- Ensure `bin/lsp_server.exe` exists after build

**Slow Loading**
- Large files (>50 MB) may take 5-10 seconds
- Check for circular references in XML

**Missing Geometry**
- Verify layer visibility in UI
- Check for unsupported primitive types in XML

---

## License

MIT License - See LICENSE file for details.

---

## Acknowledgments

- IPC-2581 Consortium for the standard specification
- quick-xml for fast XML parsing
- earcutr for polygon triangulation
- rstar for R-tree spatial indexing
- WebGPU Working Group for the graphics API
