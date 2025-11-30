//! Polygon tessellation using earcut algorithm
//!
//! This module provides triangulation of filled polygons with optional holes,
//! suitable for GPU rendering.

use crate::draw::geometry::{Point, Polygon, PadStackHole};
use super::simplify::douglas_peucker;
use std::f32::consts::PI;

/// Tessellate a filled polygon using earcut triangulation
/// Supports outer ring + optional holes with LOD via Douglas-Peucker
/// Returns (vertices, indices) as flat arrays
pub fn tessellate_polygon(polygon: &Polygon, tolerance: f32) -> (Vec<f32>, Vec<u32>) {
    // Simplify outer ring and holes using Douglas-Peucker
    let simplified_outer = if tolerance > 0.0 {
        douglas_peucker(&polygon.outer_ring, tolerance)
    } else {
        polygon.outer_ring.clone()
    };
    
    let simplified_holes: Vec<Vec<Point>> = polygon.holes.iter()
        .map(|hole| {
            if tolerance > 0.0 {
                douglas_peucker(hole, tolerance)
            } else {
                hole.clone()
            }
        })
        .collect();
    
    // Build flat coordinate array for earcut
    let mut flat_coords: Vec<f64> = Vec::new();
    let mut hole_indices: Vec<usize> = Vec::new();
    
    // Add outer ring
    for p in &simplified_outer {
        flat_coords.push(p.x as f64);
        flat_coords.push(p.y as f64);
    }
    
    // Add holes
    for hole in &simplified_holes {
        if hole.len() < 3 {
            continue; // Skip degenerate holes
        }
        hole_indices.push(flat_coords.len() / 2);
        for p in hole {
            flat_coords.push(p.x as f64);
            flat_coords.push(p.y as f64);
        }
    }
    
    // Triangulate using earcut
    let indices = earcutr::earcut(&flat_coords, &hole_indices, 2);
    
    // Convert to f32 for GPU
    let vertices: Vec<f32> = flat_coords.iter().map(|&v| v as f32).collect();
    let indices_u32: Vec<u32> = indices.unwrap_or_default().iter().map(|&i| i as u32).collect();
    
    (vertices, indices_u32)
}

/// Tessellate pad stack holes with optional annular rings
/// Groups holes by size for LOD optimization (matching PadStackHoleBatch.js)
/// Returns separate geometry for rings and holes
pub fn tessellate_padstack_holes(
    holes: &[PadStackHole],
    segments: u32,
) -> (Vec<f32>, Vec<u32>, Vec<f32>, Vec<u32>) {
    let seg = segments.max(8); // Minimum 8 segments for smooth circles
    
    let mut ring_verts = Vec::new();
    let mut ring_indices = Vec::new();
    let mut hole_verts = Vec::new();
    let mut hole_indices = Vec::new();
    
    let mut ring_vertex_base = 0u32;
    let mut hole_vertex_base = 0u32;
    
    for pad in holes {
        let hole_r = pad.hole_diameter * 0.5;
        let outer_r = hole_r + pad.ring_width;
        
        // Generate annular ring if ring_width > 0
        if pad.ring_width > 0.0 {
            for i in 0..=seg {
                let angle = (i as f32 / seg as f32) * PI * 2.0;
                let cos_a = angle.cos();
                let sin_a = angle.sin();
                
                // Outer vertex
                ring_verts.push(pad.x + cos_a * outer_r);
                ring_verts.push(pad.y + sin_a * outer_r);
                
                // Inner vertex
                ring_verts.push(pad.x + cos_a * hole_r);
                ring_verts.push(pad.y + sin_a * hole_r);
            }
            
            // Generate quad indices for ring
            for i in 0..seg {
                let o = ring_vertex_base + i * 2;
                ring_indices.extend_from_slice(&[
                    o, o + 1, o + 2,
                    o + 2, o + 1, o + 3,
                ]);
            }
            
            ring_vertex_base += (seg + 1) * 2;
        }
        
        // Generate hole as triangle fan (always present)
        let center_index = hole_vertex_base;
        hole_verts.push(pad.x);
        hole_verts.push(pad.y);
        hole_vertex_base += 1;
        
        for i in 0..=seg {
            let angle = (i as f32 / seg as f32) * PI * 2.0;
            hole_verts.push(pad.x + angle.cos() * hole_r);
            hole_verts.push(pad.y + angle.sin() * hole_r);
            hole_vertex_base += 1;
        }
        
        // Triangle fan indices
        for i in 0..seg {
            hole_indices.extend_from_slice(&[
                center_index,
                center_index + 1 + i,
                center_index + 1 + i + 1,
            ]);
        }
    }
    
    (ring_verts, ring_indices, hole_verts, hole_indices)
}

/// Tessellate a custom polygon using earcut
pub fn tessellate_custom_polygon(points: &[Point]) -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::new();
    for p in points {
        vertices.push(p.x);
        vertices.push(p.y);
    }
    
    // Use earcut for triangulation
    let indices = earcutr::earcut(&vertices, &[], 2).unwrap_or_default();
    let indices_u32: Vec<u32> = indices.into_iter().map(|i| i as u32).collect();
    
    (vertices, indices_u32)
}
