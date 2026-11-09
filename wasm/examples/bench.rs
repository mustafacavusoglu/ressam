// cargo run --release --example bench  — native timing of the core on a noisy 585×1024 photo
#[path = "../src/lib.rs"] mod core;
fn main() {
    let (w, h) = (585usize, 1024usize);
    let mut s = 12345u32;
    let photo: Vec<u8> = (0..w * h * 4).map(|i| { s ^= s << 13; s ^= s >> 17; s ^= s << 5; if i % 4 == 3 { 255 } else { ((i / 4 % w) as u32 / 3 + (s & 63)) as u8 } }).collect();
    let cur = vec![240u8; w * h * 4];
    let t = std::time::Instant::now();
    for r in [9.0, 4.5, 2.3, 1.1, 0.9] { unsafe { core::layer(photo.as_ptr(), cur.as_ptr(), w, h, r, 8.0, 38000, 14, 7) }; }
    println!("5 layers: {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let mut o = vec![0u8; w * h * 4];
    unsafe { core::surface(photo.as_ptr(), o.as_mut_ptr(), w, h) };
    println!("surface: {:?}", t.elapsed());
}
