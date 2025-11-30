//! Color parsing and layer color assignment
//!
//! Handles parsing color attributes from XML and assigning default colors to layers.

use indexmap::IndexMap;

/// Parse color from attributes (r, g, b, a values 0-255)
pub fn parse_color(attrs: &IndexMap<String, String>) -> Option<[f32; 4]> {
    let r = attrs.get("r").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let g = attrs.get("g").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let b = attrs.get("b").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let a = attrs
        .get("a")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(255.0) / 255.0;
    Some([r, g, b, a])
}

/// Get a color for a layer based on its name/type
pub fn get_layer_color(layer_ref: &str) -> [f32; 4] {
    let lower = layer_ref.to_lowercase();
    
    // Top silkscreen/overlay: pure gray
    if (lower.contains("silkscreen") || lower.contains("silk") || lower.contains("overlay")) && (lower.contains("f.") || lower.contains("top")) {
        return [0.7, 0.7, 0.7, 1.0]; // Gray
    }
    
    // Bottom silkscreen/overlay: yellowish tinted gray
    if (lower.contains("silkscreen") || lower.contains("silk") || lower.contains("overlay")) && (lower.contains("b.") || lower.contains("bottom")) {
        return [0.75, 0.73, 0.6, 1.0]; // Yellowish gray
    }
    
    // Very distinct colors for other layers: top layers red, bottom layers blue
    if lower.contains("f.") || lower.contains("top") {
        // Front/Top layers - reds to oranges
        if lower.contains(".cu") || lower.contains("copper") || lower.contains("layer") || lower.contains("signal") {
            return [1.0, 0.2, 0.2, 1.0]; // Bright red
        } else if lower.contains("paste") {
            return [1.0, 0.5, 0.5, 1.0]; // Light red
        } else if lower.contains("mask") || lower.contains("solder") {
            return [0.8, 0.0, 0.0, 1.0]; // Dark red
        } else {
            return [1.0, 0.3, 0.0, 1.0]; // Orange-red
        }
    } else if lower.contains("b.") || lower.contains("bottom") {
        // Back/Bottom layers - blues to cyans
        if lower.contains(".cu") || lower.contains("copper") || lower.contains("layer") || lower.contains("signal") {
            return [0.2, 0.2, 1.0, 1.0]; // Bright blue
        } else if lower.contains("paste") {
            return [0.5, 0.5, 1.0, 1.0]; // Light blue
        } else if lower.contains("mask") || lower.contains("solder") {
            return [0.0, 0.0, 0.8, 1.0]; // Dark blue
        } else {
            return [0.0, 0.5, 1.0, 1.0]; // Cyan-blue
        }
    }
    
    // Internal layers and other types - greens and purples
    if lower.contains("in") || lower.contains("inner") || lower.contains("ground") || lower.contains("power") || lower.contains("signal") {
        if lower.contains("ground") {
            return [0.2, 0.8, 0.2, 1.0]; // Green for ground
        } else if lower.contains("power") {
            return [0.8, 0.2, 0.8, 1.0]; // Purple for power
        }
        return [0.2, 1.0, 0.2, 1.0]; // Bright green for generic inner/signal
    }
    
    if lower.contains("dielectric") {
        return [0.8, 0.6, 1.0, 1.0]; // Light purple
    }
    
    // Mechanical/Board layers
    if lower.contains("mechanical") || lower.contains("board") || lower.contains("outline") || lower.contains("dimension") {
        return [1.0, 1.0, 0.0, 1.0]; // Yellow
    }
    
    // User layers - distinctive colors
    if lower.contains("user") {
        return [1.0, 0.5, 0.0, 1.0]; // Orange
    }
    
    // Drill/Hole layers
    if lower.contains("drill") || lower.contains("hole") {
        return [0.2, 0.2, 0.2, 1.0]; // Dark gray
    }
    
    [0.7, 0.7, 0.7, 1.0] // default gray
}
