use crate::protocol::{
    ClipboardFile, Command, MAX_CLIPBOARD, MAX_CLIPBOARD_FILE_BYTES, MAX_CLIPBOARD_FILES,
    MAX_HEADER, MAX_PAYLOAD, Packet,
};
use crate::upload_progress::{RequestShape, UploadProgress};
use base64::Engine;
use ironrdp_client::rdp::{RdpInputEvent, RdpInputSender};
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory};
use ironrdp_cliprdr::pdu::*;
use ironrdp_core::{IntoOwned, impl_as_any};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::mpsc;
use zeroize::{Zeroize, Zeroizing};

const MAX_PENDING_READS: usize = 16;
const MAX_REMOTE_RANGE: usize = 4 * 1024 * 1024;
const MAX_BUFFERED_RANGES: usize = 16 * 1024 * 1024;

#[derive(Default)]
struct Effects {
    messages: Vec<ClipboardMessage>,
    packets: Vec<Packet>,
    queued_uploads: Vec<QueuedUpload>,
}

struct QueuedUpload {
    transfer_id: String,
    request: RequestShape,
    length: u64,
}
impl Effects {
    fn event(&mut self, header: serde_json::Value) {
        self.packets.push(Packet::control(header));
    }
    fn file_error(&mut self, request_id: &str, code: &str) {
        self.event(json!({"type":"clipboardFilesError","requestId":request_id,"code":code}));
    }
    fn read_error(&mut self, request_id: &str) {
        self.event(json!({"type":"clipboardFileChunk","requestId":request_id,"error":true}));
    }
}

enum FormatKind {
    Text,
    Files(String),
}
struct PendingFormat {
    generation: u64,
    kind: FormatKind,
}
struct FileCollection {
    id: String,
    files: Vec<ClipboardFile>,
}
struct Download {
    request_id: String,
    length: usize,
}
struct Upload {
    stream_id: u32,
    offer_id: String,
    index: u32,
    offset: u64,
    length: usize,
    data: Zeroizing<Vec<u8>>,
    transfer_id: Option<String>,
    request: RequestShape,
}
impl Upload {
    fn next_length(&self) -> usize {
        (self.length - self.data.len()).min(MAX_PAYLOAD)
    }
    fn request_packet(&self, request_id: &str) -> Packet {
        Packet::control(json!({"type":"clipboardFileRequest","requestId":request_id,
            "offerId":self.offer_id,"index":self.index,
            "offset":self.offset + self.data.len() as u64,"length":self.next_length()}))
    }
}

#[derive(Default)]
pub struct ClipboardState {
    pub text: Option<String>,
    pub available: bool,
    pub requested: bool,
    pub ready: bool,
    files_supported: bool,
    generation: u64,
    pending_format: Option<PendingFormat>,
    remote_file_format: Option<ClipboardFormatId>,
    local_files: Option<FileCollection>,
    remote_files: Option<FileCollection>,
    downloads: HashMap<u32, Download>,
    uploads: HashMap<String, Upload>,
    next_stream: u32,
    next_upload: u64,
    next_snapshot: u64,
    next_transfer: u64,
    upload_progress: Option<UploadProgress>,
}
impl ClipboardState {
    fn begin_upload(&mut self, request: RequestShape, effects: &mut Effects) -> Option<String> {
        let collection = self.local_files.as_ref()?;
        if !request.size
            && (request.length == 0
                || collection
                    .files
                    .get(request.index as usize)
                    .is_none_or(|file| request.offset >= file.size))
        {
            return None;
        }
        let now = Instant::now();
        let restart = self.upload_progress.as_ref().is_none_or(|progress| {
            progress.offer_id != collection.id || progress.restart_for(request, now)
        });
        if restart {
            self.next_transfer = self.next_transfer.checked_add(1)?;
            let progress = UploadProgress::new(
                collection.id.clone(),
                format!("upload-{}", self.next_transfer),
                collection.files.iter().map(|file| file.size),
                now,
            );
            effects.packets.push(progress.packet());
            self.upload_progress = Some(progress);
        }
        self.upload_progress
            .as_ref()
            .filter(|progress| progress.active())
            .map(|progress| progress.transfer_id.clone())
    }

    fn upload_queued(&mut self, queued: Vec<QueuedUpload>) -> Vec<Packet> {
        let Some(progress) = &mut self.upload_progress else {
            return Vec::new();
        };
        queued
            .into_iter()
            .filter_map(|queued| {
                if queued.transfer_id != progress.transfer_id {
                    return None;
                }
                progress.queued(queued.request, queued.length, Instant::now())
            })
            .collect()
    }

    fn terminate_upload(&mut self, phase: &'static str, effects: &mut Effects) {
        if let Some(packet) = self
            .upload_progress
            .as_mut()
            .and_then(|progress| progress.terminate(phase, Instant::now()))
        {
            effects.packets.push(packet);
        }
    }

