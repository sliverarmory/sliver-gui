use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead, Write};

pub const PROTOCOL: u32 = 1;
pub const MAX_COMMAND: usize = 2 * 1024 * 1024;
pub const MAX_HEADER: usize = 2 * 1024 * 1024;
pub const MAX_PAYLOAD: usize = 256 * 1024;
pub const MAX_CLIPBOARD: usize = 1024 * 1024;
pub const MAX_CLIPBOARD_FILES: usize = 64;
pub const MAX_CLIPBOARD_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PIXELS: usize = 16_000_000;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectAddress {
    host: LoopbackHost,
    port: std::num::NonZeroU16,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum LoopbackHost {
    #[serde(rename = "127.0.0.1")]
    Ipv4,
    #[serde(rename = "::1")]
    Ipv6,
}

impl ConnectAddress {
    pub fn socket_address(self) -> std::net::SocketAddr {
        let ip = match self.host {
            LoopbackHost::Ipv4 => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            LoopbackHost::Ipv6 => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        };
        std::net::SocketAddr::new(ip, self.port.get())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SignInMode {
    #[default]
    Nla,
    RemoteScreen,
}

impl SignInMode {
    pub fn valid_credentials(self, username: &str, password: &str, domain: Option<&str>) -> bool {
        match self {
            Self::Nla => {
                !username.is_empty()
                    && username.len() <= 256
                    && password.len() <= 4096
                    && domain.is_none_or(|domain| domain.len() <= 256)
            }
            Self::RemoteScreen => {
                username.is_empty() && password.is_empty() && domain.is_none_or(str::is_empty)
            }
        }
    }
}

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
        #[serde(default)]
        sign_in_mode: SignInMode,
        connect_address: Option<ConnectAddress>,
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
    #[serde(rename_all = "camelCase")]
    ClipboardFilesOffer {
        offer_id: String,
        files: Vec<ClipboardFile>,
    },
    #[serde(rename_all = "camelCase")]
    ClipboardFilesRequest {
        request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ClipboardFileRead {
        request_id: String,
        clipboard_id: String,
        index: u32,
        offset: u64,
        length: u32,
    },
    #[serde(rename_all = "camelCase")]
    ClipboardFileResponse {
        request_id: String,
        data: Option<String>,
        error: Option<bool>,
    },
    ClipboardFilesCancel {},
    Snapshot {},
    Ack {
        seq: u64,
    },
    Disconnect {},
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClipboardFile {
    pub name: String,
    pub size: u64,
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
    fn connect_address_allows_only_numeric_loopback_and_nonzero_port() {
        for host in ["127.0.0.1", "::1"] {
            let address: ConnectAddress =
                serde_json::from_value(serde_json::json!({"host":host,"port":40000})).unwrap();
            assert!(address.socket_address().ip().is_loopback());
            assert_eq!(address.socket_address().port(), 40000);
        }
        for invalid in [
            serde_json::json!({"host":"localhost","port":3389}),
            serde_json::json!({"host":"192.0.2.1","port":3389}),
            serde_json::json!({"host":"127.0.0.2","port":3389}),
            serde_json::json!({"host":"127.0.0.1","port":0}),
            serde_json::json!({"host":"::1","port":65536}),
            serde_json::json!({"host":"127.0.0.1","port":3389,"password":"secret"}),
        ] {
            assert!(serde_json::from_value::<ConnectAddress>(invalid).is_err());
        }
    }

    #[test]
    fn connect_sign_in_mode_defaults_to_nla_and_rejects_unknown_modes() {
        let mut connect = serde_json::json!({
            "type": "connect", "host": "host.example", "port": 3389,
            "username": "", "password": "", "width": 1280, "height": 720,
            "clipboard": false
        });
        let parse = |value: &Value| {
            let line = format!("{value}\n");
            read_command(&mut line.as_bytes())
        };
        assert!(matches!(
            parse(&connect).unwrap(),
            Some(Command::Connect {
                sign_in_mode: SignInMode::Nla,
                ..
            })
        ));
        for (value, expected) in [
            ("nla", SignInMode::Nla),
            ("remote-screen", SignInMode::RemoteScreen),
        ] {
            connect["signInMode"] = serde_json::json!(value);
            assert!(
                matches!(parse(&connect).unwrap(), Some(Command::Connect { sign_in_mode, .. }) if sign_in_mode == expected)
            );
        }
        for value in [
            serde_json::json!("remoteScreen"),
            serde_json::json!("auto"),
            Value::Null,
            serde_json::json!(true),
        ] {
            connect["signInMode"] = value;
            assert!(parse(&connect).is_err());
        }
    }

    #[test]
    fn sign_in_modes_enforce_their_credential_boundaries() {
        assert!(SignInMode::RemoteScreen.valid_credentials("", "", None));
        assert!(SignInMode::RemoteScreen.valid_credentials("", "", Some("")));
        assert!(!SignInMode::RemoteScreen.valid_credentials("operator", "", None));
        assert!(!SignInMode::RemoteScreen.valid_credentials("", "password", None));
        assert!(!SignInMode::RemoteScreen.valid_credentials("", "", Some("DOMAIN")));
        assert!(!SignInMode::RemoteScreen.valid_credentials(" ", "", None));
        assert!(!SignInMode::Nla.valid_credentials("", "", None));
        assert!(SignInMode::Nla.valid_credentials("operator", "", None));
        assert!(SignInMode::Nla.valid_credentials(
            &"a".repeat(256),
            &"p".repeat(4096),
            Some(&"d".repeat(256))
        ));
        assert!(!SignInMode::Nla.valid_credentials(&"a".repeat(257), "", None));
        assert!(!SignInMode::Nla.valid_credentials("operator", &"p".repeat(4097), None));
        assert!(!SignInMode::Nla.valid_credentials("operator", "", Some(&"d".repeat(257))));
    }

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
