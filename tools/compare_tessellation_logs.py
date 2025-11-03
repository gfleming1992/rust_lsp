#!/usr/bin/env python3
"""Compare tessellation triangle dumps between two runs.

The script expects the textual dump produced by DEBUG_TESSELLATION_LAYER in
`logs/user1_tessellation.txt` style. It parses every polyline block, compares
triangle vertices, and highlights deviations with a focus on sharp (low-angle)
triangles that commonly reveal visual glitches.

Usage:
    python tools/compare_tessellation_logs.py reference.txt candidate.txt \
        [--tolerance 1e-3] [--max-triangles 200] [--sharp-angle 12]

Outputs a summary of mismatches followed by per-polyline details for triangles
whose per-vertex delta exceeds the tolerance. If `--sharp-angle` is provided, an
additional section lists triangles whose minimum internal angle is below the
threshold in either run, even if the coordinates match, to aid sharp-point
investigation.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import sys
from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple

Point = Tuple[float, float]
Triangle = Tuple[Point, Point, Point]


POLYLINE_PREFIX = "Polyline:"
TRIANGLE_PREFIX = "Triangle"


@dataclass
class PolylineDump:
    index: int
    point_count: int
    width: float
    layer: str
    triangles: List[Triangle]


class ParseError(RuntimeError):
    pass


def parse_log(path: pathlib.Path) -> List[PolylineDump]:
    polylines: List[PolylineDump] = []
    current: PolylineDump | None = None

    def finish_current() -> None:
        nonlocal current
        if current is not None:
            polylines.append(current)
            current = None

    for raw_line in _iter_lines(path):
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith(POLYLINE_PREFIX):
            finish_current()
            current = _parse_polyline_header(line, len(polylines))
            continue

        if line.startswith(TRIANGLE_PREFIX):
            if current is None:
                raise ParseError(f"Triangle line encountered before polyline header in {path}")
            triangle = _parse_triangle_line(line)
            current.triangles.append(triangle)
            continue

        # Ignore banner or summary lines (===, Total, etc.).

    finish_current()
    return polylines


def _iter_lines(path: pathlib.Path) -> Iterable[str]:
    """Yield decoded lines, handling UTF-8/UTF-16 dumps emitted by PowerShell."""

    raw = path.read_bytes()

    for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ParseError(f"Unable to decode {path} as UTF-8/UTF-16")

    return text.splitlines()


def _parse_polyline_header(line: str, index: int) -> PolylineDump:
    # Example: "Polyline: 10 points, width: 0.400, layer: LAYER:User.1"
    try:
        head = line[len(POLYLINE_PREFIX) :].strip()
        parts = [token.strip() for token in head.split(',')]
        point_part, width_part, layer_part = parts

        point_count = int(point_part.split()[0])
        width = float(width_part.split(':', 1)[1])
        layer = layer_part.split(':', 1)[1].strip()
    except (ValueError, IndexError) as exc:
        raise ParseError(f"Unable to parse polyline header: '{line}'") from exc

    return PolylineDump(
        index=index,
        point_count=point_count,
        width=width,
        layer=layer,
        triangles=[],
    )


def _parse_triangle_line(line: str) -> Triangle:
    # Expected format:
    # "Triangle 0: [x0, y0], [x1, y1], [x2, y2]"
    try:
        _, payload = line.split(':', 1)
        triples = payload.strip().split('],')
        vertices: List[Point] = []
        for chunk in triples:
            chunk = chunk.strip()
            if chunk.endswith(']'):
                chunk = chunk[:-1]
            if chunk.startswith('['):
                chunk = chunk[1:]
            x_str, y_str = [part.strip() for part in chunk.split(',', 1)]
            vertices.append((float(x_str), float(y_str)))
        if len(vertices) != 3:
            raise ValueError("expected three vertices")
        return (vertices[0], vertices[1], vertices[2])
    except Exception as exc:  # pylint: disable=broad-except
        raise ParseError(f"Unable to parse triangle line: '{line}'") from exc


@dataclass
class TriangleMetrics:
    area: float
    min_angle_deg: float
    edge_lengths: Tuple[float, float, float]


@dataclass
class TriangleDiff:
    triangle_index: int
    max_vertex_delta: float
    max_coord_delta: float
    area_a: float
    area_b: float
    min_angle_a: float
    min_angle_b: float
    vertices_a: Triangle
    vertices_b: Triangle


def triangle_metrics(tri: Triangle) -> TriangleMetrics:
    a, b, c = tri
    ab = _distance(a, b)
    bc = _distance(b, c)
    ca = _distance(c, a)
    area = 0.5 * abs(
        (b[0] - a[0]) * (c[1] - a[1]) -
        (c[0] - a[0]) * (b[1] - a[1])
    )
    min_angle = _min_internal_angle(ab, bc, ca)
    return TriangleMetrics(area=area, min_angle_deg=min_angle, edge_lengths=(ab, bc, ca))


def _distance(p: Point, q: Point) -> float:
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _min_internal_angle(ab: float, bc: float, ca: float) -> float:
    sides = (ab, bc, ca)
    angles_rad: List[float] = []
    for i in range(3):
        a = sides[i]
        b = sides[(i + 1) % 3]
        c = sides[(i + 2) % 3]
        if b == 0 or c == 0:
            angles_rad.append(0.0)
            continue
        cos_angle = ((b * b) + (c * c) - (a * a)) / (2 * b * c)
        cos_angle = max(-1.0, min(1.0, cos_angle))
        angles_rad.append(math.acos(cos_angle))
    return min(angle * 180.0 / math.pi for angle in angles_rad)


def compare_polylines(
    reference: PolylineDump,
    candidate: PolylineDump,
    tolerance: float,
    max_triangles: int | None,
) -> List[TriangleDiff]:
    diffs: List[TriangleDiff] = []
    limit = max_triangles if max_triangles is not None else max(len(reference.triangles), len(candidate.triangles))

    for idx in range(min(limit, len(reference.triangles), len(candidate.triangles))):
        tri_a = reference.triangles[idx]
        tri_b = candidate.triangles[idx]
        max_delta, max_coord = _triangle_delta(tri_a, tri_b)
        if max_delta <= tolerance:
            continue

        metrics_a = triangle_metrics(tri_a)
        metrics_b = triangle_metrics(tri_b)
        diffs.append(
            TriangleDiff(
                triangle_index=idx,
                max_vertex_delta=max_delta,
                max_coord_delta=max_coord,
                area_a=metrics_a.area,
                area_b=metrics_b.area,
                min_angle_a=metrics_a.min_angle_deg,
                min_angle_b=metrics_b.min_angle_deg,
                vertices_a=tri_a,
                vertices_b=tri_b,
            )
        )

    return diffs


def _triangle_delta(a: Triangle, b: Triangle) -> Tuple[float, float]:
    max_vertex_delta = 0.0
    max_coord_delta = 0.0
    for va, vb in zip(a, b):
        dx = abs(va[0] - vb[0])
        dy = abs(va[1] - vb[1])
        max_coord_delta = max(max_coord_delta, dx, dy)
        max_vertex_delta = max(max_vertex_delta, math.hypot(dx, dy))
    return max_vertex_delta, max_coord_delta


def collect_sharp_triangles(polylines: Sequence[PolylineDump], angle_threshold: float) -> List[Tuple[int, int, TriangleMetrics]]:
    results: List[Tuple[int, int, TriangleMetrics]] = []
    for poly in polylines:
        for idx, triangle in enumerate(poly.triangles):
            metrics = triangle_metrics(triangle)
            if metrics.min_angle_deg <= angle_threshold:
                results.append((poly.index, idx, metrics))
    return results


def load_logs(reference_path: pathlib.Path, candidate_path: pathlib.Path) -> Tuple[List[PolylineDump], List[PolylineDump]]:
    reference = parse_log(reference_path)
    candidate = parse_log(candidate_path)
    return reference, candidate


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=pathlib.Path, help="Triangle dump from the known-good implementation")
    parser.add_argument("candidate", type=pathlib.Path, help="Triangle dump produced by the Rust tessellator")
    parser.add_argument("--tolerance", type=float, default=1e-3, help="Maximum allowed per-vertex distance before reporting a mismatch (default: 1e-3)")
    parser.add_argument("--max-triangles", type=int, default=None, help="Compare at most this many triangles per polyline")
    parser.add_argument("--sharp-angle", type=float, default=12.0, help="Highlight triangles with a minimum angle at or below this many degrees (default: 12)")
    parser.add_argument("--limit", type=int, default=None, help="Only compare the first N polylines")
    parser.add_argument("--reference-offset", type=int, default=0, help="Skip this many polylines at the start of the reference dump")
    parser.add_argument("--candidate-offset", type=int, default=0, help="Skip this many polylines at the start of the candidate dump")

    args = parser.parse_args(argv)

    reference_polys, candidate_polys = load_logs(args.reference, args.candidate)

    if args.reference_offset:
        reference_polys = reference_polys[args.reference_offset:]

    if args.candidate_offset:
        candidate_polys = candidate_polys[args.candidate_offset:]

    if args.limit is not None:
        reference_polys = reference_polys[: args.limit]
        candidate_polys = candidate_polys[: args.limit]

    if len(reference_polys) != len(candidate_polys):
        print(
            f"Warning: polyline counts differ (reference={len(reference_polys)}, candidate={len(candidate_polys)}).",
            file=sys.stderr,
        )

    shared_count = min(len(reference_polys), len(candidate_polys))
    total_mismatched = 0

    for idx in range(shared_count):
        ref_poly = reference_polys[idx]
        cand_poly = candidate_polys[idx]
        diffs = compare_polylines(ref_poly, cand_poly, args.tolerance, args.max_triangles)
        if not diffs:
            continue
        total_mismatched += len(diffs)
        print(
            f"\nPolyline #{idx} (ref points={ref_poly.point_count}, width={ref_poly.width:.3f}, layer={ref_poly.layer})",
        )
        for diff in diffs:
            print(
                "  Triangle {idx}: max_vertex_delta={mv:.6f} (max_coord_delta={mc:.6f}), "
                "area_ref={ar:.6f}, area_cand={ac:.6f}, min_angle_ref={angr:.3f}°, min_angle_cand={angc:.3f}°".format(
                    idx=diff.triangle_index,
                    mv=diff.max_vertex_delta,
                    mc=diff.max_coord_delta,
                    ar=diff.area_a,
                    ac=diff.area_b,
                    angr=diff.min_angle_a,
                    angc=diff.min_angle_b,
                )
            )
            for label, tri in (("ref", diff.vertices_a), ("cand", diff.vertices_b)):
                v0, v1, v2 = tri
                print(
                    f"    {label}: ({v0[0]:.6f}, {v0[1]:.6f}) | ({v1[0]:.6f}, {v1[1]:.6f}) | ({v2[0]:.6f}, {v2[1]:.6f})"
                )

    print(f"\nTotal mismatched triangles: {total_mismatched}")

    if args.sharp_angle is not None:
        sharp_ref = collect_sharp_triangles(reference_polys[:shared_count], args.sharp_angle)
        sharp_cand = collect_sharp_triangles(candidate_polys[:shared_count], args.sharp_angle)
        if sharp_ref or sharp_cand:
            print(f"\nTriangles with min angle <= {args.sharp_angle}° (reference): {len(sharp_ref)}")
            for poly_idx, tri_idx, metrics in sharp_ref:
                print(
                    f"  Polyline #{poly_idx} triangle {tri_idx}: min_angle={metrics.min_angle_deg:.3f}°, "
                    f"area={metrics.area:.6f}, edges={[round(e, 6) for e in metrics.edge_lengths]}"
                )
            print(f"\nTriangles with min angle <= {args.sharp_angle}° (candidate): {len(sharp_cand)}")
            for poly_idx, tri_idx, metrics in sharp_cand:
                print(
                    f"  Polyline #{poly_idx} triangle {tri_idx}: min_angle={metrics.min_angle_deg:.3f}°, "
                    f"area={metrics.area:.6f}, edges={[round(e, 6) for e in metrics.edge_lengths]}"
                )

    return 0


if __name__ == "__main__":
    sys.exit(main())