    // Keep an unanswered format request as a tombstone. CLIPRDR format replies
    // have no request ID, so another request must wait until it is drained.
    fn invalidate(&mut self) -> Effects {
        let mut effects = Effects::default();
        self.terminate_upload("canceled", &mut effects);
        self.upload_progress = None;
        if self.requested {
            match &self.pending_format {
                Some(PendingFormat {
                    kind: FormatKind::Files(id),
                    ..
                }) => {
                    effects.file_error(id, "clipboard-files-changed");
                }
                Some(PendingFormat {
                    kind: FormatKind::Text,
                    ..
                }) => {
                    effects.event(json!({"type":"error","code":"clipboard-unavailable"}));
                }
                None => {}
            }
        }
        self.generation = self.generation.wrapping_add(1);
        self.requested = false;
        self.available = false;
        self.remote_file_format = None;
        self.remote_files = None;
        self.local_files = None;
        if let Some(mut text) = self.text.take() {
            text.zeroize();
        }
        for (_, download) in self.downloads.drain() {
            effects.read_error(&download.request_id);
        }
        for (_, upload) in self.uploads.drain() {
            effects
                .messages
                .push(ClipboardMessage::SendFileContentsResponse(
                    FileContentsResponse::new_error(upload.stream_id),
                ));
        }
        effects
    }

    fn offer_local_text(&mut self, text: String) -> Effects {
        let mut effects = self.invalidate();
        self.text = Some(text);
        effects.event(json!({"type":"clipboardAvailable","available":false}));
        effects.event(json!({"type":"clipboardFilesAvailable","available":false}));
        effects
            .messages
            .push(ClipboardMessage::SendInitiateCopy(formats()));
        effects
    }

    pub fn request_remote_text(&mut self) -> bool {
        if !self.available || self.requested || self.pending_format.is_some() {
            return false;
        }
        self.pending_format = Some(PendingFormat {
            generation: self.generation,
            kind: FormatKind::Text,
        });
        self.requested = true;
        true
    }

    fn accept_response(&mut self) -> Option<FormatKind> {
        let pending = self.pending_format.take()?;
        if pending.generation != self.generation || !self.requested {
            return None;
        }
        self.requested = false;
        Some(pending.kind)
    }

