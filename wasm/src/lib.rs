//! Ressam's pixel work: photo → brush strokes (one detail layer per call) and the paint-relief surface.
//! Plain C ABI, no wasm-bindgen: JS copies pixels into memory from `alloc` and reads the results back.
use std::cell::RefCell;
use std::f32::consts::PI;
use std::slice::{from_raw_parts, from_raw_parts_mut};

thread_local!(static OUT: RefCell<Vec<f32>> = RefCell::new(Vec::new()));

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` and `n` must come from one `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    OUT.with(|o| o.borrow().as_ptr())
}

fn box_blur(src: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let mut a = src.to_vec();
    let mut b = vec![0u8; src.len()];
    let div = (2 * r + 1) as f32;
    let ri = r as isize;
    let cl = |k: isize, n: usize| k.clamp(0, n as isize - 1) as usize;
    for _ in 0..2 {
        for y in 0..h {
            let row = y * w * 4;
            for c in 0..3 {
                let mut sum: i32 = (-ri..=ri).map(|k| a[row + cl(k, w) * 4 + c] as i32).sum();
                for x in 0..w {
                    b[row + x * 4 + c] = (sum as f32 / div).round() as u8;
                    let (xo, xi) = (cl(x as isize - ri, w), cl(x as isize + ri + 1, w));
                    sum += a[row + xi * 4 + c] as i32 - a[row + xo * 4 + c] as i32;
                }
            }
        }
        // vertical: running sums for every column, walking down the rows (cache friendly)
        let row = w * 4;
        let mut sum = vec![0i32; row];
        for k in -ri..=ri {
            let yy = cl(k, h) * row;
            sum.iter_mut().zip(&b[yy..yy + row]).for_each(|(s, &v)| *s += v as i32);
        }
        for y in 0..h {
            let (yo, yi) = (cl(y as isize - ri, h) * row, cl(y as isize + ri + 1, h) * row);
            for j in 0..row {
                a[y * row + j] = (sum[j] as f32 / div).round() as u8;
                sum[j] += b[yi + j] as i32 - b[yo + j] as i32;
            }
        }
    }
    a
}

/// One coarse-to-fine layer: blur the photo to brush size, find grid cells that still differ from the
/// canvas (`cur`), and trace a stroke from each along the image's edges.
/// Output (read via `out_ptr`, returned length in f32s): per stroke `[npts, rgb, length, x0, y0, x1, y1, …]`.
///
/// # Safety
/// `refp` and `curp` must point to `w*h*4` RGBA bytes.
#[no_mangle]
pub unsafe extern "C" fn layer(
    refp: *const u8, curp: *const u8, w: usize, h: usize,
    r: f32, thresh: f32, cap: usize, maxs: u32, seed: u32,
) -> usize {
    let n = w * h;
    let cur = from_raw_parts(curp, n * 4);
    let bl = box_blur(from_raw_parts(refp, n * 4), w, h, ((r * 0.5).round() as usize).max(1));
    let px = |i: usize| (bl[i] as f32, bl[i + 1] as f32, bl[i + 2] as f32);
    let lum: Vec<f32> = (0..n).map(|i| { let (r, g, b) = px(i * 4); 0.299 * r + 0.587 * g + 0.114 * b }).collect();

    // cells whose mean error is above the threshold; the stroke starts at the worst pixel
    let grid = ((r * 1.1).round() as usize).max(1);
    let mut cand: Vec<(usize, usize, f32)> = Vec::new();
    for gy in (0..h).step_by(grid) {
        let y1 = (gy + grid).min(h);
        for gx in (0..w).step_by(grid) {
            let x1 = (gx + grid).min(w);
            let (mut sum, mut best, mut bx, mut by) = (0f32, -1f32, gx, gy);
            for y in gy..y1 {
                for x in gx..x1 {
                    let i = (y * w + x) * 4;
                    let (dr, dg, db) = (bl[i] as f32 - cur[i] as f32, bl[i + 1] as f32 - cur[i + 1] as f32, bl[i + 2] as f32 - cur[i + 2] as f32);
                    let e = (dr * dr + dg * dg + db * db).sqrt();
                    sum += e;
                    if e > best { best = e; bx = x; by = y; }
                }
            }
            let mean = sum / ((x1 - gx) * (y1 - gy)) as f32;
            if mean > thresh { cand.push((bx, by, mean)); }
        }
    }
    if cand.len() > cap {
        // keep the `cap` worst cells; their order doesn't matter, they get shuffled next
        cand.select_nth_unstable_by(cap, |a, b| b.2.total_cmp(&a.2));
        cand.truncate(cap);
    }
    let mut rng = seed | 1;
    let mut rnd = move || { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; (rng >> 8) as f32 / 16_777_216.0 };
    for i in (1..cand.len()).rev() {
        let j = ((rnd() * (i + 1) as f32) as usize).min(i);
        cand.swap(i, j);
    }

    // Sobel gradient of the blurred luminance
    let l = |x: usize, y: usize| lum[y * w + x];
    let grad = |x: usize, y: usize| {
        let (x0, x1, y0, y1) = (x.saturating_sub(1), (x + 1).min(w - 1), y.saturating_sub(1), (y + 1).min(h - 1));
        let (a, b, c) = (l(x0, y0), l(x, y0), l(x1, y0));
        let (d, f) = (l(x0, y), l(x1, y));
        let (g, hh, i) = (l(x0, y1), l(x, y1), l(x1, y1));
        ((c + 2.0 * f + i) - (a + 2.0 * d + g), (g + 2.0 * hh + i) - (a + 2.0 * b + c))
    };

    const MINS: u32 = 3;
    let step = (r * 0.9).max(1.0);
    let (wm, hm) = ((w - 1) as f32, (h - 1) as f32);
    let mut out: Vec<f32> = Vec::with_capacity(cand.len() * 16);
    let mut pts: Vec<f32> = Vec::with_capacity(2 * maxs as usize + 2);
    for &(x0, y0, _) in &cand {
        let i0 = (y0 * w + x0) * 4;
        let (cr, cg, cb) = px(i0);
        pts.clear();
        pts.extend([x0 as f32, y0 as f32]);
        let (mut x, mut y, mut lx, mut ly) = (x0 as f32, y0 as f32, 0f32, 0f32);
        let ang = rnd() * 6.2832;
        let (fx, fy) = (ang.cos(), ang.sin());
        for q in 1..=maxs {
            let (xi, yi) = (x.round().clamp(0.0, wm) as usize, y.round().clamp(0.0, hm) as usize);
            let ii = (yi * w + xi) * 4;
            if q > MINS {
                // stop once this colour helps the canvas less than leaving it alone would
                let (br, bg, bb) = px(ii);
                let (a, b, c) = (br - cur[ii] as f32, bg - cur[ii + 1] as f32, bb - cur[ii + 2] as f32);
                let (d, e, f) = (br - cr, bg - cg, bb - cb);
                if a * a + b * b + c * c < d * d + e * e + f * f { break; }
            }
            let (gx, gy) = grad(xi, yi);
            let m = (gx * gx + gy * gy).sqrt();
            let (dx, dy) = if m < 8.0 {
                if lx != 0.0 || ly != 0.0 { (lx, ly) } else { (fx, fy) }
            } else {
                let (dx, dy) = (-gy / m, gx / m);
                if lx * dx + ly * dy < 0.0 { (-dx, -dy) } else { (dx, dy) }
            };
            x += dx * step;
            y += dy * step;
            if x < 0.0 || y < 0.0 || x > wm || y > hm { break; }
            lx = dx;
            ly = dy;
            pts.extend([x, y]);
        }
        let len: f32 = pts.chunks(2).zip(pts.chunks(2).skip(1)).map(|(a, b)| { let (dx, dy) = (b[0] - a[0], b[1] - a[1]); (dx * dx + dy * dy).sqrt() }).sum();
        let rgb = (bl[i0] as u32) << 16 | (bl[i0 + 1] as u32) << 8 | bl[i0 + 2] as u32;
        out.extend([(pts.len() / 2) as f32, rgb as f32, len + 2.0 * r]);
        out.extend_from_slice(&pts);
    }
    let len = out.len();
    OUT.with(|o| *o.borrow_mut() = out);
    len
}

