use crate::draw::geometry::*;
use std::f32::consts::PI;

/// Douglas-Peucker polyline simplification
/// Reduces number of points while maintaining shape within tolerance
pub fn douglas_peucker(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let mut dmax = 0.0;
    let mut index = 0;
    
    // Find the point with maximum distance from line segment
    for i in 1..points.len() - 1 {
        let d = point_line_distance(points[i], points[0], points[points.len() - 1]);
        if d > dmax {
            dmax = d;
            index = i;
        }
    }

    if dmax > tolerance {
        let mut left = douglas_peucker(&points[0..=index], tolerance);
        let right = douglas_peucker(&points[index..], tolerance);
        left.pop(); // Remove duplicate point
        left.extend(right);
        left
    } else {
        vec![points[0], points[points.len() - 1]]
    }
}

/// Calculate perpendicular distance from point to line segment
fn point_line_distance(p: Point, a: Point, b: Point) -> f32 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len_sq = dx * dx + dy * dy;
    
    if len_sq < 1e-10 {
        return ((p.x - a.x).powi(2) + (p.y - a.y).powi(2)).sqrt();
    }
    
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len_sq;
    let t = t.clamp(0.0, 1.0);
    
    let proj_x = a.x + t * dx;
    let proj_y = a.y + t * dy;
    
    ((p.x - proj_x).powi(2) + (p.y - proj_y).powi(2)).sqrt()
}

/// Generate 5 LOD levels for a single polyline using Douglas-Peucker
pub fn generate_polyline_lods(polyline: &Polyline) -> Vec<Vec<Point>> {
    if polyline.points.len() < 2 {
        return vec![vec![]];
    }

    let mut lods = vec![polyline.points.clone()]; // LOD0: exact

    // Calculate bounding box for tolerance scaling
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
    );
    
    for p in &polyline.points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }

    let dx = max_x - min_x;
    let dy = max_y - min_y;
    let diag = (dx * dx + dy * dy).sqrt().max(1.0);
    
    // For very short polylines (dots, small circles), limit simplification
    // to preserve their shape at all LODs
    let is_very_short = diag < polyline.width * 3.0;
    
    // CRITICAL: For polylines with many points in a small area (circles/dots),
    // don't simplify at all - keep original points at all LODs to preserve roundness
    let is_circle_or_dot = polyline.points.len() > 4 && is_very_short;
    
    if is_circle_or_dot {
        // Preserve exact geometry for circles/dots at all LODs
        for _ in 1..5 {
            lods.push(polyline.points.clone());
        }
        return lods;
    }

    // Base tolerance as fraction of bounding box diagonal
    let base_tol = diag * 0.0005;
    let max_tol = if is_very_short {
        // For dots/short segments, use much tighter max tolerance
        diag * 0.005
    } else {
        diag * 0.02
    };

    // Generate LOD1-4 with increasing tolerance (~4x each level)
    let mut tolerance = base_tol;
    for _ in 1..5 {
        if tolerance > max_tol {
            tolerance = max_tol;
        }
        let simplified = douglas_peucker(&polyline.points, tolerance);
        lods.push(simplified);
        tolerance *= 4.0;
    }

    lods
}

/// Number of segments used for round caps (matching Polyline.js defaults)
const ROUND_CAP_SEGMENTS: u32 = 16;

/// Minimum screen-space width (in world units) below which we cull geometry at higher LODs
/// Constant 0.5px screen-space threshold across all LOD levels
/// LOD zoom ranges: LOD0(10+), LOD1(5-10), LOD2(2-5), LOD3(0.5-2), LOD4(<0.5)
/// Formula: world_width_threshold = 0.5px / zoom_level
pub const MIN_VISIBLE_WIDTH_LOD: [f32; 5] = [
    0.0,    // LOD0: always render (zoom >= 10, highest detail)
    0.05,   // LOD1: 0.5px / 10 = 0.05mm (zoom ~10)
    0.10,   // LOD2: 0.5px / 5 = 0.10mm (zoom ~5)
    0.25,   // LOD3: 0.5px / 2 = 0.25mm (zoom ~2)
    1.00,   // LOD4: 0.5px / 0.5 = 1.00mm (zoom ~0.5)
];

