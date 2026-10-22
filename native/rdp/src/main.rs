mod clipboard;
mod display;
mod input;
mod protocol;
mod upload_progress;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use display::{Credits, Display};
use input::InputState;
use ironrdp_client::config::{ClipboardType, ConfigBuilder, Destination};
use ironrdp_client::output_channel::output_channel;
use ironrdp_client::rdp::{RdpClient, RdpInputEvent, RdpInputSender, RdpOutputEvent};
use ironrdp_cliprdr::backend::ClipboardMessage;
use ironrdp_cliprdr::pdu::ClipboardFormatId;
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_tls::{CertificateValidation, PeerCertificateStatus};
use protocol::{Command, MAX_CLIPBOARD, Packet, SignInMode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, BufReader};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, mpsc};
use zeroize::Zeroize;

type PendingTrust = Arc<Mutex<Option<(String, std::sync::mpsc::SyncSender<bool>)>>>;
type SharedDisplay = Arc<Mutex<Display>>;
type Output = mpsc::Sender<Packet>;

fn build_info() -> Value {
    json!({"name":"sliver-rdp","version":env!("CARGO_PKG_VERSION"),"protocol":protocol::PROTOCOL,
        "ironrdpRevision":option_env!("SLIVER_RDP_SOURCE_REVISION").unwrap_or("development"),
        "buildIdentity":option_env!("SLIVER_RDP_BUILD_ID").unwrap_or("development"),
        "target":option_env!("SLIVER_RDP_BUILD_TARGET").unwrap_or(std::env::consts::ARCH)})
}

fn main() {
    // No default tracing subscriber: upstream diagnostics must not leak auth/protocol payloads.
    std::panic::set_hook(Box::new(|_| eprintln!("sliver-rdp: internal failure")));
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("sliver-rdp {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--build-info") => {
            println!("{}", build_info());
            return;
        }
        Some("--self-test") => {
            if display::self_test().is_err() {
                eprintln!("sliver-rdp: self test failed");
                std::process::exit(1);
            }
            println!("{}", json!({"ok":true,"protocol":protocol::PROTOCOL}));
            return;
        }
        Some(_) => {
            eprintln!("sliver-rdp: unsupported argument");
            std::process::exit(2);
        }
        None => {}
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let (output, mut packets) = mpsc::channel::<Packet>(40);
    let writer_stop = stopped.clone();
    std::thread::spawn(move || {
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        while let Some(packet) = packets.blocking_recv() {
            if packet.write(&mut writer).is_err() {
                writer_stop.store(true, Ordering::Release);
                break;
            }
        }
    });
    let (commands, receiver) = mpsc::channel(64);
    let reader_stop = stopped.clone();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            match protocol::read_command(&mut reader) {
                Ok(Some(command)) => {
                    if commands.blocking_send(Ok(command)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = commands.blocking_send(Err("invalid-command"));
                    break;
                }
            }
        }
        reader_stop.store(true, Ordering::Release);
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(run(receiver, output, stopped.clone()));
    stopped.store(true, Ordering::Release);
    runtime.shutdown_timeout(Duration::from_secs(1));
}

async fn emit(output: &Output, header: Value) -> bool {
    send_packet(output, Packet::control(header)).await
}

