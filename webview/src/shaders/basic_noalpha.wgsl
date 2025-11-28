// Basic shader without per-vertex alpha (always uses layer color alpha)
// For rendering polylines and shapes that don't need transparency variation
// Optimized: no alpha buffer required, saves memory and attribute fetching
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
fn vs_main(@location(0) pos : vec2<f32>, @location(1) visibility : f32) -> VSOut {
  var out : VSOut;
  
  if (visibility < 0.5) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  
  let p = vec3<f32>(pos, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  
  // Check for highlight state (visibility > 1.5)
  if (visibility > 1.5) {
    // Highlighted: blend color towards white (80% white for high visibility)
    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);
    out.color = vec4<f32>(highlightColor, U.color.a);
  } else {
    // Use layer color directly (RGB + A from uniform)
    out.color = U.color;
  }
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
