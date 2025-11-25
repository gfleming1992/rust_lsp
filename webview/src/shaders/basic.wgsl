// Basic shader for rendering simple shapes with optional per-vertex alpha
// Supports lines, arcs, outlines, polygons, polylines, fills
// Consolidated from: line.wgsl, arc.wgsl, outline.wgsl, polygon.wgsl, polyline.wgsl
// Alpha defaults to 1.0 (layer color) when no alpha buffer is provided
// Added: visibility buffer support

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) color : vec4<f32>,
};

struct Uniforms {
  color : vec4<f32>,
  m0 : vec4<f32>,
  m1 : vec4<f32>,
  m2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> U : Uniforms;

@vertex
fn vs_main(@location(0) pos : vec2<f32>, @location(1) vertAlpha : f32, @location(2) visibility : f32) -> VSOut {
  var out : VSOut;
  
  if (visibility < 0.5) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  
  let p = vec3<f32>(pos, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  // Combine layer RGB (from uniform) with per-vertex alpha
  out.color = vec4<f32>(U.color.xyz, vertAlpha);
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