async fn send_packet(output: &Output, packet: Packet) -> bool {
    tokio::time::timeout(Duration::from_secs(3), output.send(packet))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn run(
    mut commands: mpsc::Receiver<Result<Command, &'static str>>,
    output: Output,
    stopped: Arc<AtomicBool>,
) {
    let info = build_info();
    if !emit(&output,json!({"type":"ready","protocol":protocol::PROTOCOL,"version":info["version"],"revision":info["ironrdpRevision"],"buildIdentity":info["buildIdentity"]})).await{return;}
    let framebuffer = Arc::new(Mutex::new(Display::default()));
    let credits = Arc::new(Mutex::new(Credits::default()));
    let notify = Arc::new(Notify::new());
    let pending: PendingTrust = Arc::new(Mutex::new(None));
    let clip = Arc::new(Mutex::new(clipboard::ClipboardState::default()));
    let mut input: Option<RdpInputSender> = None;
    let mut engine = None;
    let mut input_state = InputState::default();
    let mut clipboard_enabled = false;
    let active = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));
    let display_task = tokio::spawn(present(
        framebuffer.clone(),
        credits.clone(),
        notify.clone(),
        output.clone(),
        stopped.clone(),
    ));
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            _=poll.tick()=>if stopped.load(Ordering::Acquire)||ended.load(Ordering::Acquire){break;},
            command=commands.recv()=>{
                let Some(command)=command else{break;};
                let command=match command{Ok(command)=>command,Err(code)=>{emit(&output,json!({"type":"error","code":code})).await;break;}};
                match command {
                    Command::Connect{host,port,username,mut password,domain,sign_in_mode,connect_address,width,height,clipboard,pinned_fingerprint,keyboard_layout}=>{
                        if input.is_some()||!valid_endpoint(&host,port)||!sign_in_mode.valid_credentials(&username,&password,domain.as_deref())
                            ||!protocol::valid_dimensions(width,height)
                            ||pinned_fingerprint.as_ref().is_some_and(|pin|pin.len()!=64||!pin.bytes().all(|b|b.is_ascii_hexdigit())) {
                            password.zeroize();emit(&output,json!({"type":"error","code":"invalid-connect"})).await;break;
                        }
                        let destination=if host.contains(':'){format!("[{host}]:{port}")}else{format!("{host}:{port}")};
                        let peer_policy=certificate_policy(pinned_fingerprint.map(|pin|pin.to_ascii_lowercase()),pending.clone(),output.clone(),stopped.clone());
                        let mut builder=with_sign_in_security(ConfigBuilder::new(),sign_in_mode)
                            .with_destination(match Destination::new(destination){Ok(value)=>value,Err(_)=>{password.zeroize();break;}})
                            .with_username(username).with_password(std::mem::take(&mut password))
                            .with_client_build(1).with_client_name("Sliver GUI").with_client_dir("C:\\Windows\\System32\\mstscax.dll")
                            .with_platform(MajorPlatformType::UNSPECIFIED)
                            .with_peer_certificate_policy(peer_policy)
                            .with_negotiation_cookie("SliverGUI".to_owned())
                            .with_desktop_width(width).with_desktop_height(height).with_keyboard_layout(keyboard_layout.unwrap_or(0))
                            .with_color_depth(32).with_lossy_compression(false).with_server_pointer(true).with_pointer_software_rendering(false)
                            .with_graphics_pipeline(true)
                            .with_clipboard(if clipboard{ClipboardType::Enable}else{ClipboardType::Disable});
                        if let Some(domain)=domain{builder=builder.with_domain(domain);}
                        if let Some(address)=connect_address{builder=builder.with_tcp_connect_address(address.socket_address());}
                        let config=match builder.build(){Ok(config)=>config,Err(_)=>{emit(&output,json!({"type":"state","state":"failed","code":"invalid-config"})).await;break;}};
                        let (events,receiver)=output_channel(4);
                        let mut client=RdpClient::new(config,events).with_desktop_updates().with_desktop_limits(8192,8192,protocol::MAX_PIXELS).with_display_resize_reconnect(false);
                        let sender=client.input_sender();
                        if clipboard{client=client.with_cliprdr_backend_factory(Box::new(clipboard::Factory{state:clip.clone(),input:sender.clone(),output:output.clone()}));}
                        clipboard_enabled=clipboard;input=Some(sender.clone());
                        emit(&output,json!({"type":"state","state":"connecting"})).await;
                        engine=Some(tokio::task::spawn_blocking(move || tokio::runtime::Builder::new_current_thread().enable_all().build().expect("engine runtime").block_on(client.run())));
                        tokio::spawn(consume(receiver,framebuffer.clone(),output.clone(),sender,active.clone(),ended.clone(),stopped.clone()));
                    }
                    Command::TrustDecision{request_id,accept}=>{
                        let mut pending=pending.lock().unwrap();
                        if pending.as_ref().is_some_and(|(id,_)|*id==request_id){if let Some((_,decision))=pending.take(){let _=decision.try_send(accept);}}
                    }
                    Command::Ack{seq}=>{credits.lock().unwrap().ack(seq);notify.notify_one();}
                    Command::Snapshot{}=>{
                        let cursor={let mut display=framebuffer.lock().unwrap();display.request_snapshot();display.cursor.clone()};
                        if let Some((header,payload))=cursor{if !send_packet(&output,Packet{header,payload}).await{break;}}
                        let position=framebuffer.lock().unwrap().cursor_position;
                        if let Some((x,y))=position{emit(&output,json!({"type":"cursor","kind":"position","x":x,"y":y})).await;}
                        notify.notify_one();
                    }
                    Command::Disconnect{}=>break,
                    command=>{
                        let Some(sender)=&input else{emit(&output,json!({"type":"error","code":"not-connected"})).await;continue;};
                        if !active.load(Ordering::Acquire){emit(&output,json!({"type":"error","code":"not-active"})).await;continue;}
                        let dimensions=framebuffer.lock().unwrap().dimensions();
                        let result=match command {
                            Command::Input{events} if events.len()<=64=>{
                                let mut next=input_state.clone();let mut translated=Vec::new();let mut error=None;
                                for event in events{match next.translate(event,dimensions){Ok(events)=>translated.extend(events),Err(code)=>{error=Some(code);break;}}}
                                if let Some(code)=error{Err(code)}else{match send_input(sender,RdpInputEvent::FastPath(translated.into_iter().collect())).await{Ok(())=>{input_state=next;Ok(())},Err(code)=>Err(code)}}
                            }
                            Command::ReleaseAll{}=>send_input(sender,RdpInputEvent::FastPath(input_state.release_all(dimensions).into_iter().collect())).await,
                            Command::Resize{width,height,scale_factor} if protocol::valid_dimensions(width,height)&&(100..=500).contains(&scale_factor)=>{
                                send_input(sender,RdpInputEvent::Resize{width,height,scale_factor,physical_size:None}).await
                            }
                            Command::ClipboardSend{mut text} if clipboard_enabled&&text.len()<=MAX_CLIPBOARD&&!text.contains('\0')=>{
                                clipboard::offer_text(&clip,sender,&output,std::mem::take(&mut text)).await
                            }
                            Command::ClipboardRequest{} if clipboard_enabled=>{
                                let available=clip.lock().unwrap().request_remote_text();
                                if available{send_input(sender,RdpInputEvent::Clipboard(ClipboardMessage::SendInitiatePaste(ClipboardFormatId::CF_UNICODETEXT))).await}else{Err("clipboard-unavailable")}
                            }
                            command @ (Command::ClipboardFilesOffer{..}|Command::ClipboardFilesRequest{..}|Command::ClipboardFileRead{..}|Command::ClipboardFileResponse{..}|Command::ClipboardFilesCancel{}) if clipboard_enabled=>{
                                clipboard::handle_file_command(&clip,sender,&output,command).await
                            }
                            _=>Err("invalid-command-state"),
                        };
                        if let Err(code)=result{emit(&output,json!({"type":"error","code":code})).await;if code=="input-backpressure"{break;}}
                    }
                }
            }
        }
    }
    stopped.store(true, Ordering::Release);
    display_task.abort();
    if let Some((_, decision)) = pending.lock().unwrap().take() {
        let _ = decision.try_send(false);
    }
    if let Some(sender) = input {
        let dimensions = framebuffer.lock().unwrap().dimensions();
        let events = input_state.release_all(dimensions);
        if !events.is_empty() {
            let _ = sender.try_send(RdpInputEvent::FastPath(events.into_iter().collect()));
        }
        sender.request_graceful_close();
        if let Some(mut task) = engine {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                sender.request_close();
                task.abort();
            }
        }
    }
    emit(&output, json!({"type":"terminated","code":"closed"})).await;
    // Allow the independent stdout thread to drain the small terminal-control queue.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

