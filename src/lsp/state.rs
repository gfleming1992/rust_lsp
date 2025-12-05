//! Server state management for the LSP server

use crate::draw::geometry::{LayerJSON, ObjectRange, PadStackDef, SelectableObject};
use crate::draw::drc::{DrcViolation, DrcRegion, DesignRules};
use crate::parse_xml::XmlNode;
use crate::lsp::handlers::transform::TransformSession;
use indexmap::IndexMap;
use rstar::RTree;
use std::collections::{HashMap, HashSet};

/// A region that has been modified and needs DRC re-checking
#[derive(Clone, Debug)]
pub struct ModifiedRegion {
    pub bounds: [f32; 4],  // [min_x, min_y, max_x, max_y]
    pub layer_id: String,
    pub object_id: u64,
}

/// Represents a move operation for an object
#[derive(Clone, Debug)]
pub struct ObjectMove {
    pub delta_x: f32,
    pub delta_y: f32,
}

/// Represents a rotation operation for an object
#[derive(Clone, Debug)]
pub struct ObjectRotation {
    pub delta_radians: f32,  // Accumulated rotation in radians
}

/// Represents a flip operation for an object
#[derive(Clone, Debug)]
pub struct ObjectFlip {
    pub original_layer_id: String,
    pub flipped_layer_id: String,
    pub center_x: f32,
    pub center_y: f32,
    pub flip_count: u32,  // Odd = flipped, even = not flipped
}

/// A single transform action that can be undone/redone
#[derive(Clone, Debug)]
pub struct TransformAction {
    /// Object IDs that were transformed
    pub object_ids: Vec<u64>,
    /// Translation delta applied
    pub delta_x: f32,
    pub delta_y: f32,
    /// Rotation in degrees applied
    pub rotate_degrees: f32,
    /// Whether flip was applied
    pub flipped: bool,
    /// Center point of rotation (needed for undo)
    pub center: (f32, f32),
    /// Original positions before transform (object_id -> (x, y, packed_rot_vis))
    pub original_positions: HashMap<u64, (f32, f32, u32)>,
    /// Final positions after transform (object_id -> (x, y, packed_rot_vis))  
    pub final_positions: HashMap<u64, (f32, f32, u32)>,
}

/// In-memory state: DOM, layers, and layer colors
pub struct ServerState {
    pub xml_file_path: Option<String>,
    pub xml_root: Option<XmlNode>,
    pub layers: Vec<LayerJSON>,
    pub layer_colors: HashMap<String, [f32; 4]>,
    pub modified_colors: HashMap<String, [f32; 4]>,
    pub spatial_index: Option<RTree<SelectableObject>>,
    pub padstack_defs: IndexMap<String, PadStackDef>,
    pub deleted_objects: HashMap<u64, ObjectRange>,
    pub moved_objects: HashMap<u64, ObjectMove>,  // Track moved objects by ID
    pub rotated_objects: HashMap<u64, ObjectRotation>,  // Track rotated objects by ID
    pub flipped_objects: HashMap<u64, ObjectFlip>,  // Track flipped objects by ID
    pub layer_pairs: HashMap<String, String>,  // TOP layer ↔ BOTTOM layer mapping
    pub hidden_layers: HashSet<String>,
    pub all_object_ranges: Vec<ObjectRange>,
    pub design_rules: DesignRules,
    pub drc_violations: Vec<DrcViolation>,
    pub drc_regions: Vec<DrcRegion>,
    pub modified_regions: Vec<ModifiedRegion>,
    pub transform_session: Option<TransformSession>,  // Active transform session
    pub undo_stack: Vec<TransformAction>,  // Undo stack for transform operations
    pub redo_stack: Vec<TransformAction>,  // Redo stack for transform operations
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            xml_file_path: None,
            xml_root: None,
            layers: Vec::new(),
            layer_colors: HashMap::new(),
            modified_colors: HashMap::new(),
            spatial_index: None,
            padstack_defs: IndexMap::new(),
            deleted_objects: HashMap::new(),
            moved_objects: HashMap::new(),
            rotated_objects: HashMap::new(),
            flipped_objects: HashMap::new(),
            layer_pairs: HashMap::new(),
            hidden_layers: HashSet::new(),
            all_object_ranges: Vec::new(),
            design_rules: DesignRules::default(),
            drc_violations: Vec::new(),
            drc_regions: Vec::new(),
            modified_regions: Vec::new(),
            transform_session: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }
    
    /// Record a modified region for incremental DRC
    pub fn record_modified_region(&mut self, range: &ObjectRange) {
        self.modified_regions.push(ModifiedRegion {
            bounds: range.bounds,
            layer_id: range.layer_id.clone(),
            object_id: range.id,
        });
    }
    
    /// Clear modified regions after a full DRC
    pub fn clear_modified_regions(&mut self) {
        self.modified_regions.clear();
    }
    
    /// Check if a file is loaded
    pub fn is_file_loaded(&self) -> bool {
        self.xml_file_path.is_some()
    }
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Result from async DRC computation
pub struct DrcAsyncResult {
    pub regions: Vec<DrcRegion>,
    pub elapsed_ms: f64,
}
