//! Server state management for the LSP server

use crate::draw::geometry::{LayerJSON, ObjectRange, PadStackDef, SelectableObject};
use crate::draw::drc::{DrcViolation, DrcRegion, DesignRules};
use crate::parse_xml::XmlNode;
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
    pub hidden_layers: HashSet<String>,
    pub all_object_ranges: Vec<ObjectRange>,
    pub design_rules: DesignRules,
    pub drc_violations: Vec<DrcViolation>,
    pub drc_regions: Vec<DrcRegion>,
    pub modified_regions: Vec<ModifiedRegion>,
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
            hidden_layers: HashSet::new(),
            all_object_ranges: Vec::new(),
            design_rules: DesignRules::default(),
            drc_violations: Vec::new(),
            drc_regions: Vec::new(),
            modified_regions: Vec::new(),
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
