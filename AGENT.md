# Agent Context: IPC-2581 PCB Viewer

## What This Is

A VS Code extension for viewing IPC-2581 PCB layout files. Uses a **Rust LSP server** for XML parsing/tessellation and a **TypeScript/WebGPU webview** for rendering.

## Architecture Summary

```
┌─────────────────────┐     JSON-RPC (stdio)     ┌──────────────────┐
│   extension.ts      │◄────────────────────────►│  lsp_server.exe  │
│  (VS Code Host)     │                          │  (Rust binary)   │
└─────────┬───────────┘                          └──────────────────┘
          │ postMessage                                   │
          ▼                                               │
┌─────────────────────┐                                   │
│  WebView (webview/) │  Receives binary geometry ◄───────┘
│  • Scene.ts         │  from LSP, uploads to GPU
│  • Renderer.ts      │
│  • Input.ts         │
└─────────────────────┘
```

## Key Files

### Rust (src/)
| File | Purpose |
|------|---------|
| `src/bin/lsp_server.rs` | Main LSP server - handles all JSON-RPC methods |
| `src/draw/parsing.rs` | XML → geometry extraction (polylines, polygons, pads) |
| `src/draw/tessellation.rs` | Geometry → triangles (earcut, stroke generation) |
| `src/draw/generation.rs` | Creates LayerJSON with LOD levels |
| `src/draw/geometry.rs` | Data structures (Point, Polyline, Polygon, ObjectRange) |
| `src/parse_xml.rs` | XML file → XmlNode tree |
| `src/serialize_xml.rs` | XmlNode tree → XML file (for save) |

### TypeScript (webview/src/)
| File | Purpose |
|------|---------|
| `main.ts` | Entry point, message handling with VS Code |
| `Scene.ts` | Layer state, GPU buffer management, selection |
| `Renderer.ts` | WebGPU pipeline setup, render loop |
| `Input.ts` | Mouse/keyboard, pan/zoom, selection box |
| `UI.ts` | Layer panel, color pickers, debug overlay |
| `binaryParser.ts` | Parses binary layer format from Rust |

### Extension
| File | Purpose |
|------|---------|
| `src/extension.ts` | Spawns LSP, creates WebView, routes messages |

## LSP Server Methods

```
Load              - Parse XML, tessellate, build spatial index
GetLayers         - Return layer ID list
GetTessellationBinary - Return binary geometry for one layer
Select            - Point selection (x, y) → ObjectRange[]
BoxSelect         - Rectangle selection → ObjectRange[]
Delete            - Mark object as deleted
Undo/Redo         - Restore/re-delete objects
Save              - Write modified XML to file
UpdateLayerColor  - Change layer color
SetLayerVisibility - Toggle layer on/off
HighlightSelectedNets - Find all objects with same net
Close             - Clear state, free memory
```

## Data Flow

1. **Load**: XML → `parse_xml` → `extract_and_generate_layers` → tessellate → binary
2. **Render**: Binary → `binaryParser.ts` → GPU buffers → WebGPU draw calls
3. **Select**: Click → world coords → LSP `Select` → R-tree query → ObjectRange
4. **Save**: Re-parse XML → apply deletions/colors → serialize → write file

## Key Data Structures

### Rust
```rust
struct ServerState {
    xml_file_path: Option<String>,
    layers: Vec<LayerJSON>,
    spatial_index: Option<RTree<SelectableObject>>,
    deleted_objects: HashMap<u64, ObjectRange>,
    modified_colors: HashMap<String, [f32; 4]>,
}

struct ObjectRange {
    id: u64,
    layer_id: String,
    obj_type: u8,  // 0=Polyline, 1=Polygon, 2=Via, 3=Pad
    bounds: [f32; 4],
    net_name: Option<String>,
    component_ref: Option<String>,
}
```

### TypeScript
```typescript
interface LayerRenderData {
    uniformBuffer: GPUBuffer;
    vertexBuffer?: GPUBuffer;
    indexBuffer?: GPUBuffer;
    // ... instanced buffers for pads/vias
}
```

## Build Commands

> **IMPORTANT FOR AGENTS**: Always use `npm run` commands for building, never raw `cargo build`. The npm scripts handle copying binaries to the correct location.

```bash
npm run build:all      # Full clean build (rust + extension + webview) - USE THIS
npm run build:rust     # Build Rust AND copy lsp_server.exe to bin/
npm run build:extension # tsc for extension.ts
npm run build:webview  # esbuild bundle
npm run dev            # Dev server with hot reload
npm run clean          # Kill lsp_server processes
```

### Why npm scripts matter

