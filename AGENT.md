# Agent Context: IPC-2581 PCB Viewer

VS Code extension for viewing IPC-2581 PCB files. **Rust LSP server** (XML parsing/tessellation) + **TypeScript/WebGPU webview** (rendering).

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

## Key Files

| Rust (`src/`) | Purpose |
|---------------|---------|
| `bin/lsp_server.rs` | Main LSP server - JSON-RPC handlers |
| `draw/parsing.rs` | XML → geometry (polylines, polygons, pads) |
| `draw/tessellation.rs` | Geometry → triangles |
| `draw/generation.rs` | Creates LayerJSON with LOD levels |
| `parse_xml.rs` / `serialize_xml.rs` | XML parsing and saving |

| TypeScript (`webview/src/`) | Purpose |
|-----------------------------|---------|
| `main.ts` | Entry point, VS Code message handling |
| `Scene.ts` | Layer state, GPU buffers, selection |
| `Renderer.ts` | WebGPU pipeline, render loop |
| `Input.ts` | Mouse/keyboard, pan/zoom |

## LSP Methods

`Load` `GetLayers` `GetTessellationBinary` `Select` `BoxSelect` `QueryNetAtPoint` `Delete` `Undo` `Redo` `Save` `UpdateLayerColor` `SetLayerVisibility` `HighlightSelectedNets` `Close` `GetMemory`

## Build Commands

> **IMPORTANT**: Always use `npm run` commands. They copy `lsp_server.exe` to `bin/` where the extension loads it.

```bash
npm run build:all      # Full build (rust + extension + webview) - USE THIS
npm run build:rust     # Rust only (with copy to bin/)
npm run build:webview  # WebView only
npm run dev            # Dev server with hot reload
```

| Changed | Run |
|---------|-----|
| Any `.rs` file | `npm run build:rust` |
| `extension.ts` | `npm run build:extension` |
| `webview/src/*.ts` | `npm run build:webview` or `npm run dev` |

## Common Tasks

**Adding LSP method**: 1) Handler in `lsp_server.rs` 2) Message case in `extension.ts` 3) Handler in `webview/src/main.ts`

**Geometry changes**: Edit `parsing.rs` or `tessellation.rs`, run `npm run build:rust`

**WebGPU changes**: Shaders in `webview/src/shaders/*.wgsl`, pipeline in `Renderer.ts`

## Debugging

| Log Type | Method |
|----------|--------|
| Rust | `eprintln!()` → Extension Host output |
| Rust file | `log_to_file()` → `logs/lsp_debug.txt` |
| Extension | `console.log('[Extension]')` |
| WebView | Forwarded to Extension console |

**Environment variables**: `PROFILE_TIMING=1` `DEBUG_TESSELLATION_LAYER=<name>` `DEBUG_PADS=1`

## Debugging LSP Directly (Piped Commands)

Bypass VS Code and test Rust LSP handlers directly:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"Load","params":{"file_path":"c:/repos/rust_lsp/tests/tinytapeout-demo.xml"}}
{"jsonrpc":"2.0","id":2,"method":"QueryNetAtPoint","params":{"x":100.0,"y":-100.0}}
{"jsonrpc":"2.0","id":3,"method":"Select","params":{"x":100.0,"y":-100.0}}
'@ | .\target\release\lsp_server.exe 2>&1
```

**Key points**:
- Build first: `cargo build --release`
- Use `file_path` (snake_case) for Load params
- Each line = one JSON-RPC message
- `2>&1` captures stderr debug logs
- Use forward slashes in paths

**Common params**: `Load {file_path}` · `Select/QueryNetAtPoint {x, y}` · `BoxSelect {x1, y1, x2, y2}` · `Delete {ids: [u64]}` · `GetLayers/Undo/Redo/Close (none)`

## CLI Geometry Tool

```bash
cargo build --release --bin test_geometry
test_geometry tests/file.xml --summary                    # Quick stats
test_geometry tests/file.xml --layer "Top" --type pad     # Filter
test_geometry tests/file.xml --coord 235.17,156.55        # Find at point
```

## Key Data Structures

```rust
struct ObjectRange {
    id: u64, layer_id: String, obj_type: u8,  // 0=Polyline, 1=Polygon, 2=Via, 3=Pad
    bounds: [f32; 4], net_name: Option<String>, component_ref: Option<String>,
}
```

## IPC-2581 Elements

`LayerFeature` (layer) · `Set` (groups with net/component) · `Polyline`/`Line` (traces) · `Polygon` (fills) · `Contour` (polygon with `Cutout` holes) · `PadStack`/`LayerPad` (pads/vias)

## Test Files

`tests/pic_programmerB.xml` (small) · `tests/tinytapeout-demo.xml` (medium) · `tests/NEX40400_PROBECARD_PCB.xml` (large)
