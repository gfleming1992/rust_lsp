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
fn vs_main(@location(0) pos : vec2<f32>, @location(1) instOffset : vec2<f32>) -> VSOut {
  var out : VSOut;
  let pLocal = vec3<f32>(pos + instOffset, 1.0);
  let t = vec3<f32>( dot(U.m0.xyz, pLocal), dot(U.m1.xyz, pLocal), dot(U.m2.xyz, pLocal) );
  out.Position = vec4<f32>(t.xy, 0.0, 1.0);
  out.color = U.color;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