The `npm run build:rust` script does TWO things:
1. `cargo build --release --bin lsp_server`
2. `Copy-Item -Force target\release\lsp_server.exe bin\`

The extension loads `lsp_server.exe` from `bin/`, NOT from `target/release/`. If you run raw `cargo build` without copying, **your changes won't be used**.

### Quick reference for common changes

| Changed | Run |
|---------|-----|
| Any `.rs` file | `npm run build:rust` |
| `extension.ts` | `npm run build:extension` |
| `webview/src/*.ts` | `npm run build:webview` (or use `npm run dev` for hot reload) |
| Multiple areas | `npm run build:all` |

### VS Code Tasks

You can also use the VS Code task runner (Ctrl+Shift+B):
- `build:rust` - Build Rust with binary copy
- `build:all` - Full rebuild

## Common Tasks

### Adding a new LSP method
1. Add handler in `src/bin/lsp_server.rs` (match on method name)
2. Add message case in `src/extension.ts` (`panel.webview.onDidReceiveMessage`)
3. Add handler in `webview/src/main.ts` if webview needs to call it

### Modifying geometry parsing
1. Edit `src/draw/parsing.rs` for XML extraction
2. Edit `src/draw/tessellation.rs` for triangle generation
3. Rebuild rust: `cargo build --release --bin lsp_server`

### Changing WebGPU rendering
1. Shaders are in `webview/src/shaders/*.wgsl`
2. Pipeline setup in `Renderer.ts`
3. Draw calls in `Renderer.render()`

## Debugging

- **Rust logs**: `eprintln!()` goes to stderr, visible in Extension Host output
- **Rust file log**: `log_to_file()` writes to `logs/lsp_debug.txt`
- **Extension logs**: `console.log('[Extension]')` in Debug Console
- **WebView logs**: Forwarded to Extension console via message

### Debug Environment Variables

Set these before running to enable verbose output:

| Variable | Effect |
|----------|--------|
| `PROFILE_TIMING=1` | Show timing for XML parsing, tessellation, layer generation |
| `DEBUG_TESSELLATION_LAYER=<name>` | Detailed polyline debug for specific layer (or all if empty) |
| `DEBUG_PADS=1` | Show pad shape grouping and tessellation details |

Example:
```powershell
$env:PROFILE_TIMING = "1"
cargo run --bin lsp_server
```

## Memory Notes

- XML root is **dropped after loading** to save ~125 MB
- On save, file is **re-parsed** (fast, ~500ms)
- `Close` method clears all state when panel closes
- WebView copies TypedArrays to avoid memory leaks

## IPC-2581 XML Elements

Key elements the parser handles:
- `LayerFeature` → layer container
- `Set` → groups with net/component attributes
- `Polyline` / `Line` → traces
- `Polygon` → filled shapes
- `Contour` → polygon with `Cutout` holes (copper pours)
- `PadStack` / `LayerPad` → pads and vias

## CLI Geometry Test Tool

A standalone CLI tool for debugging geometry extraction without the VS Code extension.

### Building

```bash
cargo build --release --bin test_geometry
# Executable at: target/release/test_geometry.exe
```

### Usage

```bash
test_geometry <xml_file> [options]

Options:
  --layer <name>           Filter to specific layer (partial match)
  --region <x1,y1,x2,y2>   Filter to bounding box region
  --type <type>            Filter by geometry type: pad, via, polyline, polygon, all
  --coord <x,y>            Find objects near coordinate (tolerance 1.0)
  --summary                Show summary stats only
  --verbose                Show detailed geometry info
```

### Examples

```bash
# Quick summary of all geometry
test_geometry tests/NEX40400_PROBECARD_PCB.xml --summary

# Find pads on Top Layer with geometry details
test_geometry tests/NEX40400_PROBECARD_PCB.xml --layer "Top Layer" --type pad --verbose

# Find objects near a specific coordinate
test_geometry tests/NEX40400_PROBECARD_PCB.xml --coord 235.17,156.55

# Filter to a region with vias only
test_geometry tests/NEX40400_PROBECARD_PCB.xml --region 230,150,240,160 --type via
```

### Output

Shows per-layer counts and LOD entry details:
```
=== Top Layer ===
  Pads: 963 (16 shapes)
    Shape 0: 4 verts, 6 indices, 120 instances
    ...
  Vias: 1234 (3 shapes)
  Polylines: 5678
```

With `--coord`, shows object ranges matching the coordinate:
```
Objects near (235.17, 156.55):
  pad @ (234.32,155.70)-(236.02,157.40) layer=Top Layer net=Some("VCC") comp=Some("K17_S4")
```

## Testing Files

Sample files in `tests/` directory:
- `pic_programmerB.xml` - Small, good for quick testing
- `NEX40400_PROBECARD_PCB.xml` - Large, complex design
- `TERES_PCB1-A64-MAIN_Rev.C.xml` - Medium complexity