/// Overlay layer (grey 128 = no change): stroke-height relief lit from the upper left + linen weave.
///
/// # Safety
/// `hp` and `op` must point to `w*h*4` RGBA bytes.
#[no_mangle]
pub unsafe extern "C" fn surface(hp: *const u8, op: *mut u8, w: usize, h: usize) {
    let src = from_raw_parts(hp, w * h * 4);
    let o = from_raw_parts_mut(op, w * h * 4);
    let p = ((w as f32 / 300.0).round() as usize).max(3); // weave thread width in px
    let pf = p as f32;
    for y in 0..h {
        let (up, dn, row) = (y.saturating_sub(1) * w, (y + 1).min(h - 1) * w, y * w);
        for x in 0..w {
            let (l, r) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let gx = src[(row + r) * 4] as f32 - src[(row + l) * 4] as f32;
            let gy = src[(dn + x) * 4] as f32 - src[(up + x) * 4] as f32;
            let over = (x / p + y / p) & 1 == 1;
            let t = if over { (x % p) as f32 } else { (y % p) as f32 } / pf;
            let weave = (PI * t).sin() - 0.64;
            let v = (128.0 - (gx + gy) * 0.7 + weave * 26.0).round().clamp(0.0, 255.0) as u8;
            let i = (row + x) * 4;
            o[i..i + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn red_square_gets_red_strokes_and_flat_height_stays_grey() {
        let (w, h) = (64, 64);
        let paper = [246u8, 242, 234, 255];
        let mut photo: Vec<u8> = paper.repeat(w * h);
        for y in 16..48 { for x in 16..48 { photo[(y * w + x) * 4..][..3].copy_from_slice(&[220, 20, 20]); } }
        let cur = paper.repeat(w * h);
        let n = unsafe { layer(photo.as_ptr(), cur.as_ptr(), w, h, 4.0, 16.0, 1000, 10, 7) };
        let out = OUT.with(|o| o.borrow().clone());
        assert_eq!(out.len(), n);
        let (mut k, mut reds) = (0, 0);
        while k < n {
            let (np, rgb) = (out[k] as usize, out[k + 1] as u32);
            if rgb >> 16 > 150 && (rgb >> 8 & 255) < 100 { reds += 1; }
            k += 3 + 2 * np;
        }
        assert_eq!(k, n);
        assert!(reds > 0, "no red strokes");

        let flat = [128u8, 128, 128, 255].repeat(w * h);
        let mut s = vec![0u8; w * h * 4];
        unsafe { surface(flat.as_ptr(), s.as_mut_ptr(), w, h) };
        assert!(s.chunks(4).all(|p| p[0].abs_diff(128) <= 26 && p[3] == 255));
    }
}
