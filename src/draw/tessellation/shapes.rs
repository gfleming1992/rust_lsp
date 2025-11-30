//! Standard shape tessellation
//!
//! This module provides tessellation functions for standard PCB shapes:
//! circles, rectangles, ovals, rounded rectangles, and annular rings.

use crate::draw::geometry::StandardPrimitive;
use std::f32::consts::PI;
use super::polygon::tessellate_custom_polygon;

/// Tessellate a circle into triangle fan
pub fn tessellate_circle(radius: f32) -> (Vec<f32>, Vec<u32>) {
    let segments = 32;
    let mut vertices = vec![0.0, 0.0]; // Center
    let mut indices = Vec::new();
    
    for i in 0..=segments {
        let angle = (i as f32 / segments as f32) * 2.0 * PI;
        vertices.push(angle.cos() * radius);
        vertices.push(angle.sin() * radius);
    }
    
    for i in 0..segments {
        indices.push(0);       // Center
        indices.push(i + 1);   // Current vertex
        indices.push(i + 2);   // Next vertex
    }
    
    (vertices, indices)
}

/// Tessellate an annular ring (donut shape) with outer and inner radii
/// Creates a ring by connecting outer and inner circle vertices with triangle strips
pub fn tessellate_annular_ring(outer_radius: f32, inner_radius: f32) -> (Vec<f32>, Vec<u32>) {
    let segments = 32;
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // Generate interleaved vertices: outer, inner, outer, inner, ...
    for i in 0..=segments {
        let angle = (i as f32 / segments as f32) * 2.0 * PI;
        let cos_a = angle.cos();
        let sin_a = angle.sin();
        
        // Outer circle vertex
        vertices.push(cos_a * outer_radius);
        vertices.push(sin_a * outer_radius);
        
        // Inner circle vertex
        vertices.push(cos_a * inner_radius);
        vertices.push(sin_a * inner_radius);
    }
    
    // Generate triangle strip indices to form quads between rings
    for i in 0..segments {
        let base = (i * 2) as u32;
        // Two triangles forming a quad
        indices.push(base);         // outer[i]
        indices.push(base + 1);     // inner[i]
        indices.push(base + 2);     // outer[i+1]
        
        indices.push(base + 2);     // outer[i+1]
        indices.push(base + 1);     // inner[i]
        indices.push(base + 3);     // inner[i+1]
    }
    
    (vertices, indices)
}

/// Tessellate a rectangle
pub fn tessellate_rectangle(width: f32, height: f32) -> (Vec<f32>, Vec<u32>) {
    let hw = width / 2.0;
    let hh = height / 2.0;
    
    let vertices = vec![
        -hw, -hh,  // Bottom-left
         hw, -hh,  // Bottom-right
         hw,  hh,  // Top-right
        -hw,  hh,  // Top-left
    ];
    
    let indices = vec![0, 1, 2, 0, 2, 3];
    
    (vertices, indices)
}

/// Tessellate a rectangular annular ring (rectangle with circular hole)
/// Uses proper triangulation by connecting rectangle perimeter to circle perimeter
pub fn tessellate_rectangular_ring(width: f32, height: f32, hole_radius: f32) -> (Vec<f32>, Vec<u32>) {
    let hw = width / 2.0;
    let hh = height / 2.0;
    
    // If hole is too large, just return solid rectangle
    if hole_radius >= hw.min(hh) {
        return tessellate_rectangle(width, height);
    }
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // We'll create a continuous outer perimeter (rectangle) and inner perimeter (circle)
    // then connect them with a triangle strip
    
    // Number of segments per rectangle edge (circle will match total = 4 * this)
    let rect_segments_per_edge = 8u32;
    
    // Build outer perimeter (rectangle) going counterclockwise from bottom-left
    // We need points distributed along each edge
    let mut outer_points = Vec::new();
    
    // Bottom edge: left to right
    for i in 0..rect_segments_per_edge {
        let t = i as f32 / rect_segments_per_edge as f32;
        outer_points.push((-hw + t * width, -hh));
    }
    // Right edge: bottom to top
    for i in 0..rect_segments_per_edge {
        let t = i as f32 / rect_segments_per_edge as f32;
        outer_points.push((hw, -hh + t * height));
    }
    // Top edge: right to left
    for i in 0..rect_segments_per_edge {
        let t = i as f32 / rect_segments_per_edge as f32;
        outer_points.push((hw - t * width, hh));
    }
    // Left edge: top to bottom
    for i in 0..rect_segments_per_edge {
        let t = i as f32 / rect_segments_per_edge as f32;
        outer_points.push((-hw, hh - t * height));
    }
    
    let total_outer = outer_points.len();
    
    // Build inner perimeter (circle) going counterclockwise, starting from same angle
    // Start angle should be ~225 degrees (bottom-left quadrant) to match rectangle start
    let start_angle = 5.0 * PI / 4.0; // 225 degrees
    let mut inner_points = Vec::new();
    for i in 0..total_outer {
        let angle = start_angle + (i as f32 / total_outer as f32) * 2.0 * PI;
        inner_points.push((angle.cos() * hole_radius, angle.sin() * hole_radius));
    }
    
    // Add all outer points to vertices
    for (x, y) in &outer_points {
        vertices.push(*x);
        vertices.push(*y);
    }
    
    // Add all inner points to vertices
    let inner_start = total_outer as u32;
    for (x, y) in &inner_points {
        vertices.push(*x);
        vertices.push(*y);
    }
    
    // Create triangle strip connecting outer and inner perimeters
    for i in 0..total_outer as u32 {
        let next = (i + 1) % total_outer as u32;
        
        // Triangle 1: outer[i], inner[i], outer[next]
        indices.push(i);
        indices.push(inner_start + i);
        indices.push(next);
        
        // Triangle 2: outer[next], inner[i], inner[next]
        indices.push(next);
        indices.push(inner_start + i);
        indices.push(inner_start + next);
    }
    
    (vertices, indices)
}

