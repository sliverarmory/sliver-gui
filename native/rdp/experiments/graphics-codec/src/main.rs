#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use ironrdp_graphics::rdp6::{BitmapStreamDecoder, BitmapStreamEncoder};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::time::Instant;

    let directory = std::env::args().nth(1).expect("fixture output directory");
    std::fs::create_dir_all(&directory).unwrap();
    let mut cases = Vec::new();
    for (width, height, iterations) in [(1280, 800, 60), (1920, 1080, 60), (3840, 2160, 30)] {
        let mut rgb = Vec::with_capacity(width * height * 3);
        // Deterministic flat desktop, title bars, window borders and repeated glyph-like stripes.
        for y in 0..height {
            for x in 0..width {
                let color = if y < 32 {
                    [25, 31, 46]
                } else if x < 220 {
                    [43, 51, 67]
                } else if x % 480 < 4 || y % 260 < 4 {
                    [92, 106, 131]
                } else if y % 24 < 3 && x % 13 < 8 {
                    [220, 226, 238]
                } else {
                    [245, 246, 248]
                };
                rgb.extend_from_slice(&color);
            }
        }
        let mut encoded = vec![0; rgb.len() * 2 + 1024];
        let mut encoder = BitmapStreamEncoder::new(width, height);
        let length = encoder
            .encode_channels_stream(
                (
                    rgb.chunks_exact(3).map(|p| p[0]),
                    rgb.chunks_exact(3).map(|p| p[1]),
                    rgb.chunks_exact(3).map(|p| p[2]),
                ),
                &mut encoded,
                true,
            )
            .unwrap();
        encoded.truncate(length);
        let mut decoder = BitmapStreamDecoder::default();
        let mut output = Vec::new();
        let mut timings = Vec::new();
        for i in 0..iterations + 10 {
            let start = Instant::now();
            output.clear();
            decoder
                .decode_bitmap_stream_to_rgb24(&encoded, &mut output, width, height)
                .unwrap();
            if i >= 10 {
                timings.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        assert!(
            output == rgb,
            "native roundtrip mismatch: expected {} bytes, got {}, first mismatch {:?}",
            rgb.len(),
            output.len(),
            output.iter().zip(&rgb).position(|(a, b)| a != b)
        );
        timings.sort_by(f64::total_cmp);
        let file = format!("{width}x{height}.rdp6");
        std::fs::write(std::path::Path::new(&directory).join(&file), &encoded).unwrap();
        cases.push(json!({"width":width,"height":height,"iterations":iterations,"file":file,"compressedBytes":length,"decodedBytes":rgb.len(),"sha256":format!("{:x}",Sha256::digest(&output)),"nativeDecodeP50Ms":timings[timings.len()/2],"nativeDecodeP95Ms":timings[timings.len()*95/100]}));
    }
    std::fs::write(
        std::path::Path::new(&directory).join("fixtures.json"),
        serde_json::to_vec_pretty(&cases).unwrap(),
    )
    .unwrap();
}

#[cfg(target_arch = "wasm32")]
fn main() {}