fn with_sign_in_security(builder: ConfigBuilder, mode: SignInMode) -> ConfigBuilder {
    // Advertise exactly one sign-in path. A server refusal must never change the mode.
    builder
        .with_tls(mode == SignInMode::RemoteScreen)
        .with_credssp(mode == SignInMode::Nla)
        .with_autologon(false)
        .with_certificate_validation(CertificateValidation::Strict)
}

fn connection_error_code(error: &ironrdp_connector::ConnectorError) -> &'static str {
    use ironrdp_connector::ConnectorErrorKind;
    use std::error::Error as _;
    match error.kind() {
        ConnectorErrorKind::AccessDenied => "access-denied",
        ConnectorErrorKind::Credssp(error) => match error.error_type {
            ironrdp_connector::sspi::ErrorKind::LogonDenied
            | ironrdp_connector::sspi::ErrorKind::UnknownCredentials
            | ironrdp_connector::sspi::ErrorKind::NoCredentials => "authentication-failed",
            _ => "authentication-error",
        },
        ConnectorErrorKind::Negotiation(failure)
            if failure.code() == ironrdp_pdu::nego::FailureCode::HYBRID_REQUIRED_BY_SERVER =>
        {
            "nla-required"
        }
        ConnectorErrorKind::Negotiation(_) => "security-negotiation-failed",
        _ => {
            let mut source = error.source();
            while let Some(cause) = source {
                if let Some(error) = cause.downcast_ref::<ironrdp_connector::ConnectorError>() {
                    return connection_error_code(error);
                }
                if let Some(error) = cause.downcast_ref::<std::io::Error>() {
                    return match error.kind() {
                        io::ErrorKind::ConnectionRefused => "connection-refused",
                        io::ErrorKind::TimedOut => "connection-timeout",
                        io::ErrorKind::PermissionDenied => "connection-denied",
                        _ => "transport-failed",
                    };
                }
                source = cause.source();
            }
            "connection-failed"
        }
    }
}

