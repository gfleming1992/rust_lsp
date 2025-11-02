# Appendix C Summary of Changes from Revision B Am1

## Changes Per Section

### Section 1  Scope
- Removed any company names and specific tool names, per IPC protocol

### Section 3.1  Naming attributes within a IPC-2581 file
- Changed definition of of type qualifiedNameType to pattern ([^:]+)(:[^:]+)?"/>;]*)*
- Removed all references to type shortName in the this document, and replaced all instances of shortName with xsd:string in the schema file

### Section 3.3  Transform Characteristics (Xform)
- Added optional attribute faceUp to element Xform, to be able to describe a component placement such that the component pins are the opposite side of the component to the mounting layer
- Added additional wording to the mirror attribute to describe how it can be used to describe a component
- Placement on the underside of any layer, implying the component is embedded when not on the bottom layer.

### Section 3.3.6 The faceUp Attribute
- Added details on how the faceUp attribute works in combination with the mirror attribute.

### Section 3.4 Base Elements
- Added sub sections for PinRef & Location, since they are used by other parent elements.

### Section 3.5.9  StandardPrimitive
- Removed the Xform child element from all  StandardPrimitive types.
- Ensured all LineDesc and FillDesc child elements wer updated to LineDescGroup and FillDescGroup respectively, to match the schema change that occured in revision B1.

### Section 4 CONTENT
- Order of the Dictionary* elements changed within the child element sequence of parent element Content,so that a dictionary item definition is created before a reference to that dictionary item is defined
- Reflected this order in the order which the Dictionary* elements are defined – sections 4.6 thru 4.12

### Section 4.1  FunctionMode
- Added new  FunctionMode type DFX to support only Dfx element data in the output file.
- Made the LogicalNet section optional for Fabrication & Assembly modes.

### Section 6.1  HistoryRecord
- Added optional attribute lifecyclePhase

### Section 7.2  BomItem
- Added child element  SpecRef to reference any specification to the BomItem. Examples are a purchase specification or assembly instructions for RefDes or FindDes children, a material definition for MatDes children, or document details for DocDes children.

### Section 8.1.1  Spec
- Added EdegPlating, Flex, Loss, SecondaryDrill, and SurfaceFinish to SpecificationType and updated others. See below for details.

### Section 8.1.1.4 Conductor
- Updated the Conductor specification, adding attribute material with enumerated options COPPER | SILVER_INK | CARBON_INK | CONDUCTIVE_INK, and attribute foilType with enumerations per IPC-4652.
- Added enumeration values WEIGHT and PRODUCT_NAME to attribute type, and made type optional.

### Section 8.1.1.5 Dielectric
- Added enumeration values Tg_DSC | Tg_DMA | Tg_TMA | Td | SLASH_ IPC4101 | SLASH _IPC4103 | PRODUCT_NAME to attribute type.
- Removed enumeration values PROCESSABLITY_TEMPERATURE and GLASS_TYPE from attribute type.

### Section 8.1.1.7 Impedance
- Updated the Impedance specification so that all requirements a given impedance can be described within a single Impedance element. This includes adding new substitution child elements SingleEnded, EdgeCoupled, BroadsideCoupled, CoplanarWaveguide. The EdgeCoupled type includes a substitution group LineGap which can be either Spacing (edge to edge) or Pitch (center to center).

### Section 8.1.1.7.6 Impedance SpecRef Instantiation
- Added an explanantion of the possible parent elements of an Impedance SpecRef, and their order of precedence when there is a conflict.

### Section 8.1.1.11 Tool
- Amended the Tool Specifiaction Type to be able to described Torque requirements – added  WRENCH | SCREWDRIVER | PLASMA | PUNCH to tooListType & TORQUE | HEX_NUT_SIZE | PHILLIPS_HEAD | FLAT_HEAD | TORX_HEAD | ALLEN_HEAD to toolPropertyListType

### Section 8.1.1.14 SecondaryDrill
- Added new specification type SecondaryDrill, which can be refereneced by a SpecRef child element of Hole to define a countersink or counterbore feature

### Section 8.1.1.15 EdgePlating
- Added new specification element EdgePlating, to define areas of the board edge that require copper plating

### Section 8.1.1.16 SurfaceFinish
- Added new specification element SurfaceFinish, to define enumerated values of surface finish in accordance with IPC-6012

### Section 8.1.1.17 Flex
- Added new specification element Flex, to define enumerated properties ADHESIVE_SQUEEZE_OUT, DIELECTRIC_SQUEEZE_OUT  & STRESS_RELIEF_FILLET_WIDTH for a flex zone.

### Section 8.1.1.18 Loss
- Added new specification element Loss, with a loss type of one of the following enumerated values ATTENUATION | IMPEDANCE | INSERTION | POWER | SIGNAL | VOLTAGE

### Section 8.1.2 Property
- Added values IN-LB | IN-OZ | FT-LB | N-m | N-cm | MIN | MAX | OZ | OZ/SQ-FT | GRAMS | HENRYS | AMPS | WATTS | VOLTS | FARAD | dB | dB/INCH | dB/MM to propertyUnitType, which is used by attributes unit and refUnit of the Property element

### Section 8.1.3 ChangeRec
- Added new attribute lifecyclePhase to ChangeRec, to indicate a lifecycle phase to the data

### Section 8.2.1 Layer
- Added new child element Profile to Layer, to define board outlines as seen at the Layer, caused by variations in the stackup cross section across the stackup zones in a rigid-flex design.
- Changed EMBEDDED_COMPONENT to COMPONENT_EMBEDDED in layerFunctionType, to be consistent with COMPONENT_TOP and COMPONENT_BOTTOM
- Added new layerFunctionType COMPONENT_FORMED to define components created by a printing or etching process
- Added new layerFunction types to Table 5