/// Helper function to add a round cap at a specific position
fn add_round_cap(
    verts: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    center: Point,
    direction: (f32, f32),
    half_width: f32,
    is_start: bool,
) {
    let fan_base = (verts.len() / 2) as u32;
    verts.push(center.x);
    verts.push(center.y);
    
    let base_angle = direction.1.atan2(direction.0);
    let angle_offset = if is_start {
        PI / 2.0
    } else {
        -PI / 2.0
    };
    
    for i in 0..=ROUND_CAP_SEGMENTS {
        let t = i as f32 / ROUND_CAP_SEGMENTS as f32;
        let ang = base_angle + angle_offset + t * PI;
        verts.push(center.x + ang.cos() * half_width);
        verts.push(center.y + ang.sin() * half_width);
    }
    
    for i in 0..ROUND_CAP_SEGMENTS {
        indices.push(fan_base);
        indices.push(fan_base + 1 + i);
        indices.push(fan_base + 2 + i);
    }
}

/// Stroke a single polyline into vertex and index arrays
/// Creates triangles for the line width with miter joins connecting segments
/// Supports different line end styles (round, square, butt)
pub fn tessellate_polyline(points: &[Point], width: f32, line_end: LineEnd) -> (Vec<f32>, Vec<u32>) {
    let mut verts = Vec::new();
    let mut indices = Vec::new();

    if points.len() < 2 || width <= 0.0 {
        return (verts, indices);
    }

    let mut work_points = points.to_vec();
    let mut is_closed = false;

    if work_points.len() >= 3 {
        if let (Some(first), Some(last)) = (work_points.first().copied(), work_points.last().copied()) {
            let close_thresh = 1e-4;
            if (first.x - last.x).abs() < close_thresh && (first.y - last.y).abs() < close_thresh {
                is_closed = true;
                work_points.pop();
            }
        }
    }

    if work_points.len() < 2 {
        return (verts, indices);
    }

    let n = work_points.len();
    let half_w = width * 0.5;
    let segment_count = if is_closed { n } else { n - 1 };

    let mut seg_dir = Vec::with_capacity(segment_count);
    let mut seg_norm = Vec::with_capacity(segment_count);

    for i in 0..segment_count {
        let p0 = work_points[i];
        let p1 = work_points[(i + 1) % n];
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        let len = (dx * dx + dy * dy).sqrt();

        if len < 1e-12 {
            seg_dir.push((1.0, 0.0));
            seg_norm.push((0.0, 1.0));
        } else {
            let inv_len = 1.0 / len;
            let dx_norm = dx * inv_len;
            let dy_norm = dy * inv_len;
            seg_dir.push((dx_norm, dy_norm));
            seg_norm.push((-dy_norm, dx_norm));
        }
    }

    let pair_from = |point: Point, normal: (f32, f32)| -> (Point, Point) {
        (
            Point {
                x: point.x + normal.0 * half_w,
                y: point.y + normal.1 * half_w,
            },
            Point {
                x: point.x - normal.0 * half_w,
                y: point.y - normal.1 * half_w,
            },
        )
    };

    let mut pairs: Vec<(Point, Point)> = Vec::new();
    pairs.push(pair_from(work_points[0], seg_norm[0]));

    for i in 0..segment_count {
        let end_idx = if i + 1 < n { i + 1 } else { 0 };
        let curr_norm = seg_norm[i];
        let end_pair = pair_from(work_points[end_idx], curr_norm);
        pairs.push(end_pair);

        if !is_closed && i == segment_count - 1 {
            continue;
        }

        let next_norm = seg_norm[(i + 1) % segment_count];
        let curr_dir = seg_dir[i];
        let next_dir = seg_dir[(i + 1) % segment_count];
        let cross = curr_dir.0 * next_dir.1 - curr_dir.1 * next_dir.0;

        if cross.abs() < 1e-6 {
            continue;
        }

        let is_left_turn = cross > 0.0;
        let center = work_points[end_idx];
        let next_pair = pair_from(center, next_norm);

        let (outer_start, outer_end, inner_start, inner_end) = if is_left_turn {
            (end_pair.0, next_pair.0, end_pair.1, next_pair.1)
        } else {
            (end_pair.1, next_pair.1, end_pair.0, next_pair.0)
        };

        let start_angle = (outer_start.y - center.y).atan2(outer_start.x - center.x);
        let end_angle = (outer_end.y - center.y).atan2(outer_end.x - center.x);
        let mut sweep = end_angle - start_angle;

        if is_left_turn {
            while sweep <= 0.0 {
                sweep += PI * 2.0;
            }
        } else {
            while sweep >= 0.0 {
                sweep -= PI * 2.0;
            }
        }

        let angle_span = sweep.abs();
        let segments = (angle_span / (PI / 18.0)).ceil() as u32;
        let num_segs = segments.max(4);

        for s in 1..=num_segs {
            let t = s as f32 / num_segs as f32;
            let ang = start_angle + sweep * t;
            let outer_point = Point {
                x: center.x + ang.cos() * half_w,
                y: center.y + ang.sin() * half_w,
            };
            let inner_point = Point {
                x: inner_start.x + (inner_end.x - inner_start.x) * t,
                y: inner_start.y + (inner_end.y - inner_start.y) * t,
            };

            if is_left_turn {
                pairs.push((outer_point, inner_point));
            } else {
                pairs.push((inner_point, outer_point));
            }
        }
    }

    for pair in &pairs {
        verts.push(pair.0.x);
        verts.push(pair.0.y);
        verts.push(pair.1.x);
        verts.push(pair.1.y);
    }

    let base_pairs = pairs.len();
    let segment_pairs = if is_closed { base_pairs } else { base_pairs.saturating_sub(1) };

    for i in 0..segment_pairs {
        let next = if i + 1 < base_pairs { i + 1 } else { 0 };
        if !is_closed && next == 0 {
            continue;
        }
        let base = (i * 2) as u32;
        let next_base = (next * 2) as u32;
        indices.push(base);
        indices.push(next_base);
        indices.push(next_base + 1);
        indices.push(base);
        indices.push(next_base + 1);
        indices.push(base + 1);
    }

    if !is_closed {
        match line_end {
            LineEnd::Round => {
                add_round_cap(
                    &mut verts,
                    &mut indices,
                    work_points[0],
                    seg_dir[0],
                    half_w,
                    true,
                );
                add_round_cap(
                    &mut verts,
                    &mut indices,
                    work_points[n - 1],
                    seg_dir[segment_count - 1],
                    half_w,
                    false,
                );
            }
            LineEnd::Square => {
                let start_pair = pairs[0];
                let end_pair = pairs[pairs.len() - 1];
                let start_dir = seg_dir[0];
                let end_dir = seg_dir[segment_count - 1];

                let s_shift_x = -start_dir.0 * half_w;
                let s_shift_y = -start_dir.1 * half_w;
                let v_start = (verts.len() / 2) as u32;
                verts.push(start_pair.0.x + s_shift_x);
                verts.push(start_pair.0.y + s_shift_y);
                verts.push(start_pair.1.x + s_shift_x);
                verts.push(start_pair.1.y + s_shift_y);
                indices.push(v_start);
                indices.push(0);
                indices.push(1);
                indices.push(v_start);
                indices.push(1);
                indices.push(v_start + 1);

                let e_shift_x = end_dir.0 * half_w;
                let e_shift_y = end_dir.1 * half_w;
                let v_end = (verts.len() / 2) as u32;
                let last_base = ((pairs.len() - 1) * 2) as u32;
                verts.push(end_pair.0.x + e_shift_x);
                verts.push(end_pair.0.y + e_shift_y);
                verts.push(end_pair.1.x + e_shift_x);
                verts.push(end_pair.1.y + e_shift_y);
                indices.push(last_base);
                indices.push(v_end);
                indices.push(v_end + 1);
                indices.push(last_base);
                indices.push(v_end + 1);
                indices.push(last_base + 1);
            }
            LineEnd::Butt => {}
        }
    }

    (verts, indices)
}

/// Batch all polylines for a layer into a single vertex/index buffer
/// Each polyline maintains its own width and line_end style
pub fn batch_polylines_with_styles(
    polylines_data: &[(Vec<Point>, f32, LineEnd)],
) -> (Vec<f32>, Vec<u32>) {
    let mut all_verts = Vec::new();
    let mut all_indices = Vec::new();

    for (points, width, line_end) in polylines_data {
        let (verts, mut indices) = tessellate_polyline(points, *width, *line_end);
        
        // Offset indices by current vertex count
        let vert_offset = all_verts.len() as u32 / 2;
        for idx in indices.iter_mut() {
            *idx += vert_offset;
        }
        
        all_verts.extend(verts);
        all_indices.extend(indices);
    }

    (all_verts, all_indices)
}

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