fn valid_endpoint(host: &str, port: u16) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && port != 0
        && !host.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | '@' | '[' | ']')
        })
}

async fn send_input(sender: &RdpInputSender, mut event: RdpInputEvent) -> Result<(), &'static str> {
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match sender.try_send(event) {
            Ok(()) => return Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => return Err("session-closed"),
            Err(mpsc::error::TrySendError::Full(value)) => event = value,
        };
        if Instant::now() >= deadline {
            return Err("input-backpressure");
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

fn certificate_policy(
    pin: Option<String>,
    pending: PendingTrust,
    output: Output,
    stopped: Arc<AtomicBool>,
) -> ironrdp_tls::PeerCertificatePolicy {
    let counter = AtomicU64::new(0);
    Arc::new(move |der, endpoint, status| {
        let fingerprint = format!("{:x}", Sha256::digest(der));
        let kind = match status {
            PeerCertificateStatus::Valid => "valid",
            PeerCertificateStatus::UnknownIssuer => "unknownIssuer",
            PeerCertificateStatus::Expired => "expired",
            PeerCertificateStatus::NotValidYet => "notValidYet",
            PeerCertificateStatus::NameMismatch => "nameMismatch",
            PeerCertificateStatus::HardFailure => "hardFailure",
        };
        let pin_matches = pin.as_ref().is_some_and(|pin| *pin == fingerprint);
        let needs_review = pin.as_ref().is_some_and(|pin| *pin != fingerprint)
            || status != PeerCertificateStatus::Valid && !pin_matches;
        let can_override = status == PeerCertificateStatus::Valid || status.can_override();
        let mut approved = can_override && !needs_review;
        if needs_review || !can_override {
            let request_id = (counter.fetch_add(1, Ordering::Relaxed) + 1).to_string();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            *pending.lock().unwrap() = Some((request_id.clone(), tx));
            let header = json!({"type":"certificate","requestId":request_id,"endpoint":endpoint,"fingerprint":fingerprint,
                "certificateDer":BASE64.encode(der),"validationKind":if pin.is_some()&&!pin_matches&&status==PeerCertificateStatus::Valid{"pinMismatch"}else{kind},"canOverride":can_override});
            if output.try_send(Packet::control(header)).is_err() {
                *pending.lock().unwrap() = None;
                return false;
            }
            if can_override {
                let deadline = Instant::now() + Duration::from_secs(60);
                while !stopped.load(Ordering::Acquire) && Instant::now() < deadline {
                    match rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(value) => {
                            approved = value;
                            break;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(_) => {}
                    }
                }
            }
            *pending.lock().unwrap() = None;
        }
        if approved && !stopped.load(Ordering::Acquire) {
            if output.try_send(Packet::control(json!({"type":"peerCertificate","endpoint":endpoint,"fingerprint":fingerprint,"certificateDer":BASE64.encode(der),"validationKind":kind}))).is_err(){return false;}
            let _ = output.try_send(Packet::control(
                json!({"type":"state","state":"authenticating"}),
            ));
            true
        } else {
            false
        }
    })
}

async fn consume(
    mut events: ironrdp_client::output_channel::OutputEventReceiver,
    display: SharedDisplay,
    output: Output,
    input: RdpInputSender,
    active: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
) {
    while let Some(event) = events.recv().await {
        match event {
            RdpOutputEvent::Connected => {
                active.store(true, Ordering::Release);
                emit(&output, json!({"type":"state","state":"active"})).await;
            }
            RdpOutputEvent::DesktopUpdate(update) => {
                let (pixels, width, height, rect) = update.into_parts();
                if display
                    .lock()
                    .unwrap()
                    .apply(
                        width.get(),
                        height.get(),
                        rect.left,
                        rect.top,
                        rect.right - rect.left + 1,
                        rect.bottom - rect.top + 1,
                        &pixels,
                    )
                    .is_err()
                {
                    emit(
                        &output,
                        json!({"type":"state","state":"failed","code":"display-limit"}),
                    )
                    .await;
                    input.request_close();
                    break;
                }
            }
            RdpOutputEvent::Image {
                buffer,
                width,
                height,
            } => {
                if display
                    .lock()
                    .unwrap()
                    .apply(
                        width.get(),
                        height.get(),
                        0,
                        0,
                        width.get(),
                        height.get(),
                        &buffer,
                    )
                    .is_err()
                {
                    input.request_close();
                    break;
                }
            }
            RdpOutputEvent::PointerBitmap(pointer) => {
                if pointer.bitmap_data.len() > protocol::MAX_PAYLOAD {
                    input.request_close();
                    break;
                }
                let header = json!({"type":"cursor","kind":"bitmap","width":pointer.width,"height":pointer.height,"hotspotX":pointer.hotspot_x,"hotspotY":pointer.hotspot_y});
                display.lock().unwrap().cursor =
                    Some((header.clone(), pointer.bitmap_data.clone()));
                if !send_packet(
                    &output,
                    Packet {
                        header,
                        payload: pointer.bitmap_data.clone(),
                    },
                )
                .await
                {
                    input.request_close();
                    break;
                }
            }
            RdpOutputEvent::PointerPosition { x, y } => {
                display.lock().unwrap().cursor_position = Some((x, y));
                emit(
                    &output,
                    json!({"type":"cursor","kind":"position","x":x,"y":y}),
                )
                .await;
            }
            RdpOutputEvent::PointerDefault | RdpOutputEvent::PointerHidden => {
                let kind = if matches!(event, RdpOutputEvent::PointerDefault) {
                    "default"
                } else {
                    "hidden"
                };
                let header = json!({"type":"cursor","kind":kind});
                display.lock().unwrap().cursor = Some((header.clone(), Vec::new()));
                emit(&output, header).await;
            }
            RdpOutputEvent::ConnectionFailure(error) => {
                emit(
                    &output,
                    json!({"type":"state","state":"failed","code":connection_error_code(&error)}),
                )
                .await;
                break;
            }
            RdpOutputEvent::Terminated(result) => {
                emit(&output,json!({"type":"state","state":if result.is_ok(){"disconnected"}else{"failed"},"code":if result.is_ok(){"remote-disconnect"}else{"session-failed"}})).await;
                break;
            }
            RdpOutputEvent::DisplayResizeFallback(_) => {
                display.lock().unwrap().request_snapshot();
                emit(&output, json!({"type":"resizeFallback"})).await;
            }
            RdpOutputEvent::AutoReconnecting { response, .. } => {
                let _ = response.send(ironrdp_client::rdp::AutoReconnectDecision::Stop);
            }
            _ => {}
        }
        if stopped.load(Ordering::Acquire) {
            break;
        }
    }
    active.store(false, Ordering::Release);
    ended.store(true, Ordering::Release);
}

async fn present(
    display: SharedDisplay,
    credits: Arc<Mutex<Credits>>,
    notify: Arc<Notify>,
    output: Output,
    stopped: Arc<AtomicBool>,
) {
    let mut timer = tokio::time::interval(Duration::from_millis(16));
    while !stopped.load(Ordering::Acquire) {
        timer.tick().await;
        let (batch, serial) = {
            let mut display = display.lock().unwrap();
            (display.take_batch(), display.snapshot_serial)
        };
        let Some(mut batch) = batch else {
            continue;
        };
        while let Some(mut packet) = batch.next_packet(0) {
            loop {
                if stopped.load(Ordering::Acquire) {
                    return;
                }
                if display.lock().unwrap().snapshot_serial != serial {
                    break;
                }
                let seq = credits.lock().unwrap().reserve(packet.payload.len());
                if let Some(seq) = seq {
                    packet.header["seq"] = json!(seq);
                    if !send_packet(&output, packet).await {
                        stopped.store(true, Ordering::Release);
                        return;
                    }
                    break;
                }
                tokio::select! {_=notify.notified()=>{},_=tokio::time::sleep(Duration::from_millis(100))=>{}}
            }
            if display.lock().unwrap().snapshot_serial != serial {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_connector::{ClientConnector, Sequence};
    use ironrdp_core::{WriteBuf, decode, encode_vec};
    use ironrdp_pdu::nego::{
        ConnectionConfirm, ConnectionRequest, FailureCode, ResponseFlags, SecurityProtocol,
    };
    use ironrdp_pdu::x224::X224;

    fn sign_in_builder(mode: SignInMode) -> ConfigBuilder {
        let (username, password) = if mode == SignInMode::Nla {
            ("operator", "test-password")
        } else {
            ("", "")
        };
        with_sign_in_security(ConfigBuilder::new(), mode)
            .with_destination(Destination::new("host.example:3389").unwrap())
            .with_username(username)
            .with_password(password)
            .with_client_build(1)
            .with_client_name("Sliver GUI")
            .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
            .with_platform(MajorPlatformType::UNSPECIFIED)
    }

    fn sign_in_config(mode: SignInMode) -> ironrdp_client::config::Config {
        sign_in_builder(mode).build().unwrap()
    }

    #[test]
    fn tcp_dial_override_preserves_destination_and_certificate_policy() {
        for mode in [SignInMode::Nla, SignInMode::RemoteScreen] {
            let address = "127.0.0.1:40000".parse().unwrap();
            let config = sign_in_builder(mode)
                .with_tcp_connect_address(address)
                .build()
                .unwrap();
            assert_eq!(config.tcp_connect_address(), Some(address));
            assert_eq!(config.destination().name(), "host.example");
            assert_eq!(config.destination().port(), 3389);
            assert!(matches!(
                config.certificate_validation(),
                CertificateValidation::Strict
            ));
            assert_eq!(config.connector().enable_credssp, mode == SignInMode::Nla);
        }
        assert_eq!(sign_in_config(SignInMode::Nla).tcp_connect_address(), None);
    }

    #[tokio::test]
    async fn tcp_dial_override_failure_never_retries_the_logical_destination() {
        let original = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        original.set_nonblocking(true).unwrap();
        let unavailable = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = unavailable.local_addr().unwrap();
        drop(unavailable);
        let config = sign_in_builder(SignInMode::Nla)
            .with_destination(Destination::from_parts(
                "127.0.0.1",
                original.local_addr().unwrap().port(),
            ))
            .with_tcp_connect_address(address)
            .build()
            .unwrap();
        let (events, mut receiver) = output_channel(4);
        tokio::time::timeout(Duration::from_secs(3), RdpClient::new(config, events).run())
            .await
            .unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(RdpOutputEvent::ConnectionFailure(_))
        ));
        assert_eq!(
            original.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    fn begin_negotiation(mode: SignInMode) -> (ClientConnector, ConnectionRequest) {
        let config = sign_in_config(mode);
        let mut connector = ClientConnector::new(
            config.connector().clone(),
            "127.0.0.1:40000".parse().unwrap(),
        );
        let mut output = WriteBuf::new();
        connector.step_no_input(&mut output).unwrap();
        let request = decode::<X224<ConnectionRequest>>(output.filled())
            .unwrap()
            .0;
        (connector, request)
    }

    fn confirm_protocol(
        connector: &mut ClientConnector,
        protocol: SecurityProtocol,
    ) -> ironrdp_connector::ConnectorResult<ironrdp_connector::Written> {
        let response = encode_vec(&X224(ConnectionConfirm::Response {
            flags: ResponseFlags::empty(),
            protocol,
        }))
        .unwrap();
        connector.step(&response, None, &mut WriteBuf::new())
    }

    #[test]
    fn sign_in_configuration_preserves_tls_validation_and_disables_autologon() {
        for mode in [SignInMode::Nla, SignInMode::RemoteScreen] {
            let config = sign_in_config(mode);
            assert!(matches!(
                config.certificate_validation(),
                CertificateValidation::Strict
            ));
            let connector = config.connector();
            assert!(!connector.enable_standard_rdp_security);
            assert!(!connector.autologon);
            assert_eq!(connector.enable_tls, mode == SignInMode::RemoteScreen);
            assert_eq!(connector.enable_credssp, mode == SignInMode::Nla);
            if mode == SignInMode::RemoteScreen {
                assert!(
                    matches!(&connector.credentials, ironrdp_connector::Credentials::UsernamePassword { username, password } if username.is_empty() && password.is_empty())
                );
                assert!(
                    connector
                        .domain
                        .as_ref()
                        .is_none_or(|domain| domain.is_empty())
                );
            }
        }
    }

    #[test]
    fn negotiation_advertises_exact_mode_and_only_nla_enters_credssp() {
        for (mode, advertised, selected) in [
            (
                SignInMode::Nla,
                SecurityProtocol::HYBRID | SecurityProtocol::HYBRID_EX,
                SecurityProtocol::HYBRID_EX,
            ),
            (
                SignInMode::RemoteScreen,
                SecurityProtocol::SSL,
                SecurityProtocol::SSL,
            ),
        ] {
            let (mut connector, request) = begin_negotiation(mode);
            assert_eq!(request.protocol, advertised);
            confirm_protocol(&mut connector, selected).unwrap();
            assert!(connector.should_perform_security_upgrade());
            connector.mark_security_upgrade_as_done();
            assert_eq!(connector.should_perform_credssp(), mode == SignInMode::Nla);
        }
    }

    #[test]
    fn negotiation_rejects_server_switching_sign_in_mode_or_unencrypted_rdp() {
        for (mode, selected) in [
            (SignInMode::Nla, SecurityProtocol::SSL),
            (SignInMode::RemoteScreen, SecurityProtocol::HYBRID),
            (SignInMode::RemoteScreen, SecurityProtocol::HYBRID_EX),
            (SignInMode::Nla, SecurityProtocol::empty()),
            (SignInMode::RemoteScreen, SecurityProtocol::empty()),
        ] {
            let (mut connector, _) = begin_negotiation(mode);
            assert!(confirm_protocol(&mut connector, selected).is_err());
            assert!(!connector.should_perform_security_upgrade());
            assert!(!connector.should_perform_credssp());
        }
    }

    #[test]
    fn nla_required_server_failure_has_an_explicit_error_code() {
        for (code, expected) in [
            (FailureCode::HYBRID_REQUIRED_BY_SERVER, "nla-required"),
            (
                FailureCode::SSL_NOT_ALLOWED_BY_SERVER,
                "security-negotiation-failed",
            ),
            (
                FailureCode::SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER,
                "security-negotiation-failed",
            ),
        ] {
            let (mut connector, _) = begin_negotiation(SignInMode::RemoteScreen);
            let response = encode_vec(&X224(ConnectionConfirm::Failure { code })).unwrap();
            let error = connector
                .step(&response, None, &mut WriteBuf::new())
                .unwrap_err();
            assert_eq!(connection_error_code(&error), expected);
        }
    }

    #[test]
    fn endpoint_validation_rejects_url_and_injection_syntax() {
        assert!(valid_endpoint("::1", 3389));
        assert!(valid_endpoint("host.example", 3389));
        assert!(!valid_endpoint("https://host", 3389));
        assert!(!valid_endpoint("host\n", 3389));
        assert!(!valid_endpoint("host", 0));
    }
    #[test]
    fn valid_changed_pin_requires_explicit_decision() {
        let pending = Arc::new(Mutex::new(None));
        let (output, mut receiver) = mpsc::channel(4);
        let stop = Arc::new(AtomicBool::new(false));
        let callback = certificate_policy(Some("a".repeat(64)), pending.clone(), output, stop);
        let join = std::thread::spawn(move || {
            callback(b"certificate", "host:3389", PeerCertificateStatus::Valid)
        });
        let request = receiver.blocking_recv().unwrap();
        assert_eq!(request.header["validationKind"], "pinMismatch");
        pending
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .1
            .send(false)
            .unwrap();
        assert!(!join.join().unwrap());
    }
    #[test]
    fn hard_failure_cannot_be_accepted_by_a_matching_pin() {
        let (output, mut receiver) = mpsc::channel(4);
        let callback = certificate_policy(
            Some(format!("{:x}", Sha256::digest(b"certificate"))),
            Arc::new(Mutex::new(None)),
            output,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(!callback(
            b"certificate",
            "host:3389",
            PeerCertificateStatus::HardFailure
        ));
        assert_eq!(
            receiver.blocking_recv().unwrap().header["canOverride"],
            false
        );
    }
}
