# Appendix A Panel Instance File

The following is the full XML instance file for the panel shown in the illustration below. It has passed schema validation, so should load into any tool/viewer that supports IPC-2581 revision B1.

```xml
<?xml version="1.0" encoding="UTF-8"?> 
<IPC-2581 revision="B1" xmlns="http://webstds.ipc.org/2581" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"   
xsi:schemaLocation="http://webstds.ipc.org/2581 http://www.ipc.org/2581/IPC-2581B1.xsd"> 
    <Content roleRef="DesignOwner"> 
        <FunctionMode mode="USERDEF" level="1" comment="Panel Test"/> 
        <StepRef name="panel_1" /> 
        <StepRef name="basicboard_1" /> 
        <StepRef name="basicboard_2" /> 
        <StepRef name="basicboard_3" /> 
        <LayerRef name="OnlyLayer" /> 
    </Content> 
    <LogisticHeader> 
        <Role id="DesignOwner" roleFunction="OWNER" description="Design Owner" publicKey="" authority="" /> 
        <Enterprise id="A Design Company" code="NONE" /> 
        <Person name="A User" enterpriseRef="A Design Company" roleRef="DesignOwner" /> 
    </LogisticHeader> 
    <HistoryRecord number="1" origination="2015-11-13T10:20:02" software="A Tool" lastChange="2015-11-13T10:20:02"> 
        <FileRevision fileRevisionId="1.0" comment="Initial Version"> 
            <SoftwarePackage name="A Tool" vendor="A Tool Company" revision="1.0"> 
                <Certification certificationStatus="BETA" /> 
            </SoftwarePackage> 
        </FileRevision> 
    </HistoryRecord> 
    <Bom name="BOM_panel_1"> 
        <BomHeader assembly="Assembly1" revision="1.0"> 
            <StepRef name="panel_1" /> 
        </BomHeader> 
        <BomItem OEMDesignNumberRef="orderNumber_brd1" quantity="12" category="MATERIAL"> 
          <Characteristics category="MATERIAL"/> 
        </BomItem> 
        <BomItem OEMDesignNumberRef=" orderNumber_brd2" quantity="1" category="MATERIAL"> 
          <Characteristics category="MATERIAL"/> 
        </BomItem> 
        <BomItem OEMDesignNumberRef=" orderNumber_brd3" quantity="1" category="MATERIAL"> 
          <Characteristics category="MATERIAL"/> 
       </BomItem> 
    </Bom> 
    <Ecad name="Design"> 
        <CadHeader units="MILLIMETER"> 
        </CadHeader> 
        <CadData> 
            <Layer name="OnlyLayer" layerFunction="DOCUMENT" side="NONE" polarity="POSITIVE"> 
            </Layer> 
            <Stackup name="DummyStackup" overallThickness="0" tolPlus="0" tolMinus="0" whereMeasured="OTHER"> 
            </Stackup> 
            <Step name="panel_1"> 
                <Datum x="0.0" y="0.0" /> 
                <Profile> 
                    <Polygon> 
                        <PolyBegin x="-10.0" y="680.0" /> 
                        <PolyStepSegment x="-10.0" y="0.0" /> 
                        <PolyStepSegment x="0.0" y="-10.0" /> 
                        <PolyStepSegment x="980.0" y="-10.0" /> 
                        <PolyStepSegment x="990.0" y="0.0" /> 
                        <PolyStepSegment x="990.0" y="680.0" /> 
                        <PolyStepSegment x="980.0" y="690.0" /> 
                        <PolyStepSegment x="0.0" y="690.0" /> 
                        <PolyStepSegment x="-10.0" y="680.0" /> 
                    </Polygon> 
                </Profile> 
                <StepRepeat stepRef="basicboard_1" x="57.0" y="12.0" nx="1" ny="7" dx="0" dy="102.0" angle="0.00" mirror="false" /> 
                <StepRepeat stepRef="basicboard_2" x="260.0" y="467.0" nx="1" ny="1" dx="0" dy="0" angle="0.00" mirror="false" /> 
                <StepRepeat stepRef="basicboard_1" x="928.0" y="18.0" nx="1" ny="5" dx="0" dy="138.0" angle="90.00" mirror="false" /> 
                <StepRepeat stepRef="basicboard_3" x="260.0" y="110.0" nx="1" ny="1" dx="0" dy="0" angle="0.00" mirror="false" /> 
                <LayerFeature layerRef="OnlyLayer"> 
                    <Set polarity="POSITIVE"> 
                        <Color r="153" g="255" b="255" /> 
                        <Features> 
                            <Arc startX="3" startY="3" endX="3" endY="3" centerX="0" centerY="0" clockwise="false"> 
                                <LineDesc lineWidth="1.4" lineEnd="ROUND" /> 
                            </Arc> 
                        </Features> 
                    </Set> 
                </LayerFeature> 
            </Step> 
            <Step name="basicboard_1"> 
                <Datum x="0.0" y="0.0" /> 
                <Profile> 
                    <Polygon> 
                        <PolyBegin x="-17.0" y="-12.0" /> 
                        <PolyStepSegment x="110.0" y="-12.0" /> 
                        <PolyStepSegment x="110.0" y="54.0" /> 
                        <PolyStepSegment x="-17.0" y="54.0" /> 
                        <PolyStepSegment x="-17.0" y="-12.0" /> 
                    </Polygon> 
                </Profile> 
                <LayerFeature layerRef="OnlyLayer"> 
                    <Set polarity="POSITIVE"> 
                        <Color r="153" g="255" b="255" /> 
                        <Features> 
                            <Arc startX="3" startY="3" endX="3" endY="3" centerX="0" centerY="0" clockwise="false"> 
                                <LineDesc lineWidth="0.025" lineEnd="ROUND" /> 
                            </Arc> 
                        </Features> 
                    </Set> 
                </LayerFeature> 
            </Step> 
            <Step name="basicboard_2"> 
                <Datum x="0.0" y="0.0" /> 
                <Profile> 
                    <Polygon> 
                        <PolyBegin x="-25.0" y="-10.0" /> 
                        <PolyStepSegment x="484.0" y="-10.0" /> 
                        <PolyStepSegment x="484.0" y="122.0" /> 
                        <PolyStepSegment x="-25.0" y="122.0" /> 
                        <PolyStepSegment x="-25.0" y="-10.0" /> 
                    </Polygon> 
                </Profile> 
                <LayerFeature layerRef="OnlyLayer"> 
                    <Set polarity="POSITIVE"> 
                        <Color r="153" g="255" b="255" /> 
                        <Features> 
                            <Arc startX="3" startY="3" endX="3" endY="3" centerX="0" centerY="0" clockwise="false"> 
                                <LineDesc lineWidth="0.025" lineEnd="ROUND" /> 
                            </Arc> 
                        </Features> 
                    </Set> 
                </LayerFeature> 
            </Step> 
            <Step name="basicboard_3"> 
                <Datum x="0.0" y="0.0" /> 
                <Profile> 
                    <Polygon> 
                        <PolyBegin x="-25.0" y="-20.0" /> 
                        <PolyStepSegment x="484.0" y="-20.0" /> 
                        <PolyStepSegment x="484.0" y="245.0" /> 
                        <PolyStepSegment x="-25.0" y="245.0" /> 
                        <PolyStepSegment x="-25.0" y="-20.0" /> 
                    </Polygon> 
                </Profile> 
                <LayerFeature layerRef="OnlyLayer"> 
                    <Set polarity="POSITIVE"> 
                        <Color r="153" g="255" b="255" /> 
                        <Features> 
                            <Arc startX="3" startY="3" endX="3" endY="3" centerX="0" centerY="0" clockwise="false"> 
                                <LineDesc lineWidth="0.025" lineEnd="ROUND" /> 
                            </Arc> 
                        </Features> 
                    </Set> 
                </LayerFeature> 
            </Step> 
        </CadData> 
    </Ecad> 
    <Avl name="AVL_Panel_1"> 
      <AvlHeader title="latest AVL" source="A PLM Tool" author="A User" datetime="2015-11-13T10:20:02" version="1"/> 
      <AvlItem OEMDesignNumber=" orderNumber_brd1"/> 
      <AvlItem OEMDesignNumber=" orderNumber_brd2"/> 
      <AvlItem OEMDesignNumber=" orderNumber_brd3"/> 
    </Avl>   
</IPC-2581> 
```
