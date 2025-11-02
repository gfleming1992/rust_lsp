// Batch + Instanced shader with quantized rotation support (0°, 90°, 180°, 270°).
// For rendering multiple geometry types, each with multiple instances that can be rotated.
// Instance data: vec3<f32> = (offsetX, offsetY, rotationQuad)
// rotationQuad: 0=0°, 1=90°, 2=180°, 3=270°

struct UniformEntry {
  packedColor : u32,
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
fn vs_main(@location(0) pos : vec2<f32>, @location(2) itemIndexF : f32, @location(1) inst : vec3<f32>) -> VSOut {
  var out : VSOut;
  
  // Get batch entry
  let idx : u32 = u32(itemIndexF + 0.5);
  let entry = U.entries[idx];
  
  // Extract rotation quadrant (0-3)
  let quad = u32(inst.z) & 3u;
  
  // Precomputed sin/cos for 0°, 90°, 180°, 270°
  let cosTable = array<f32, 4>(1.0, 0.0, -1.0, 0.0);
  let sinTable = array<f32, 4>(0.0, 1.0, 0.0, -1.0);
  
  let c = cosTable[quad];
  let s = sinTable[quad];
  
  // Apply rotation in local space
  let rotated = vec2<f32>(
    pos.x * c - pos.y * s,
    pos.x * s + pos.y * c
  );
  
  // Apply model transform
  let pLocal = vec3<f32>(rotated, 1.0);
  var m = vec3<f32>( dot(entry.m0.xyz, pLocal), dot(entry.m1.xyz, pLocal), dot(entry.m2.xyz, pLocal) );
  
  // Apply instance translation in world space
  m = m + vec3<f32>(inst.xy, 0.0);
  
  // Apply view transform
  let v = vec3<f32>( dot(VIEW.v0.xyz, m), dot(VIEW.v1.xyz, m), dot(VIEW.v2.xyz, m) );
  out.Position = vec4<f32>(v.xy, 0.0, 1.0);
  
  // Unpack color
  let pc = entry.packedColor;
  let r = f32(pc & 255u) * (1.0/255.0);
  let g = f32((pc >> 8u) & 255u) * (1.0/255.0);
  let b = f32((pc >> 16u) & 255u) * (1.0/255.0);
  let a = f32((pc >> 24u) & 255u) * (1.0/255.0);
  out.color = vec4<f32>(r,g,b,a);
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
