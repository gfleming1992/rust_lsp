use std::fs::File;
use std::io::BufReader;
use quick_xml::Reader;
use quick_xml::events::Event;
use std::collections::HashMap;

/// Represents a parsed XML node with its properties
/// This is a simplified structure to demonstrate parsing
#[derive(Debug, Clone)]
pub struct XmlNode {
    /// The name/tag of this element
    pub name: String,
    /// Map of attribute names to values
    pub attributes: HashMap<String, String>,
    /// Text content of this node
    pub text_content: String,
    /// Child nodes
    pub children: Vec<XmlNode>,
}

/// Parses an IPC-2581 XML file and returns the root node
///
/// # Arguments
/// * `path` - The file path to the XML file to parse
///
/// # Returns
/// * `Result<XmlNode>` - The parsed XML tree or an error
///
/// # Example
/// ```ignore
/// let root = parse_xml_file("tests/pic_programmerB.xml")?;
/// println!("Root element: {}", root.name);
/// ```
pub fn parse_xml_file<P: AsRef<std::path::Path>>(path: P) -> anyhow::Result<XmlNode> {
    // Open the file in read mode
    let file = File::open(&path)
        .map_err(|e| anyhow::anyhow!("Failed to open file: {}", e))?;
    
    // Create a buffered reader for efficient I/O
    // This is important for large XML files
    let buf_reader = BufReader::new(file);
    
    // Initialize the quick_xml Reader with the buffered reader
    // quick_xml is one of the fastest XML parsers in the Rust ecosystem
    let mut reader = Reader::from_reader(buf_reader);
    
    // Configure the reader for better performance
    reader.trim_text(true);
    
    // Create a buffer to store bytes read from the XML
    let mut buf = Vec::new();

    loop {
        buf.clear();
        let event = reader.read_event_into(&mut buf)?;
        let maybe_root = match event {
            Event::Start(start) => Some((start.into_owned(), false)),
            Event::Empty(start) => Some((start.into_owned(), true)),
            Event::Eof => {
                anyhow::bail!("XML document is empty");
            }
            _ => None,
        };

        if let Some((start, self_closing)) = maybe_root {
            let mut node_buf = Vec::new();
            return parse_node(&mut reader, &mut node_buf, start, self_closing);
        }
    }
}

fn parse_node(reader: &mut Reader<BufReader<File>>, buf: &mut Vec<u8>, start: quick_xml::events::BytesStart<'static>, self_closing: bool) -> anyhow::Result<XmlNode> {
    let element_name_bytes = start.name().as_ref().to_vec();
    let element_name = String::from_utf8_lossy(&element_name_bytes).to_string();
    let attributes = collect_attributes(start.attributes())?;

    let mut node = XmlNode {
        name: element_name,
        attributes,
        text_content: String::new(),
        children: Vec::new(),
    };

    if self_closing {
        return Ok(node);
    }

    loop {
        buf.clear();
        let event = reader.read_event_into(buf)?;
        match event {
            Event::Start(child_start) => {
                let mut child_buf = Vec::new();
                let child = parse_node(reader, &mut child_buf, child_start.into_owned(), false)?;
                node.children.push(child);
            }
            Event::Empty(child_start) => {
                let mut child_buf = Vec::new();
                let child = parse_node(reader, &mut child_buf, child_start.into_owned(), true)?;
                node.children.push(child);
            }
            Event::Text(text) => {
                let value = String::from_utf8_lossy(text.as_ref()).to_string();
                if !value.trim().is_empty() {
                    node.text_content.push_str(&value);
                }
            }
            Event::CData(text) => {
                let value = String::from_utf8_lossy(text.as_ref()).to_string();
                if !value.trim().is_empty() {
                    node.text_content.push_str(&value);
                }
            }
            Event::End(end) => {
                anyhow::ensure!(
                    end.name().as_ref() == element_name_bytes.as_slice(),
                    "unexpected closing tag '</{}>' while parsing '<{}>'",
                    String::from_utf8_lossy(end.name().as_ref()),
                    node.name
                );
                return Ok(node);
            }
            Event::Eof => {
                anyhow::bail!("unexpected end of file while parsing element '{}'", node.name);
            }
            _ => {}
        }
    }
}

fn collect_attributes(attributes: quick_xml::events::attributes::Attributes<'_>) -> anyhow::Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for attr in attributes {
        let attr = attr?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
        let value = String::from_utf8_lossy(attr.value.as_ref()).to_string();
        map.insert(key, value);
    }
    Ok(map)
}

/// Pretty-prints the XML tree structure
/// Useful for debugging and understanding parsed content
///
/// # Arguments
/// * `node` - The node to print
/// * `indent` - Current indentation level
pub fn print_xml_tree(node: &XmlNode, indent: usize) {
    let prefix = " ".repeat(indent);
    
    // Print the element name and attributes
    print!("{}<{}", prefix, node.name);
    
    // Print attributes if any exist
    if !node.attributes.is_empty() {
        for (key, value) in &node.attributes {
            print!(" {}=\"{}\"", key, value);
        }
    }
    
    println!(">");
    
    // Print text content if it exists and is non-empty
    if !node.text_content.trim().is_empty() {
        println!("{}{}", prefix, node.text_content.trim());
    }
    
    // Recursively print all children
    for child in &node.children {
        print_xml_tree(child, indent + 2);
    }
    
    // Print closing tag
    println!("{}</{}>", prefix, node.name);
}
