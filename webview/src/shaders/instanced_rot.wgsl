// Instanced shader with rotation support.
// For rendering repeated geometry at different positions with arbitrary rotations.
// Instance data: vec3<f32> = (offsetX, offsetY, packedRotationVisibility)
// Packed format: [16-bit angle][15-bit unused][1-bit visibility]

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
fn vs_main(@location(0) pos : vec2<f32>, @location(1) inst : vec3<f32>) -> VSOut {
  var out : VSOut;
  
  // Unpack rotation, visibility, and highlight
  let packed = bitcast<u32>(inst.z);
  let visible = (packed & 1u) != 0u;
  let highlighted = (packed & 2u) != 0u;
  
  if (!visible) {
    // Discard vertex by moving it outside clip space
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  
  let angle_u16 = packed >> 16u;
  let angle_normalized = f32(angle_u16) / 65535.0;
  let angle = angle_normalized * 6.28318530718; // 2 * PI
  
  let c = cos(angle);
  let s = sin(angle);
  
  // Apply rotation
  let rotated = vec2<f32>(
    pos.x * c - pos.y * s,
    pos.x * s + pos.y * c
  );
  
  // Apply translation and transform
  let p = vec3<f32>(rotated + inst.xy, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  
  if (highlighted) {
    // Highlighted: blend color towards white (80% white for high visibility)
    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);
    out.color = vec4<f32>(highlightColor, U.color.a);
  } else {
    out.color = U.color;
  }
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