    fn next_upload_id(&mut self) -> Result<String, &'static str> {
        self.next_upload = self
            .next_upload
            .checked_add(1)
            .ok_or("clipboard-files-limit")?;
        Ok(format!("local-{}", self.next_upload))
    }

    fn file_command(&mut self, command: Command) -> Result<Effects, &'static str> {
        if matches!(command, Command::ClipboardFilesCancel {}) {
            let mut effects = Effects::default();
            self.terminate_upload("canceled", &mut effects);
            self.upload_progress = None;
            if let Some(PendingFormat {
                kind: FormatKind::Files(id),
                ..
            }) = &self.pending_format
                && self.requested
            {
                effects.file_error(id, "clipboard-files-cancelled");
                self.requested = false;
            }
            self.remote_files = None;
            for (_, download) in self.downloads.drain() {
                effects.read_error(&download.request_id);
            }
            for (_, upload) in self.uploads.drain() {
                effects
                    .messages
                    .push(ClipboardMessage::SendFileContentsResponse(
                        FileContentsResponse::new_error(upload.stream_id),
                    ));
            }
            if self.local_files.take().is_some() && self.ready {
                effects
                    .messages
                    .push(ClipboardMessage::SendInitiateCopy(Vec::new()));
            }
            return Ok(effects);
        }
        if !self.ready || !self.files_supported {
            return Err("clipboard-files-unsupported");
        }
        let mut effects = Effects::default();
        match command {
            Command::ClipboardFilesOffer { offer_id, files } => {
                if !valid_id(&offer_id) || !valid_files(&files) {
                    return Err("clipboard-files-invalid");
                }
                effects = self.invalidate();
                let descriptors = files
                    .iter()
                    .map(|file| {
                        FileDescriptor::new(&file.name)
                            .with_file_size(file.size)
                            .with_attributes(ClipboardFileAttributes::NORMAL)
                    })
                    .collect();
                self.local_files = Some(FileCollection {
                    id: offer_id,
                    files,
                });
                effects.event(json!({"type":"clipboardAvailable","available":false}));
                effects.event(json!({"type":"clipboardFilesAvailable","available":false}));
                effects
                    .messages
                    .push(ClipboardMessage::SendInitiateFileCopy(descriptors));
            }
            Command::ClipboardFilesRequest { request_id } => {
                if !valid_id(&request_id) {
                    return Err("clipboard-files-invalid");
                }
                let format = self
                    .remote_file_format
                    .ok_or("clipboard-files-unavailable")?;
                if self.pending_format.is_some() {
                    return Err("clipboard-files-busy");
                }
                self.pending_format = Some(PendingFormat {
                    generation: self.generation,
                    kind: FormatKind::Files(request_id),
                });
                self.requested = true;
                effects
                    .messages
                    .push(ClipboardMessage::SendInitiatePaste(format));
            }
            Command::ClipboardFileRead {
                request_id,
                clipboard_id,
                index,
                offset,
                length,
            } => {
                if !valid_id(&request_id) || length == 0 || length as usize > MAX_PAYLOAD {
                    return Err("clipboard-files-invalid");
                }
                let collection = self
                    .remote_files
                    .as_ref()
                    .filter(|files| files.id == clipboard_id)
                    .ok_or("clipboard-files-changed")?;
                let file = collection
                    .files
                    .get(index as usize)
                    .ok_or("clipboard-files-invalid")?;
                if offset > file.size || u64::from(length) > file.size - offset {
                    return Err("clipboard-files-invalid");
                }
                if self.downloads.len() >= MAX_PENDING_READS
                    || self
                        .downloads
                        .values()
                        .any(|pending| pending.request_id == request_id)
                {
                    return Err("clipboard-files-busy");
                }
                self.next_stream = self
                    .next_stream
                    .checked_add(1)
                    .ok_or("clipboard-files-limit")?;
                let stream_id = self.next_stream;
                self.downloads.insert(
                    stream_id,
                    Download {
                        request_id,
                        length: length as usize,
                    },
                );
                effects
                    .messages
                    .push(ClipboardMessage::SendFileContentsRequest(
                        FileContentsRequest {
                            stream_id,
                            index: index as i32,
                            flags: FileContentsFlags::RANGE,
                            position: offset,
                            requested_size: length,
                            data_id: None,
                        },
                    ));
            }
            Command::ClipboardFileResponse {
                request_id,
                data,
                error,
            } => {
                let data = data.map(Zeroizing::new);
                let mut upload = self
                    .uploads
                    .remove(&request_id)
                    .ok_or("clipboard-files-stale-request")?;
                let decoded = match data.as_ref() {
                    Some(data)
                        if error != Some(true) && data.len() <= MAX_PAYLOAD.div_ceil(3) * 4 =>
                    {
                        base64::engine::general_purpose::STANDARD
                            .decode(data.as_bytes())
                            .ok()
                            .map(Zeroizing::new)
                    }
                    _ => None,
                };
                if let Some(data) = decoded.filter(|data| data.len() == upload.next_length()) {
                    upload.data.extend_from_slice(&data);
                    if upload.data.len() < upload.length {
                        let next_id = self.next_upload_id()?;
                        effects.packets.push(upload.request_packet(&next_id));
                        self.uploads.insert(next_id, upload);
                    } else {
                        if let Some(transfer_id) = upload.transfer_id {
                            effects.queued_uploads.push(QueuedUpload {
                                transfer_id,
                                request: upload.request,
                                length: upload.length as u64,
                            });
                        }
                        effects
                            .messages
                            .push(ClipboardMessage::SendFileContentsResponse(
                                FileContentsResponse::new_data_response(
                                    upload.stream_id,
                                    std::mem::take(&mut *upload.data),
                                ),
                            ));
                    }
                } else {
                    self.terminate_upload("failed", &mut effects);
                    self.local_files = None;
                    effects
                        .messages
                        .push(ClipboardMessage::SendFileContentsResponse(
                            FileContentsResponse::new_error(upload.stream_id),
                        ));
                    effects.file_error(&upload.offer_id, "clipboard-file-read-failed");
                }
            }
            _ => return Err("clipboard-files-invalid"),
        }
        Ok(effects)
    }

    fn upload_request(&mut self, request: FileContentsRequest) -> Effects {
        let mut effects = Effects::default();
        let error = || {
            ClipboardMessage::SendFileContentsResponse(FileContentsResponse::new_error(
                request.stream_id,
            ))
        };
        let Some(collection) = &self.local_files else {
            effects.messages.push(error());
            return effects;
        };
        let Some(file_size) = usize::try_from(request.index)
            .ok()
            .and_then(|index| collection.files.get(index))
            .map(|file| file.size)
        else {
            effects.messages.push(error());
            return effects;
        };
        let offer_id = collection.id.clone();
        let shape = RequestShape {
            index: request.index as u32,
            offset: request.position,
            length: request.requested_size,
            size: request.flags == FileContentsFlags::SIZE,
        };
        if !self.files_supported || request.data_id.is_some() {
            effects.messages.push(error());
        } else if request.flags == FileContentsFlags::SIZE
            && request.position == 0
            && request.requested_size == 8
        {
            if let Some(transfer_id) = self.begin_upload(shape, &mut effects) {
                effects.queued_uploads.push(QueuedUpload {
                    transfer_id,
                    request: shape,
                    length: 0,
                });
            }
            effects
                .messages
                .push(ClipboardMessage::SendFileContentsResponse(
                    FileContentsResponse::new_size_response(request.stream_id, file_size),
                ));
        } else if request.flags == FileContentsFlags::RANGE
            && request.position <= file_size
            && request.requested_size as usize <= MAX_REMOTE_RANGE
            && self.uploads.len() < MAX_PENDING_READS
            && !self
                .uploads
                .values()
                .any(|upload| upload.stream_id == request.stream_id)
        {
            let length =
                u64::from(request.requested_size).min(file_size - request.position) as usize;
            let buffered: usize = self.uploads.values().map(|upload| upload.length).sum();
            if buffered + length > MAX_BUFFERED_RANGES {
                effects.messages.push(error());
                return effects;
            }
            let transfer_id = self.begin_upload(shape, &mut effects);
            if length == 0 {
                if let Some(transfer_id) = transfer_id {
                    effects.queued_uploads.push(QueuedUpload {
                        transfer_id,
                        request: shape,
                        length: 0,
                    });
                }
                effects
                    .messages
                    .push(ClipboardMessage::SendFileContentsResponse(
                        FileContentsResponse::new_data_response(request.stream_id, Vec::new()),
                    ));
                return effects;
            }
            let upload = Upload {
                stream_id: request.stream_id,
                offer_id,
                index: request.index as u32,
                offset: request.position,
                length,
                data: Zeroizing::new(Vec::new()),
                transfer_id,
                request: shape,
            };
            match self.next_upload_id() {
                Ok(request_id) => {
                    effects.packets.push(upload.request_packet(&request_id));
                    self.uploads.insert(request_id, upload);
                }
                Err(_) => effects.messages.push(error()),
            }
        } else {
            effects.messages.push(error());
        }
        effects
    }
}
impl Drop for ClipboardState {
    fn drop(&mut self) {
        if let Some(text) = &mut self.text {
            text.zeroize();
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_files(files: &[ClipboardFile]) -> bool {
    if files.is_empty() || files.len() > MAX_CLIPBOARD_FILES {
        return false;
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    files.iter().all(|file| {
        total = total.saturating_add(file.size);
        valid_name(&file.name)
            && total <= MAX_CLIPBOARD_FILE_BYTES
            && names.insert(file.name.to_lowercase())
    })
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.encode_utf16().count() <= 259
        && name != "."
        && name != ".."
        && !name.ends_with([' ', '.'])
        && !name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
        && !ironrdp_cliprdr::is_windows_device_name(name)
}

pub async fn offer_text(
    state: &Arc<Mutex<ClipboardState>>,
    sender: &RdpInputSender,
    output: &mpsc::Sender<Packet>,
    text: String,
) -> Result<(), &'static str> {
    let effects = state.lock().unwrap().offer_local_text(text);
    apply_effects(state, sender, output, effects).await
}
pub async fn handle_file_command(
    state: &Arc<Mutex<ClipboardState>>,
    sender: &RdpInputSender,
    output: &mpsc::Sender<Packet>,
    command: Command,
) -> Result<(), &'static str> {
    let id = match &command {
        Command::ClipboardFilesOffer { offer_id, .. } => Some(offer_id.clone()),
        Command::ClipboardFilesRequest { request_id }
        | Command::ClipboardFileRead { request_id, .. }
        | Command::ClipboardFileResponse { request_id, .. } => Some(request_id.clone()),
        _ => None,
    };
    let result = state.lock().unwrap().file_command(command);
    match result {
        Ok(effects) => apply_effects(state, sender, output, effects).await,
        Err(code) => {
            let mut header = json!({"type":"clipboardFilesError","code":code});
            if let Some(id) = id {
                header["requestId"] = id.into();
            }
            crate::emit(output, header).await;
            Ok(())
        }
    }
}
async fn apply_effects(
    state: &Arc<Mutex<ClipboardState>>,
    sender: &RdpInputSender,
    output: &mpsc::Sender<Packet>,
    effects: Effects,
) -> Result<(), &'static str> {
    for packet in effects.packets {
        if !crate::send_packet(output, packet).await {
            return Err("input-backpressure");
        }
    }
    for message in effects.messages {
        crate::send_input(sender, RdpInputEvent::Clipboard(message)).await?;
    }
    let packets = state.lock().unwrap().upload_queued(effects.queued_uploads);
    for packet in packets {
        if !crate::send_packet(output, packet).await {
            return Err("input-backpressure");
        }
    }
    Ok(())
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
        f.write_str("ClipboardBackend")
    }
}
impl_as_any!(Backend);
impl Backend {
    fn send(&self, message: ClipboardMessage) -> bool {
        if self
            .input
            .try_send(RdpInputEvent::Clipboard(message))
            .is_err()
        {
            self.input.request_close();
            return false;
        }
        true
    }
    fn emit(&self, header: serde_json::Value) {
        self.packet(Packet::control(bounded_header(header)));
    }
    fn packet(&self, packet: Packet) {
        if self.output.try_send(packet).is_err() {
            self.input.request_close();
        }
    }
    fn apply(&self, effects: Effects) {
        for packet in effects.packets {
            self.packet(packet);
        }
        for message in effects.messages {
            if !self.send(message) {
                return;
            }
        }
        let packets = self
            .state
            .lock()
            .unwrap()
            .upload_queued(effects.queued_uploads);
        for packet in packets {
            self.packet(packet);
        }
    }
}

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

