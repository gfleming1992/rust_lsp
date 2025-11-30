//! Distance calculation algorithms for DRC
//!
//! Contains triangle, segment, and point distance calculations.

/// Triangle with precomputed AABB for fast rejection
#[derive(Clone, Debug)]
pub struct Triangle {
    pub v0: [f32; 2],
    pub v1: [f32; 2],
    pub v2: [f32; 2],
    pub aabb_min: [f32; 2],
    pub aabb_max: [f32; 2],
}

impl Triangle {
    pub fn from_vertices(v0: [f32; 2], v1: [f32; 2], v2: [f32; 2]) -> Self {
        Self {
            v0,
            v1,
            v2,
            aabb_min: [
                v0[0].min(v1[0]).min(v2[0]),
                v0[1].min(v1[1]).min(v2[1]),
            ],
            aabb_max: [
                v0[0].max(v1[0]).max(v2[0]),
                v0[1].max(v1[1]).max(v2[1]),
            ],
        }
    }

    /// Fast AABB-to-AABB distance (lower bound)
    pub fn aabb_distance(&self, other: &Triangle) -> f32 {
        let dx = (self.aabb_min[0].max(other.aabb_min[0])
            - self.aabb_max[0].min(other.aabb_max[0]))
        .max(0.0);
        let dy = (self.aabb_min[1].max(other.aabb_min[1])
            - self.aabb_max[1].min(other.aabb_max[1]))
        .max(0.0);
        (dx * dx + dy * dy).sqrt()
    }
}

/// Triangle-to-triangle minimum distance
pub fn triangle_distance(a: &Triangle, b: &Triangle) -> (f32, [f32; 2]) {
    let mut min_dist = f32::MAX;
    let mut closest = [0.0f32; 2];

    // Edge-edge distances (9 combinations)
    for (a1, a2) in [(a.v0, a.v1), (a.v1, a.v2), (a.v2, a.v0)] {
        for (b1, b2) in [(b.v0, b.v1), (b.v1, b.v2), (b.v2, b.v0)] {
            let (d, p) = segment_distance(a1, a2, b1, b2);
            if d < min_dist {
                min_dist = d;
                closest = p;
            }
        }
    }

    (min_dist, closest)
}

/// Segment-to-segment minimum distance
pub fn segment_distance(
    a1: [f32; 2],
    a2: [f32; 2],
    b1: [f32; 2],
    b2: [f32; 2],
) -> (f32, [f32; 2]) {
    let mut min_d = f32::MAX;
    let mut closest = [0.0f32; 2];

    // a1 to segment b
    let (d, p) = point_segment_distance(a1, b1, b2);
    if d < min_d {
        min_d = d;
        closest = midpoint(a1, p);
    }

    // a2 to segment b
    let (d, p) = point_segment_distance(a2, b1, b2);
    if d < min_d {
        min_d = d;
        closest = midpoint(a2, p);
    }

    // b1 to segment a
    let (d, p) = point_segment_distance(b1, a1, a2);
    if d < min_d {
        min_d = d;
        closest = midpoint(b1, p);
    }

    // b2 to segment a
    let (d, p) = point_segment_distance(b2, a1, a2);
    if d < min_d {
        min_d = d;
        closest = midpoint(b2, p);
    }

    (min_d, closest)
}

/// Point-to-segment minimum distance
pub fn point_segment_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> (f32, [f32; 2]) {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let ap = [p[0] - a[0], p[1] - a[1]];
    let ab_len2 = ab[0] * ab[0] + ab[1] * ab[1];

    if ab_len2 < 1e-10 {
        // Degenerate segment
        let d = ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
        return (d, a);
    }

    let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / ab_len2).clamp(0.0, 1.0);
    let closest = [a[0] + t * ab[0], a[1] + t * ab[1]];
    let d = ((p[0] - closest[0]).powi(2) + (p[1] - closest[1]).powi(2)).sqrt();

    (d, closest)
}

/// Midpoint of two points
pub fn midpoint(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_triangle_aabb_distance() {
        let t1 = Triangle::from_vertices([0.0, 0.0], [1.0, 0.0], [0.5, 1.0]);
        let t2 = Triangle::from_vertices([2.0, 0.0], [3.0, 0.0], [2.5, 1.0]);

        // Triangles are separated by 1 unit in X
        let dist = t1.aabb_distance(&t2);
        assert!((dist - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_point_segment_distance() {
        let (d, _) = point_segment_distance([0.0, 1.0], [0.0, 0.0], [2.0, 0.0]);
        assert!((d - 1.0).abs() < 0.01);
    }
}
