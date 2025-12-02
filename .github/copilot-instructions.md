# IPC-2581 PCB Viewer - AI Agent Instructions

VS Code extension for viewing IPC-2581 PCB files. **Rust LSP server** (XML parsing, tessellation, spatial queries) + **TypeScript/WebGPU webview** (rendering).

## Architecture

```
┌─────────────────────┐     JSON-RPC (stdio)     ┌──────────────────┐
│   extension.ts      │◄────────────────────────►│  lsp_server.exe  │
└─────────┬───────────┘                          └──────────────────┘
          │ postMessage
┌─────────▼───────────┐
│  WebView (webview/) │  Scene.ts, Renderer.ts, Input.ts, UI.ts
└─────────────────────┘
```

**Data flow**: XML file → Rust parses & tessellates → binary geometry (base64 over JSON-RPC) → TypeScript decodes → WebGPU renders

## Key Directories

| Path | Purpose |
|------|---------|
| `src/bin/lsp_server.rs` | LSP entry point, JSON-RPC dispatch |
| `src/lsp/handlers/` | Request handlers (file, selection, edit, DRC) |
| `src/draw/parsing/` | XML → geometry extraction |
| `src/draw/tessellation/` | Geometry → triangles |
| `src/draw/generation/` | LayerJSON/LayerBinary creation with LOD |
| `webview/src/main.ts` | WebView entry, VS Code message handling |
| `webview/src/Scene.ts` | Layer state, GPU buffers, selection |
| `webview/src/Renderer.ts` | WebGPU pipeline, render loop |

## Build Commands

```bash
npm run build:all      # Full rebuild (rust + extension + webview)
npm run build:rust     # Rust only
npm run build:webview  # WebView only
npm run dev            # Dev server with hot reload
```

| Changed | Command |
|---------|---------|
| Any `.rs` file | `npm run build:rust` |
| `extension.ts` | `npm run build:extension` |
| `webview/src/*.ts` | `npm run build:webview` or `npm run dev` |

## Adding an LSP Method

1. **Handler** in `src/lsp/handlers/` (e.g., `query.rs`) - implement logic
2. **Dispatch** in `src/bin/lsp_server.rs` - add match arm in `dispatch_request()`
3. **Extension** in `src/extension.ts` - handle webview message, call `sendToLspServer()`
4. **WebView** in `webview/src/main.ts` - send message via `vscode.postMessage()`

## LSP Methods Reference

`Load` `GetLayers` `GetTessellationBinary` `Select` `BoxSelect` `QueryNetAtPoint` `Delete` `Undo` `Redo` `Save` `UpdateLayerColor` `SetLayerVisibility` `HighlightSelectedNets` `HighlightSelectedComponents` `RunDRC` `GetDRCViolations` `Close` `GetMemory`

## Debugging

| Component | Method |
|-----------|--------|
| Rust | `eprintln!()` → Extension Host output |
| Rust file | `log_to_file()` → `logs/lsp_debug.txt` |
| Extension | `console.log('[Extension]')` |
| WebView | Console forwarded to Extension output |

**Environment variables**: `PROFILE_TIMING=1`, `DEBUG_TESSELLATION_LAYER=<name>`, `DEBUG_PADS=1`

### Direct LSP Testing (bypass VS Code)

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"Load","params":{"file_path":"c:/projects/rust_extension/tests/tinytapeout-demo.xml"}}
{"jsonrpc":"2.0","id":2,"method":"GetLayers","params":{}}
'@ | .\target\release\lsp_server.exe 2>&1
```

## Key Data Structures

```rust
// src/draw/geometry/mod.rs - spatial index entry
struct ObjectRange {
    id: u64, layer_id: String, obj_type: u8,  // 0=Polyline, 1=Polygon, 2=Via, 3=Pad
    bounds: [f32; 4], net_name: Option<String>, component_ref: Option<String>,
}
```

```typescript
// webview/src/types.ts - layer render data
interface LayerRenderData {
  vertexBuffer?: GPUBuffer;      // Batch geometry (polylines)
  indexBuffer?: GPUBuffer;
  instancedShapeBuffer?: GPUBuffer;  // Instanced pads
  instancedTransformBuffer?: GPUBuffer;
}
```

## IPC-2581 Element Mapping

| XML Element | Rust Handler | Geometry Type |
|-------------|--------------|---------------|
| `Polyline`/`Line` | `parsing/polyline.rs` | Stroked quads |
| `Polygon`/`Contour` | `parsing/polygon.rs` | Triangulated (earcut) |
| `PadStack`/`LayerPad` | `parsing/pad.rs` | Instanced circles/rects |
| `Cutout` | Child of `Contour` | Polygon holes |

## Test Files

| File | Size | Use |
|------|------|-----|
| `tests/pic_programmerB.xml` | Small | Quick iteration |
| `tests/tinytapeout-demo.xml` | Medium | Standard testing |
| `tests/NEX40400_PROBECARD_PCB.xml` | Large | Performance testing |

## Common Patterns

**Binary data transfer**: Rust encodes to `LayerBinary` format → base64 → JSON-RPC → TypeScript `binaryParser.ts` decodes → GPU buffers

**Selection**: Click → world coords → LSP `Select` → R-tree query → `ObjectRange[]` → WebView highlights

**Memory optimization**: XML DOM dropped after tessellation; re-parsed on save only

## WebGPU Shaders

Located in `webview/src/shaders/`:
- `basic.wgsl` - Per-vertex alpha (polygons)
- `basic_noalpha.wgsl` - Uniform color (polylines)
- `instanced.wgsl` - Axis-aligned pads
- `instanced_rot.wgsl` - Rotated pads/vias
