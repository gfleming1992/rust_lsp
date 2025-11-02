// Instanced shader with per-vertex colors (for partial transparency support)
// Supports repeated geometry at different positions, with per-vertex color/alpha

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) color : vec4<f32>,
};

struct Uniforms {
  color : vec4<f32>,  // Fallback color (not used when per-vertex colors provided)
  m0 : vec4<f32>,
  m1 : vec4<f32>,
  m2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> U : Uniforms;

@vertex
fn vs_main(@location(0) pos : vec2<f32>, @location(1) vertAlpha : f32, @location(2) instOff : vec2<f32>) -> VSOut {
  var out : VSOut;
  let p = vec3<f32>(pos + instOff, 1.0);
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
