//! Bounded codec experiment only. This is not a renderer session engine or a supported IPC ABI.
use ironrdp_graphics::rdp6::BitmapStreamDecoder;
use std::sync::Mutex;

struct State {
    input: Vec<u8>,
    output: Vec<u8>,
    decoder: Option<BitmapStreamDecoder>,
}

static STATE: Mutex<State> = Mutex::new(State {
    input: Vec::new(),
    output: Vec::new(),
    decoder: None,
});

/// Return a WASM memory offset for exactly `len` input bytes. No pointer enters native Rust.
#[unsafe(no_mangle)]
pub extern "C" fn prepare_input(len: u32) -> *mut u8 {
    if len == 0 || len > 16 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    let mut state = STATE.lock().unwrap();
    state.input.resize(len as usize, 0);
    state.input.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn decode(width: u32, height: u32) -> u32 {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_000_000
    {
        return 0;
    }
    let mut state = STATE.lock().unwrap();
    let State {
        input,
        output,
        decoder,
    } = &mut *state;
    output.clear();
    let decoder = decoder.get_or_insert_with(BitmapStreamDecoder::default);
    if decoder
        .decode_bitmap_stream_to_rgb24(input, output, width as usize, height as usize)
        .is_err()
    {
        output.clear();
        return 0;
    }
    if output.len() != width as usize * height as usize * 3 {
        output.clear();
        return 0;
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    STATE.lock().unwrap().output.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> u32 {
    STATE.lock().unwrap().output.len() as u32
}
