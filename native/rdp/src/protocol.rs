use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead, Write};

pub const PROTOCOL: u32 = 1;
pub const MAX_COMMAND: usize = 2 * 1024 * 1024;
pub const MAX_HEADER: usize = 2 * 1024 * 1024;
pub const MAX_PAYLOAD: usize = 256 * 1024;
pub const MAX_CLIPBOARD: usize = 1024 * 1024;
pub const MAX_PIXELS: usize = 16_000_000;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Connect {
        host: String,
        port: u16,
        username: String,
        password: String,
        domain: Option<String>,
        width: u16,
        height: u16,
        clipboard: bool,
        pinned_fingerprint: Option<String>,
        keyboard_layout: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    TrustDecision {
        request_id: String,
        accept: bool,
    },
    Input {
        events: Vec<InputEvent>,
    },
    ReleaseAll {},
    #[serde(rename_all = "camelCase")]
    Resize {
        width: u16,
        height: u16,
        scale_factor: u32,
    },
    ClipboardSend {
        text: String,
    },
    ClipboardRequest {},
    Snapshot {},
    Ack {
        seq: u64,
    },
    Disconnect {},
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    Key {
        scan_code: u8,
        extended: bool,
        down: bool,
    },
    #[serde(rename_all = "camelCase")]
    Unicode { code_point: u32, down: bool },
    Mouse {
        x: u16,
        y: u16,
        button: Option<Button>,
        down: Option<bool>,
        wheel: Option<i16>,
        horizontal: Option<bool>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Middle,
    Right,
    Back,
    Forward,
}

pub struct Packet {
    pub header: Value,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn control(header: Value) -> Self {
        Self {
            header,
            payload: Vec::new(),
        }
    }
    pub fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        let header = serde_json::to_vec(&self.header)?;
        if header.len() > MAX_HEADER || self.payload.len() > MAX_PAYLOAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "packet exceeds limit",
            ));
        }
        writer.write_all(&(header.len() as u32).to_le_bytes())?;
        writer.write_all(&(self.payload.len() as u32).to_le_bytes())?;
        writer.write_all(&header)?;
        writer.write_all(&self.payload)?;
        writer.flush()
    }
}

/// `read_until` alone can allocate an unbounded line before applying a limit.
pub fn read_command(reader: &mut impl BufRead) -> io::Result<Option<Command>> {
    // Also zeroize truncated, oversized, and I/O-failed commands on their early return paths.
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "partial command",
            ));
        }
        let end = available.iter().position(|b| *b == b'\n');
        let len = end.map_or(available.len(), |position| position + 1);
        if bytes.len() + len > MAX_COMMAND {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "command exceeds limit",
            ));
        }
        bytes.extend_from_slice(&available[..len]);
        reader.consume(len);
        if end.is_some() {
            let result = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid command"));
            // This buffer may contain a password or clipboard text. Avoid retaining it.
            use zeroize::Zeroize;
            bytes.zeroize();
            return result.map(Some);
        }
    }
}

pub fn valid_dimensions(width: u16, height: u16) -> bool {
    width > 0
        && height > 0
        && width <= 8192
        && height <= 8192
        && usize::from(width) * usize::from(height) <= MAX_PIXELS
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framed_packet_has_exact_lengths() {
        let packet = Packet {
            header: serde_json::json!({"type":"cursor"}),
            payload: vec![1, 2, 3],
        };
        let mut bytes = Vec::new();
        packet.write(&mut bytes).unwrap();
        let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 3);
        assert_eq!(&bytes[8 + len..], &[1, 2, 3]);
    }
    #[test]
    fn rejects_unknown_fields_and_truncated_lines() {
        assert!(read_command(&mut &b"{\"type\":\"disconnect\",\"shell\":true}\n"[..]).is_err());
        assert!(read_command(&mut &b"{\"type\":\"disconnect\"}"[..]).is_err());
        assert!(matches!(
            read_command(&mut &b"{\"type\":\"disconnect\"}\n"[..]).unwrap(),
            Some(Command::Disconnect {})
        ));
    }
    #[test]
    fn dimensions_bound_allocations() {
        assert!(valid_dimensions(3840, 2160));
        assert!(!valid_dimensions(8192, 8192));
        assert!(!valid_dimensions(0, 1080));
        assert!(!valid_dimensions(9000, 10));
    }
}
