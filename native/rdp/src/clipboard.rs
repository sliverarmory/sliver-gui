use crate::protocol::{MAX_CLIPBOARD, MAX_HEADER, Packet};
use ironrdp_client::rdp::{RdpInputEvent, RdpInputSender};
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory};
use ironrdp_cliprdr::pdu::*;
use ironrdp_core::{IntoOwned, impl_as_any};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use zeroize::Zeroize;

#[derive(Default)]
pub struct ClipboardState {
    pub text: Option<String>,
    pub available: bool,
    pub requested: bool,
    pub ready: bool,
    generation: u64,
    pending_generation: Option<u64>,
}
impl ClipboardState {
    pub fn offer_local_text(&mut self, text: String) {
        if let Some(old) = &mut self.text {
            old.zeroize();
        }
        self.text = Some(text);
        self.available = false;
        self.requested = false;
        self.generation = self.generation.wrapping_add(1);
        // Retain one unanswered generation as a tombstone: CLIPRDR replies have
        // no wire request ID. A new Receive must wait until this reply is drained.
    }

    pub fn request_remote_text(&mut self) -> bool {
        if !self.available || self.requested || self.pending_generation.is_some() {
            return false;
        }
        self.pending_generation = Some(self.generation);
        self.requested = true;
        true
    }

    fn accept_response(&mut self) -> bool {
        if self.pending_generation.take() != Some(self.generation) || !self.requested {
            return false;
        }
        self.requested = false;
        true
    }
}
impl Drop for ClipboardState {
    fn drop(&mut self) {
        if let Some(text) = &mut self.text {
            text.zeroize();
        }
    }
}

pub struct Factory {
    pub state: Arc<Mutex<ClipboardState>>,
    pub input: RdpInputSender,
    pub output: mpsc::Sender<Packet>,
}
impl CliprdrBackendFactory for Factory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(Backend {
            state: self.state.clone(),
            input: self.input.clone(),
            output: self.output.clone(),
        })
    }
}
struct Backend {
    state: Arc<Mutex<ClipboardState>>,
    input: RdpInputSender,
    output: mpsc::Sender<Packet>,
}
impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TextClipboardBackend")
    }
}
impl_as_any!(Backend);
impl Backend {
    fn send(&self, message: ClipboardMessage) {
        if self
            .input
            .try_send(RdpInputEvent::Clipboard(message))
            .is_err()
        {
            self.input.request_close();
        }
    }
    fn emit(&self, header: serde_json::Value) {
        let header = bounded_header(header);
        if self.output.try_send(Packet::control(header)).is_err() {
            self.input.request_close();
        }
    }
}

// JSON escaping can expand a one-MiB text value beyond the wire-header limit.
// Report a clipboard error instead of poisoning the stdout framing stream.
fn bounded_header(header: serde_json::Value) -> serde_json::Value {
    if serde_json::to_vec(&header).is_ok_and(|bytes| bytes.len() <= MAX_HEADER) {
        header
    } else {
        json!({"type":"error","code":"clipboard-too-large"})
    }
}
pub fn formats() -> Vec<ClipboardFormat> {
    vec![ClipboardFormat {
        id: ClipboardFormatId::CF_UNICODETEXT,
        name: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escaped_text_cannot_exceed_the_frame_header_limit() {
        let header =
            bounded_header(json!({"type":"clipboard","text":"\u{1}".repeat(MAX_CLIPBOARD)}));
        assert_eq!(header["code"], "clipboard-too-large");
        let header = bounded_header(json!({"type":"clipboard","text":"hello"}));
        assert_eq!(header["text"], "hello");
    }

    #[test]
    fn local_ownership_resets_availability_and_discards_late_old_reply() {
        let mut state = ClipboardState::default();
        state.available = true;
        assert!(state.request_remote_text());
        state.offer_local_text("new local text".to_owned());
        assert!(!state.available);
        assert!(!state.requested);
        assert!(!state.request_remote_text());
        // Even after a fresh remote FormatList, the old wire reply must drain.
        state.available = true;
        assert!(!state.request_remote_text());
        assert!(!state.accept_response());
        assert!(state.request_remote_text());
        assert!(state.requested);
        assert!(state.accept_response());
        assert!(!state.requested);
        assert!(!state.accept_response());
    }

    #[test]
    fn unanswered_cancelled_request_blocks_new_wire_requests() {
        let mut state = ClipboardState::default();
        state.available = true;
        assert!(state.request_remote_text());
        for _ in 0..64 {
            state.offer_local_text(String::new());
            state.available = true;
            assert!(!state.request_remote_text());
        }
        assert!(!state.accept_response());
        assert!(state.request_remote_text());
    }
}
impl CliprdrBackend for Backend {
    fn temporary_directory(&self) -> &str {
        ""
    }
    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }
    fn on_ready(&mut self) {
        self.state.lock().unwrap().ready = true;
        self.emit(json!({"type":"clipboardReady"}));
    }
    fn on_request_format_list(&mut self) {
        let formats = if self.state.lock().unwrap().text.is_some() {
            formats()
        } else {
            Vec::new()
        };
        self.send(ClipboardMessage::SendInitiateCopy(formats));
    }
    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}
    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        let available = formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT);
        self.state.lock().unwrap().available = available;
        self.emit(json!({"type":"clipboardAvailable","available":available}));
    }
    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let state = self.state.lock().unwrap();
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            state
                .text
                .as_ref()
                .map(|text| FormatDataResponse::new_unicode_string(text))
                .unwrap_or_else(FormatDataResponse::new_error)
        } else {
            FormatDataResponse::new_error()
        };
        self.send(ClipboardMessage::SendFormatData(response.into_owned()));
    }
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let requested = self.state.lock().unwrap().accept_response();
        if !requested {
            return;
        }
        if response.is_error() || response.data().len() > MAX_CLIPBOARD * 2 + 2 {
            self.emit(json!({"type":"error","code":"clipboard-unavailable"}));
            return;
        }
        match response.to_unicode_string() {
            Ok(text) if text.len() <= MAX_CLIPBOARD => {
                self.emit(json!({"type":"clipboard","text":text}))
            }
            _ => self.emit(json!({"type":"error","code":"clipboard-invalid"})),
        }
    }
    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.send(ClipboardMessage::SendFileContentsResponse(
            FileContentsResponse::new_error(request.stream_id),
        ));
    }
    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}
    fn on_lock(&mut self, _: LockDataId) {}
    fn on_unlock(&mut self, _: LockDataId) {}
}
