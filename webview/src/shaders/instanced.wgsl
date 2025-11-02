// Instanced shader for rendering repeated identical geometry at different positions.
// Supports per-instance translation offset.
// Consolidated from: polygon_instanced.wgsl, polyline_instanced.wgsl

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
fn vs_main(@location(0) pos : vec2<f32>, @location(1) instOff : vec2<f32>) -> VSOut {
  var out : VSOut;
  // Apply per-instance translation in model space before view * model inside uniforms (we baked model*view already) -> instead, translate in clip by reconstructing before row multiply
  // Simpler: treat translation as added to position prior to matrix multiply (matrix encodes view, so we need to apply same linear part). We'll extend pos with 1 and rely on matrix rows.
  let p = vec3<f32>(pos + instOff, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  out.color = U.color;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