/// Tessellate an oval (ellipse)
pub fn tessellate_oval(width: f32, height: f32) -> (Vec<f32>, Vec<u32>) {
    let segments = 32;
    let rx = width / 2.0;
    let ry = height / 2.0;
    let mut vertices = vec![0.0, 0.0]; // Center
    let mut indices = Vec::new();
    
    for i in 0..=segments {
        let angle = (i as f32 / segments as f32) * 2.0 * PI;
        vertices.push(angle.cos() * rx);
        vertices.push(angle.sin() * ry);
    }
    
    for i in 0..segments {
        indices.push(0);       // Center
        indices.push(i + 1);   // Current vertex
        indices.push(i + 2);   // Next vertex
    }
    
    (vertices, indices)
}

/// Tessellate a rounded rectangle
/// Uses triangle strip approach instead of center fan to preserve rectangular shape
pub fn tessellate_roundrect(width: f32, height: f32, corner_radius: f32) -> (Vec<f32>, Vec<u32>) {
    let hw = width / 2.0;
    let hh = height / 2.0;
    let r = corner_radius.min(hw).min(hh); // Clamp radius to half-dimensions
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    let segments_per_corner = 8;
    
    // Build vertices going around the perimeter clockwise from top-right
    // Top-right corner (0° to 90°)
    for i in 0..=segments_per_corner {
        let angle = (i as f32 / segments_per_corner as f32) * std::f32::consts::FRAC_PI_2;
        vertices.push((hw - r) + angle.cos() * r);
        vertices.push((hh - r) + angle.sin() * r);
    }
    
    // Top-left corner (90° to 180°)
    for i in 0..=segments_per_corner {
        let angle = std::f32::consts::FRAC_PI_2 + (i as f32 / segments_per_corner as f32) * std::f32::consts::FRAC_PI_2;
        vertices.push((-hw + r) + angle.cos() * r);
        vertices.push((hh - r) + angle.sin() * r);
    }
    
    // Bottom-left corner (180° to 270°)
    for i in 0..=segments_per_corner {
        let angle = PI + (i as f32 / segments_per_corner as f32) * std::f32::consts::FRAC_PI_2;
        vertices.push((-hw + r) + angle.cos() * r);
        vertices.push((-hh + r) + angle.sin() * r);
    }
    
    // Bottom-right corner (270° to 360°)
    for i in 0..=segments_per_corner {
        let angle = PI + std::f32::consts::FRAC_PI_2 + (i as f32 / segments_per_corner as f32) * std::f32::consts::FRAC_PI_2;
        vertices.push((hw - r) + angle.cos() * r);
        vertices.push((-hh + r) + angle.sin() * r);
    }
    
    // Total vertices: 4 corners * (segments_per_corner + 1)
    let total_verts = (segments_per_corner + 1) * 4;
    
    // Triangulate using earcut or simple fan from first vertex
    // Use first vertex as anchor for triangle fan
    for i in 1..(total_verts as u32 - 1) {
        indices.push(0);
        indices.push(i);
        indices.push(i + 1);
    }
    
    (vertices, indices)
}

/// Tessellate a standard primitive shape
pub fn tessellate_primitive(primitive: &StandardPrimitive) -> (Vec<f32>, Vec<u32>) {
    match primitive {
        StandardPrimitive::Circle { diameter } => {
            tessellate_circle(diameter / 2.0)
        }
        StandardPrimitive::Rectangle { width, height } => {
            tessellate_rectangle(*width, *height)
        }
        StandardPrimitive::Oval { width, height } => {
            tessellate_oval(*width, *height)
        }
        StandardPrimitive::RoundRect { width, height, corner_radius } => {
            tessellate_roundrect(*width, *height, *corner_radius)
        }
        StandardPrimitive::CustomPolygon { points } => {
            tessellate_custom_polygon(points)
        }
    }
}
