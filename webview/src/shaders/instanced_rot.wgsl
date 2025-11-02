// Instanced shader with quantized rotation support (0°, 90°, 180°, 270°).
// For rendering repeated geometry at different positions with orthogonal rotations.
// Instance data: vec3<f32> = (offsetX, offsetY, rotationQuad)
// rotationQuad: 0=0°, 1=90°, 2=180°, 3=270°

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
  
  // Extract rotation quadrant (0-3)
  let quad = u32(inst.z) & 3u;
  
  // Precomputed sin/cos for 0°, 90°, 180°, 270°
  let cosTable = array<f32, 4>(1.0, 0.0, -1.0, 0.0);
  let sinTable = array<f32, 4>(0.0, 1.0, 0.0, -1.0);
  
  let c = cosTable[quad];
  let s = sinTable[quad];
  
  // Apply rotation
  let rotated = vec2<f32>(
    pos.x * c - pos.y * s,
    pos.x * s + pos.y * c
  );
  
  // Apply translation and transform
  let p = vec3<f32>(rotated + inst.xy, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  out.color = U.color;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
