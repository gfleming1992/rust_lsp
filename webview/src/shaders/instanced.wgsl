// Instanced shader for rendering repeated identical geometry at different positions.
// Supports per-instance translation offset and visibility.
// Instance data: vec3<f32> = (offsetX, offsetY, packedVisibility)
// Packed visibility bits: 0=visible, 1=highlighted, 2=moving

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) color : vec4<f32>,
};

struct Uniforms {
  color : vec4<f32>,
  m0 : vec4<f32>,
  m1 : vec4<f32>,
  m2 : vec4<f32>,
  moveOffset : vec4<f32>, // xy = offset, zw = unused
};

@group(0) @binding(0) var<uniform> U : Uniforms;

@vertex
fn vs_main(@location(0) pos : vec2<f32>, @location(1) inst : vec3<f32>) -> VSOut {
  var out : VSOut;
  
  // Unpack visibility, highlight, and moving flags
  let packed = bitcast<u32>(inst.z);
  let visible = (packed & 1u) != 0u;
  let highlighted = (packed & 2u) != 0u;
  let moving = (packed & 4u) != 0u;
  
  if (!visible) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  
  // Apply move offset if moving
  var instanceOffset = inst.xy;
  if (moving) {
    instanceOffset = instanceOffset + U.moveOffset.xy;
  }
  
  let p = vec3<f32>(pos + instanceOffset, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  
  if (highlighted || moving) {
    // Highlighted or moving: blend color towards white (80% white for high visibility)
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