### Section 8.2.2.1 Stackup
- Changed child element MatDes to attribute matDes
- Added optional attribute tolPercent, to be able to specify thickness tolerance as a percentage
- Added required attribute stackupStatus with possible enumerations SPECIFIED | PROPOSED | APPROVED

### Section 8.2.2.1 StackupGroup
- Changed child element MatDes to attribute matDes
- Added optional attribute tolPercent, to be able to specify thickness tolerance as a percentage

### Section 8.2.2.1.1 StackupLayer
- Changed child element MatDes to attribute matDes
- Added optional attribute tolPercent, to be able to specify thickness tolerance as a percentage

### (Old) Section 8.2.3.2 PadStack
- Completely removed the definition of PadStack, and its children LayerHole and LayerPad, and all references to them. These elements are no longer supported.
- Subseqent section numbers then moved up, e.g. PadStackDef changed form section 8.2.3.3 to 8.2.3.2, Datum changed from section 8.3.3.4 to 8.2.3.3, etc.

### Section 8.2.3.2.1 PadStackHoleDef
- Added type VIA_CAPPED to the enumerated list of platingStatusType, for attribute platingStatus, to identify plated over vias, also known as VIPPO, CAPPED, POFV

### (Old) Section 8.2.3.3 Route
- Removed the Route section, as it was unused and unnecessary. So the Datum section is now 8.2.3.3, and all other sub sections of 8.2.3 after that have moved up.

### Section 8.2.3.6 Package
- Added child element Topside (described in section 8.2.3.6.5) to element Package, to define pins and other features on the top of the package.
- Added child element OtherSideView (described in section 8.2.3.6.6) to element Package, to define any outline, silkscreen, or assembly drawing on the other side of the board to the mounting layer of the package.

### Section 8.2.3.6.4 Pin
- Added attribute pinPolarity having enumerations PLUS | MINUS |ANODE |CATHODE.
- Added enumeration WIRE_BOND to attribute mountType.

### Section 8.2.3.7 Component
- Added child element SlotCavityRef  (described in section 8.2.3.7.1) to element Component, to reference the slot or cavity that embeds or recesses the component in the PCB
- Added enumerated values EMBEDDED | FORMED | PRESSFIT | WIRE_BONDED | GLUED | CLAMPED | SOCKETED to attribute mountType.
- Added optional attributes matDes, layerRefTopside, modelRef. Made attributes refDes, packageRef optional
- Added optional child element SpecRef, to reference specifications pertaing to the component instance
- Added new section to define SlotCavityRef, used as a child element of Component.
- Added new sections to show examples of discrete emebedded, wire bonded, and formed components, and coins

### Section 8.2.3.8 LogicalNet
- Added optional attribute netPair, to identify a net name that forms a differential pair with the net
- Added optional child element PortRef, that defines an interface to another Step, such as a daughter board or custom IC
- Added optional child element SpecRef, to reference specifications pertaing to the logical net

### Section 8.2.3.9.1 PhyNet
- Added a new element PortRef as a child of PhyNetPoint, to reference a Port definition (see reference to Section 8.2.3.11 below).

### Section 8.2.3.10.1 Set
- Added values TEXT, TEARDROP and GRAPHIC to enumerated list for attribute geometryUsage.
- Added optional attribute netPair, to identify a net name that forms a differential pair with the net associated with the set

### Section 8.2.3.10.5 Hole
- Added optional attribute type to element Hole, with possible enumerated values CIRCLE or SQUARE.
- Added optional child element Xform to element Hole, to be able to assign an angle of rotation to a square drill hole
- Added type VIA_CAPPED to the enumerated list of platingStatusType, for attribute platingStatus, to identify plated over vias, also known as VIPPO, CAPPED, POFV

### Section 8.2.3.10.6 SlotCavity
- Reworded definition of SlotCavity, to clarify, cut to depth, and cut to span options
- Added attributes startCutLayer and direction to child elements MaterialCut & MaterialLeft to enable definition for only one layer, or when direction is ambiguous.
- Added child element Fill to describe any full or partial fill of the SlotCavity by a given material

### Section 8.2.3.10.7 Features
- Added the following clarifying description to the Location element in Features: “The location(s) of the Feature if it is a StandardShape. If the Feature has it’s own built in co-ordinates, such as Line or Polyline then a Location is not required, but then there can be only one instance”

### Section 8.2.3.10.8 NetShort
- Added a new element NetShort as a child of Set, to define intentional physical and electrical shorts between two or more given net names

### Section 8.2.3.11 BendArea
- Added a new element BendArea as a child of Step, to define a bend in a flex circuit

### Section 8.2.3.12 StackupZone
- Added a new element StackupZone as a child of Step, to define stackup zones.

### Section 8.2.3.13 Port
- Added a new element Port as a child of Step, to define a physical and electrical link of type Wirebond, ConnectorMate, or ComponentPad

### Section 8.2.3.14 Model
- Added a new element Model as a child of Step, to define a 3D model. This currently has a single child element Extrusion to describe a simple 3D shape as a combination of 2D shapes extruded to a given height. But more child element types could be added in future releases.

### Section 8.2.3.15 Dfx
- Renamed parent element DfxMeasurementList to simply Dfx
- Changed attribute Criteria to a child element of Dfx and made DfxMeasurement a child of Criteria
- Added a 2nd child element DfxQuery to Dfx, which has a child element DfxResponse
- Refer to section 8.2.3.15 for further details.

### Appendix A
- Removed Appendix A, so that Appendix B became A, C became B, and so on.

### Appendix B (was C)
- Added new and missing layerFunction types
