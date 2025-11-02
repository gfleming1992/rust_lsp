# 9 APPROVED VENDOR LIST (AVL)

The AVL element defines the mapping between the OEM part or item number (OEMDesignNumber) and the vendor manufacturers part number (VMPN). When an OEM part or item number is multi-sourced this can become a one to many mapping between a single OEMDesignNumber and a list of VMPNs that the OEM has approved to be equivalent. Alternatively the mapping can be defined by an external specification, which is referenced by a SpecRef element. The AVL is created by the OEM, but can be modified, if allowed and necessary, by the board fabricator or the board assembler to reflect the materials and components used in the final electronic assembly.

Each BomItem element in the BOM shall have an OEMDesignNumberRef attribute pointing to a OEMDesignNumber attribute of an AvlItem element in the AVL. Although there may be several Bill of Materials (BOM’s) there is only ever one approved vendor list.

## Attributes

| Attribute /  Element Name | Attribute /  Element Type | Description | Occurrence |
|---|---|---|---|
| Avl | AvlType | The element that identifies the approved suppliers for the parts listed in the Bom or those that have been identified from other sources such as Internal or External Vendor Libraries. | 0-n |
| name | qualifiedNameType | A unique name assigned to a group of approved sources of supply for the materials used in building the electronic assembly. | 1-1 |
| AvlHeader | AvlHeaderType | An embedded element that defines the characteristics of the Avl file, describing the source of the information and who has the responsibility for its creation and update. | 1-1 |
| AvlItem | AvlItemType | An embedded element that indicates the details of the approved supplier information and specifically indicates the relationship to all items in the file contained within every qualified named Bom element. | 1-n |
