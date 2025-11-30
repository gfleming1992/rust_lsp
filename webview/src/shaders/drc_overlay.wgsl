// DRC Overlay shader - diagonal stripes over violation triangles
// Stripe color can be set dynamically for contrast with layer color

struct Uniforms {
  v0 : vec4<f32>,  // View matrix row 0
  v1 : vec4<f32>,  // View matrix row 1
  v2 : vec4<f32>,  // View matrix row 2
  stripeColor : vec4<f32>, // Stripe color (RGB + alpha)
};

@group(0) @binding(0) var<uniform> U : Uniforms;

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) worldPos : vec2<f32>,
};

@vertex
fn vs_main(@location(0) pos : vec2<f32>) -> VSOut {
  var out : VSOut;
  
  // Apply view transform
  let p = vec3<f32>(pos, 1.0);
  let v = vec3<f32>(
    dot(U.v0.xyz, p),
    dot(U.v1.xyz, p),
    dot(U.v2.xyz, p)
  );
  
  out.Position = vec4<f32>(v.xy, 0.1, 1.0); // z=0.1 to draw on top
  out.worldPos = pos;
  
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // Create diagonal stripe pattern
  // Scale for PCB units (mm) - visible stripes at typical zoom levels
  let stripeWidth = 0.05; // 0.05mm stripe width (about 2 mil)
  let stripeSpacing = 0.05; // 0.05mm between stripes
  let period = stripeWidth + stripeSpacing;
  
  // Diagonal stripe: x + y creates 45-degree angle
  let diag = (in.worldPos.x + in.worldPos.y);
  let stripe = fract(diag / period);
  
  // Create stripe pattern - 1.0 in stripe, 0.0 outside
  let inStripe = step(stripe, stripeWidth / period);
  
  // Use stripe color with modulated alpha
  let alpha = inStripe * U.stripeColor.a;
  
  // Discard fragments outside stripes for better performance
  if (alpha < 0.01) {
    discard;
  }
  
  return vec4<f32>(U.stripeColor.rgb, alpha);
}