impl CliprdrBackend for Backend {
    fn temporary_directory(&self) -> &str {
        ""
    }
    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
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
    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        let supported =
            capabilities.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED);
        self.state.lock().unwrap().files_supported = supported;
        self.emit(json!({"type":"clipboardFilesCapability","supported":supported}));
    }
    fn on_format_list_response(&mut self, ok: bool) {
        if !ok {
            let id = self
                .state
                .lock()
                .unwrap()
                .local_files
                .as_ref()
                .map(|files| files.id.clone());
            if let Some(id) = id {
                let effects = self.state.lock().unwrap().invalidate();
                self.apply(effects);
                self.emit(json!({"type":"clipboardFilesError","requestId":id,"code":"clipboard-files-rejected"}));
            }
        }
    }
    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        let mut state = self.state.lock().unwrap();
        let effects = state.invalidate();
        state.available = formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT);
        state.remote_file_format = if state.files_supported {
            formats
                .iter()
                .find(|format| {
                    format
                        .name
                        .as_ref()
                        .is_some_and(|name| name.value() == "FileGroupDescriptorW")
                })
                .map(|format| format.id)
        } else {
            None
        };
        let available = state.available;
        let files_available = state.remote_file_format.is_some();
        drop(state);
        self.apply(effects);
        self.emit(json!({"type":"clipboardAvailable","available":available}));
        self.emit(json!({"type":"clipboardFilesAvailable","available":files_available}));
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
        match requested {
            Some(FormatKind::Files(id)) => self.emit(json!({"type":"clipboardFilesError","requestId":id,"code":"clipboard-files-unavailable"})),
            Some(FormatKind::Text) => {
                if response.is_error() || response.data().len() > MAX_CLIPBOARD * 2 + 2 {
                    self.emit(json!({"type":"error","code":"clipboard-unavailable"}));
                } else {
                    match response.to_unicode_string() {
                        Ok(text) if text.len() <= MAX_CLIPBOARD => self.emit(json!({"type":"clipboard","text":text})),
                        _ => self.emit(json!({"type":"error","code":"clipboard-invalid"})),
                    }
                }
            }
            None => {},
        }
    }
    fn on_remote_file_list(&mut self, files: &[FileDescriptor], _: Option<u32>) {
        let mut state = self.state.lock().unwrap();
        let Some(FormatKind::Files(request_id)) = state.accept_response() else {
            return;
        };
        if files.is_empty() || files.len() > MAX_CLIPBOARD_FILES {
            drop(state);
            self.emit(json!({"type":"clipboardFilesError","requestId":request_id,"code":"clipboard-files-invalid"}));
            return;
        }
        let metadata: Option<Vec<ClipboardFile>> = files
            .iter()
            .map(|file| {
                if file
                    .relative_path
                    .as_ref()
                    .is_some_and(|path| !path.is_empty())
                    || file.attributes.is_some_and(|attributes| {
                        attributes.contains(ClipboardFileAttributes::DIRECTORY)
                    })
                {
                    return None;
                }
                Some(ClipboardFile {
                    name: file.name.clone(),
                    size: file.file_size?,
                })
            })
            .collect();
        let metadata = metadata.filter(|files| valid_files(files));
        if let Some(files) = metadata {
            state.next_snapshot = state.next_snapshot.wrapping_add(1);
            let clipboard_id = format!("clipboard-{}-{}", state.generation, state.next_snapshot);
            state.remote_files = Some(FileCollection {
                id: clipboard_id.clone(),
                files: files.clone(),
            });
            drop(state);
            self.emit(json!({"type":"clipboardFiles","requestId":request_id,"clipboardId":clipboard_id,"files":files}));
        } else {
            drop(state);
            self.emit(json!({"type":"clipboardFilesError","requestId":request_id,"code":"clipboard-files-invalid"}));
        }
    }
    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let effects = self.state.lock().unwrap().upload_request(request);
        self.apply(effects);
    }
    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let pending = self
            .state
            .lock()
            .unwrap()
            .downloads
            .remove(&response.stream_id());
        let Some(pending) = pending else {
            return;
        };
        let error = response.is_error() || response.data().len() != pending.length;
        self.packet(Packet {
            header: json!({"type":"clipboardFileChunk","requestId":pending.request_id,"error":error}),
            payload: if error { Vec::new() } else { response.data().to_vec() },
        });
    }
    fn on_lock(&mut self, _: LockDataId) {}
    fn on_unlock(&mut self, _: LockDataId) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> ClipboardState {
        let mut state = ClipboardState::default();
        state.ready = true;
        state.files_supported = true;
        state
    }
    fn file() -> ClipboardFile {
        ClipboardFile {
            name: "hello.txt".into(),
            size: 3,
        }
    }
    #[test]
    fn escaped_text_cannot_exceed_the_frame_header_limit() {
        assert_eq!(
            bounded_header(json!({"type":"clipboard","text":"\u{1}".repeat(MAX_CLIPBOARD)}))["code"],
            "clipboard-too-large"
        );
        assert_eq!(
            bounded_header(json!({"type":"clipboard","text":"hello"}))["text"],
            "hello"
        );
    }
    #[test]
    fn local_ownership_discards_late_old_reply() {
        let mut state = state();
        state.available = true;
        assert!(state.request_remote_text());
        state.offer_local_text("new local text".to_owned());
        assert!(!state.available);
        state.available = true;
        assert!(!state.request_remote_text());
        assert!(state.accept_response().is_none());
        assert!(state.request_remote_text());
        assert!(matches!(state.accept_response(), Some(FormatKind::Text)));
    }
    #[test]
    fn filenames_and_collection_sizes_are_strictly_bounded() {
        for name in [
            "../secret",
            "C:\\secret",
            "folder/file",
            "..",
            "CON",
            "nul.txt",
            "a:",
            "a.",
            "a ",
            "a\n",
        ] {
            assert!(!valid_name(name), "{name}");
        }
        assert!(valid_files(&[file()]));
        assert!(!valid_files(&[file(), file()]));
        assert!(!valid_files(&[ClipboardFile {
            name: "large".into(),
            size: MAX_CLIPBOARD_FILE_BYTES + 1
        }]));
        assert!(!valid_files(&vec![file(); MAX_CLIPBOARD_FILES + 1]));
    }
    #[test]
    fn cancelled_file_metadata_is_a_tombstone_and_cannot_be_reused_as_text() {
        let mut state = state();
        state.remote_file_format = Some(ClipboardFormatId::CF_UNICODETEXT);
        state
            .file_command(Command::ClipboardFilesRequest {
                request_id: "metadata".into(),
            })
            .unwrap();
        let effects = state
            .file_command(Command::ClipboardFilesCancel {})
            .unwrap();
        assert!(
            effects
                .packets
                .iter()
                .any(|packet| packet.header["requestId"] == "metadata")
        );
        state.available = true;
        assert!(!state.request_remote_text());
        assert!(state.accept_response().is_none());
        assert!(state.request_remote_text());
    }
    #[test]
    fn local_reads_are_correlated_and_cancelled() {
        let mut state = state();
        state
            .file_command(Command::ClipboardFilesOffer {
                offer_id: "offer".into(),
                files: vec![file()],
            })
            .unwrap();
        let effects = state.upload_request(FileContentsRequest {
            stream_id: 7,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 0,
            requested_size: 3,
            data_id: None,
        });
        assert_eq!(effects.packets[1].header["length"], 3);
        let id = effects.packets[1].header["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        let effects = state
            .file_command(Command::ClipboardFileResponse {
                request_id: id.clone(),
                data: Some("YWJj".into()),
                error: None,
            })
            .unwrap();
        assert!(
            matches!(&effects.messages[0], ClipboardMessage::SendFileContentsResponse(response) if response.data() == b"abc" && response.stream_id() == 7)
        );
        assert!(
            state
                .file_command(Command::ClipboardFileResponse {
                    request_id: id,
                    data: Some("YWJj".into()),
                    error: None
                })
                .is_err()
        );
        state
            .file_command(Command::ClipboardFilesCancel {})
            .unwrap();
        let effects = state.upload_request(FileContentsRequest {
            stream_id: 8,
            index: 0,
            flags: FileContentsFlags::SIZE,
            position: 0,
            requested_size: 8,
            data_id: None,
        });
        assert!(
            matches!(&effects.messages[0], ClipboardMessage::SendFileContentsResponse(response) if response.is_error())
        );
    }
    #[test]
    fn oversized_remote_ranges_are_served_in_bounded_host_chunks() {
        let mut state = state();
        state.local_files = Some(FileCollection {
            id: "offer".into(),
            files: vec![ClipboardFile {
                name: "file".into(),
                size: (MAX_PAYLOAD + 3) as u64,
            }],
        });
        let effects = state.upload_request(FileContentsRequest {
            stream_id: 1,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 0,
            requested_size: (MAX_PAYLOAD + 3) as u32,
            data_id: None,
        });
        assert_eq!(effects.packets[1].header["length"], MAX_PAYLOAD);
        let id = effects.packets[1].header["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        let effects = state
            .file_command(Command::ClipboardFileResponse {
                request_id: id,
                data: Some(
                    base64::engine::general_purpose::STANDARD.encode(vec![1u8; MAX_PAYLOAD]),
                ),
                error: None,
            })
            .unwrap();
        assert_eq!(effects.packets[0].header["offset"], MAX_PAYLOAD);
        assert_eq!(effects.packets[0].header["length"], 3);
        assert!(effects.messages.is_empty());
        let effects = state.invalidate();
        assert!(
            matches!(&effects.messages[0], ClipboardMessage::SendFileContentsResponse(response) if response.is_error())
        );
    }
    #[test]
    fn remote_reads_cannot_escape_the_selected_snapshot_or_file_bounds() {
        let mut state = state();
        state.remote_files = Some(FileCollection {
            id: "snapshot".into(),
            files: vec![file()],
        });
        let read = |id: &str, offset, length| Command::ClipboardFileRead {
            request_id: "read".into(),
            clipboard_id: id.into(),
            index: 0,
            offset,
            length,
        };
        assert!(state.file_command(read("old", 0, 3)).is_err());
        assert!(state.file_command(read("snapshot", 2, 2)).is_err());
        assert!(
            state
                .file_command(read("snapshot", 0, MAX_PAYLOAD as u32 + 1))
                .is_err()
        );
        assert!(state.file_command(read("snapshot", 0, 3)).is_ok());
        assert!(state.file_command(read("snapshot", 0, 3)).is_err());
        let effects = state.invalidate();
        assert!(
            effects
                .packets
                .iter()
                .any(|packet| packet.header["type"] == "clipboardFileChunk"
                    && packet.header["error"] == true)
        );
    }

    #[test]
    fn cancelling_files_preserves_text_requests_and_remote_advertisements() {
        let mut state = state();
        state.text = Some("local text".into());
        state.available = true;
        state.remote_file_format = Some(ClipboardFormatId::new(0xc000));
        assert!(state.request_remote_text());
        let effects = state
            .file_command(Command::ClipboardFilesCancel {})
            .unwrap();
        assert_eq!(state.text.as_deref(), Some("local text"));
        assert!(state.available);
        assert!(state.remote_file_format.is_some());
        assert!(effects.packets.is_empty());
        assert!(effects.messages.is_empty());
        assert!(matches!(state.accept_response(), Some(FormatKind::Text)));
    }

    #[test]
    fn file_offer_reports_cancelled_text_and_drains_its_late_response() {
        let mut state = state();
        state.available = true;
        assert!(state.request_remote_text());
        let effects = state
            .file_command(Command::ClipboardFilesOffer {
                offer_id: "new-files".into(),
                files: vec![file()],
            })
            .unwrap();
        assert!(
            effects
                .packets
                .iter()
                .any(|packet| packet.header["type"] == "error"
                    && packet.header["code"] == "clipboard-unavailable")
        );
        state.available = true;
        assert!(!state.request_remote_text());
        assert!(state.accept_response().is_none());
        assert!(state.request_remote_text());
    }

    #[test]
    fn backend_correlates_metadata_and_binary_downloads_and_rejects_short_reads() {
        let (input, _input_receiver) = RdpInputSender::channel(32);
        let (output, mut packets) = mpsc::channel(32);
        let mut backend = Backend {
            state: Arc::new(Mutex::new(state())),
            input,
            output,
        };
        backend.on_remote_copy(&[ClipboardFormat {
            id: ClipboardFormatId::new(0xc000),
            name: Some(ClipboardFormatName::new("FileGroupDescriptorW")),
        }]);
        assert_eq!(
            packets.try_recv().unwrap().header["type"],
            "clipboardAvailable"
        );
        assert_eq!(packets.try_recv().unwrap().header["available"], true);
        backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesRequest {
                request_id: "metadata".into(),
            })
            .unwrap();
        backend.on_remote_file_list(&[FileDescriptor::new("hello.txt").with_file_size(3)], None);
        let metadata = packets.try_recv().unwrap().header;
        assert_eq!(metadata["type"], "clipboardFiles");
        assert_eq!(metadata["requestId"], "metadata");
        let clipboard_id = metadata["clipboardId"].as_str().unwrap().to_owned();
        let effects = backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFileRead {
                request_id: "read".into(),
                clipboard_id: clipboard_id.clone(),
                index: 0,
                offset: 0,
                length: 3,
            })
            .unwrap();
        let ClipboardMessage::SendFileContentsRequest(request) = &effects.messages[0] else {
            panic!("expected read");
        };
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            request.stream_id,
            b"abc".as_slice(),
        ));
        let packet = packets.try_recv().unwrap();
        assert_eq!(packet.header["requestId"], "read");
        assert_eq!(packet.header["error"], false);
        assert_eq!(packet.payload, b"abc");
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            request.stream_id,
            b"abc".as_slice(),
        ));
        assert!(packets.try_recv().is_err());
        let effects = backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFileRead {
                request_id: "short".into(),
                clipboard_id,
                index: 0,
                offset: 0,
                length: 3,
            })
            .unwrap();
        let ClipboardMessage::SendFileContentsRequest(request) = &effects.messages[0] else {
            panic!("expected read");
        };
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            request.stream_id,
            b"a".as_slice(),
        ));
        let packet = packets.try_recv().unwrap();
        assert_eq!(packet.header["requestId"], "short");
        assert_eq!(packet.header["error"], true);
        assert!(packet.payload.is_empty());
    }

    #[test]
    fn backend_rejects_directories_and_allocates_fresh_metadata_snapshot_ids() {
        let (input, _input_receiver) = RdpInputSender::channel(32);
        let (output, mut packets) = mpsc::channel(32);
        let mut backend = Backend {
            state: Arc::new(Mutex::new(state())),
            input,
            output,
        };
        backend.state.lock().unwrap().remote_file_format = Some(ClipboardFormatId::new(0xc000));
        backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesRequest {
                request_id: "directory".into(),
            })
            .unwrap();
        backend.on_remote_file_list(
            &[FileDescriptor::new("folder")
                .with_file_size(0)
                .with_attributes(ClipboardFileAttributes::DIRECTORY)],
            None,
        );
        assert_eq!(
            packets.try_recv().unwrap().header["code"],
            "clipboard-files-invalid"
        );
        backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesRequest {
                request_id: "first".into(),
            })
            .unwrap();
        backend.on_remote_file_list(&[FileDescriptor::new("file").with_file_size(0)], None);
        let first = packets.try_recv().unwrap().header["clipboardId"].clone();
        backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesCancel {})
            .unwrap();
        backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesRequest {
                request_id: "second".into(),
            })
            .unwrap();
        backend.on_remote_file_list(&[FileDescriptor::new("file").with_file_size(0)], None);
        let second = packets.try_recv().unwrap().header["clipboardId"].clone();
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn upload_progress_counts_only_responses_accepted_by_the_input_queue() {
        let (input, mut input_receiver) = RdpInputSender::channel(32);
        let (output, mut packets) = mpsc::channel(32);
        let state = Arc::new(Mutex::new(state()));
        let mut backend = Backend {
            state: state.clone(),
            input: input.clone(),
            output: output.clone(),
        };
        state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesOffer {
                offer_id: "offer".into(),
                files: vec![file()],
            })
            .unwrap();
        backend.on_file_contents_request(FileContentsRequest {
            stream_id: 1,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 0,
            requested_size: 3,
            data_id: None,
        });
        let start = packets.try_recv().unwrap().header;
        assert_eq!(start["phase"], "transferring");
        assert_eq!(start["transferredBytes"], 0);
        let request_id = packets.try_recv().unwrap().header["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(packets.try_recv().is_err());
        handle_file_command(
            &state,
            &input,
            &output,
            Command::ClipboardFileResponse {
                request_id,
                data: Some("YWJj".into()),
                error: None,
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(input_receiver.try_recv().unwrap(), RdpInputEvent::Clipboard(ClipboardMessage::SendFileContentsResponse(response)) if response.data() == b"abc")
        );
        let complete = packets.try_recv().unwrap().header;
        assert_eq!(complete["phase"], "completed");
        assert_eq!(complete["transferId"], start["transferId"]);
        assert_eq!(complete["transferredBytes"], 3);
        assert_eq!(complete["completedFiles"], 1);
        assert!(packets.try_recv().is_err());
        // EOF, empty RANGE and SIZE probes can follow a completed copy. Serve
        // them without replacing the completed transfer with a phantom cycle.
        for (stream_id, flags, position, requested_size) in [
            (2, FileContentsFlags::RANGE, 3, 3),
            (3, FileContentsFlags::RANGE, 0, 0),
            (4, FileContentsFlags::SIZE, 0, 8),
        ] {
            backend.on_file_contents_request(FileContentsRequest {
                stream_id,
                index: 0,
                flags,
                position,
                requested_size,
                data_id: None,
            });
            assert!(
                matches!(input_receiver.try_recv().unwrap(), RdpInputEvent::Clipboard(ClipboardMessage::SendFileContentsResponse(response)) if !response.is_error())
            );
            assert!(packets.try_recv().is_err());
        }
        // Another nonempty range starts a fresh cycle for the same offer.
        backend.on_file_contents_request(FileContentsRequest {
            stream_id: 5,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 0,
            requested_size: 1,
            data_id: None,
        });
        let second = packets.try_recv().unwrap().header;
        assert_eq!(second["phase"], "transferring");
        assert_ne!(second["transferId"], start["transferId"]);
        let effects = state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesCancel {})
            .unwrap();
        assert_eq!(effects.packets[0].header["phase"], "canceled");
        assert_eq!(
            effects.packets[0].header["transferId"],
            second["transferId"]
        );
        assert!(
            state
                .lock()
                .unwrap()
                .file_command(Command::ClipboardFilesCancel {})
                .unwrap()
                .packets
                .is_empty()
        );
    }

    #[test]
    fn zero_byte_upload_completes_only_after_a_peer_request_and_queued_response() {
        let (input, mut input_receiver) = RdpInputSender::channel(32);
        let (output, mut packets) = mpsc::channel(32);
        let mut backend = Backend {
            state: Arc::new(Mutex::new(state())),
            input,
            output,
        };
        let effects = backend
            .state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesOffer {
                offer_id: "empty".into(),
                files: vec![ClipboardFile {
                    name: "empty".into(),
                    size: 0,
                }],
            })
            .unwrap();
        assert!(
            !effects
                .packets
                .iter()
                .any(|packet| packet.header["type"] == "clipboardFileUploadProgress")
        );
        backend.on_file_contents_request(FileContentsRequest {
            stream_id: 1,
            index: 0,
            flags: FileContentsFlags::SIZE,
            position: 0,
            requested_size: 8,
            data_id: None,
        });
        let start = packets.try_recv().unwrap().header;
        assert_eq!(start["phase"], "transferring");
        assert_eq!(start["completedFiles"], 1);
        assert!(input_receiver.try_recv().is_ok());
        let complete = packets.try_recv().unwrap().header;
        assert_eq!(complete["phase"], "completed");
        assert_eq!(complete["transferId"], start["transferId"]);
        assert_eq!(complete["transferredBytes"], 0);
        assert_eq!(complete["totalBytes"], 0);
    }

    #[tokio::test]
    async fn failed_upload_emits_a_single_terminal_progress_event() {
        let (input, _input_receiver) = RdpInputSender::channel(32);
        let (output, mut packets) = mpsc::channel(32);
        let state = Arc::new(Mutex::new(state()));
        let mut backend = Backend {
            state: state.clone(),
            input: input.clone(),
            output: output.clone(),
        };
        state
            .lock()
            .unwrap()
            .file_command(Command::ClipboardFilesOffer {
                offer_id: "offer".into(),
                files: vec![file()],
            })
            .unwrap();
        backend.on_file_contents_request(FileContentsRequest {
            stream_id: 1,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 0,
            requested_size: 3,
            data_id: None,
        });
        let start = packets.try_recv().unwrap().header;
        let request_id = packets.try_recv().unwrap().header["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        handle_file_command(
            &state,
            &input,
            &output,
            Command::ClipboardFileResponse {
                request_id,
                data: None,
                error: Some(true),
            },
        )
        .await
        .unwrap();
        let failed = packets.try_recv().unwrap().header;
        assert_eq!(failed["phase"], "failed");
        assert_eq!(failed["transferId"], start["transferId"]);
        assert_eq!(
            packets.try_recv().unwrap().header["type"],
            "clipboardFilesError"
        );
        assert!(
            state
                .lock()
                .unwrap()
                .file_command(Command::ClipboardFilesCancel {})
                .unwrap()
                .packets
                .is_empty()
        );
    }
}
