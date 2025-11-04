// Batch shader with per-vertex alpha support
// Like batch.wgsl but adds per-vertex alpha channel for polygon transparency
// RGB from storage buffer, alpha from vertex attribute

struct UniformEntry {
  packedColor : u32, // RGB8 only (alpha comes from vertex attribute)
  pad0 : u32,
  pad1 : u32,
  pad2 : u32,
  m0 : vec4<f32>,
  m1 : vec4<f32>,
  m2 : vec4<f32>,
};

struct Uniforms {
  entries : array<UniformEntry>,
};

struct ViewMat {
  v0 : vec4<f32>,
  v1 : vec4<f32>,
  v2 : vec4<f32>,
};

@group(0) @binding(0) var<storage, read> U : Uniforms;
@group(0) @binding(1) var<uniform> VIEW : ViewMat;

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs_main(@location(0) pos : vec2<f32>, @location(1) vertAlpha : f32, @location(2) itemIndexF : f32) -> VSOut {
  var out : VSOut;
  let idx : u32 = u32(itemIndexF + 0.5);
  let entry = U.entries[idx];
  let p = vec3<f32>(pos, 1.0);
  let m = vec3<f32>( dot(entry.m0.xyz, p), dot(entry.m1.xyz, p), dot(entry.m2.xyz, p) );
  let v = vec3<f32>( dot(VIEW.v0.xyz, m), dot(VIEW.v1.xyz, m), dot(VIEW.v2.xyz, m) );
  out.Position = vec4<f32>(v.xy, 0.0, 1.0);
  let pc = entry.packedColor;
  let r = f32(pc & 255u) * (1.0/255.0);
  let g = f32((pc >> 8u) & 255u) * (1.0/255.0);
  let b = f32((pc >> 16u) & 255u) * (1.0/255.0);
  // Use per-vertex alpha instead of packed alpha
  out.color = vec4<f32>(r, g, b, vertAlpha);
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
