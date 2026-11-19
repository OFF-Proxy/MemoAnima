//! V229 (M-4・要件 docs/REQ_mobile_m4_io.md §3-7・§3-8): **zip の取り込みと、全部書き出す**。依存を足さない（読む側の deflate は
//! 今の木にある flate2・CRC-32 はここで書く）。
//!
//! ★取り込み（[`import_zip`]）: 中央の目録を全部読んで、先に全部を確かめてから写す（断るものが 1 つでもあれば何も入れない）。
//!  断る: `../`・絶対パス・ドライブ名・`\`・リンクの印・暗号化・1 件が門番（512MiB）を超える・中身の合計が空き容量を超える・
//!  件数が 100,000 を超える・圧縮の比が極端（展開の大きさを先に足して門番と空き容量で断る・展開が申告を超えたら止める）。
//!  入れ子の zip（中の zip）は開かずに飛ばす。作品・.kwz・.ppm でないものは読まずに飛ばす（数を返す）。
//!  アルバム: 一番上のフォルダの名前（無ければ作る）・一番上に直に置かれたものは選んでいるアルバム・2 段より深いものは一番上のフォルダのアルバム。
//!  名前: UTF-8 の印があれば UTF-8・無ければ UTF-8 として読めるならそのまま・読めなければ「取り込んだ作品」＋番号（画面が渡す fallback）。
//!  途中で失敗したら、そのzip から写した分と作ったアルバムを全部戻す（全部入るか何も入らない）。ZIP64 を読む。
//! ★全部書き出す（[`export_all`]）: アルバムのフォルダと作品（.memoanima・.animemo・.kwz・.ppm）だけ。圧縮しない・名前は UTF-8 の印つき・NFC・
//!  65,535 件以上か 4GiB を超えるときは ZIP64。一覧は始める前に固め、各ファイルは開いたときの中身で入れる（読めない・消えたものは飛ばして数える）。
//!  始める前に空き容量（合計＋1 割か 64MiB の大きい方）を見る。やめたら書きかけを消す。
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::iotmp::{self as mio, place_file, sniff_reader, unplace, ImportOutcome, IoDirs, WORK_MAX};
use super::names::{self, nfc};
use super::{code, io_refusal, locate_album, log_line, Dirs, Refusal};
use crate::pclib::{PROJECT_EXT, PROJECT_EXT_LEGACY};

/// zip の件数の上限（取り込み）
pub const ZIP_MAX_ENTRIES: u64 = 100_000;
/// 断りの値（contract.json の refusals に足した）
pub const ZIP_UNSAFE: &str = code::ZIP_UNSAFE;
pub const ZIP_BROKEN: &str = code::ZIP_BROKEN;

// ---------------- CRC-32 ----------------

static CRC_TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
fn crc_table() -> &'static [u32; 256] {
    CRC_TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, v) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *v = c;
        }
        t
    })
}
/// CRC-32 を続きから（最初は 0）
pub fn crc32_update(crc: u32, b: &[u8]) -> u32 {
    let t = crc_table();
    let mut c = !crc;
    for &x in b {
        c = t[((c ^ x as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

// ---------------- 読む ----------------

/// 目録の 1 件
#[derive(Clone, Debug)]
pub struct Entry {
    pub raw_name: Vec<u8>,
    pub utf8_flag: bool,
    pub flags: u16,
    pub method: u16,
    pub crc: u32,
    pub csize: u64,
    pub usize: u64,
    pub local_off: u64,
    pub ext_attr: u32,
    pub made_by: u16,
}

fn rd16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn rd64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7]])
}
fn broken() -> Refusal {
    Refusal(ZIP_BROKEN)
}

/// ★中央の目録を読む（ZIP64 の終わりの記録と、各件の ZIP64 の追加欄も）。件数が上限を超えたら zip-unsafe
pub fn read_directory<R: Read + Seek>(f: &mut R) -> Result<Vec<Entry>, Refusal> {
    let size = f.seek(SeekFrom::End(0)).map_err(|e| io_refusal(&e))?;
    let back = std::cmp::min(size, 22 + 65535);
    f.seek(SeekFrom::Start(size - back)).map_err(|e| io_refusal(&e))?;
    let mut tail = vec![0u8; back as usize];
    f.read_exact(&mut tail).map_err(|e| io_refusal(&e))?;
    let eocd = (0..tail.len().saturating_sub(21)).rev().find(|&i| &tail[i..i + 4] == b"PK\x05\x06").ok_or_else(broken)?;
    let mut count = rd16(&tail, eocd + 10) as u64;
    let mut cd_size = rd32(&tail, eocd + 12) as u64;
    let mut cd_off = rd32(&tail, eocd + 16) as u64;
    let eocd_abs = size - back + eocd as u64;
    // ZIP64 の終わりの記録の在りか
    if eocd_abs >= 20 {
        let mut loc = [0u8; 20];
        f.seek(SeekFrom::Start(eocd_abs - 20)).map_err(|e| io_refusal(&e))?;
        f.read_exact(&mut loc).map_err(|e| io_refusal(&e))?;
        if &loc[..4] == b"PK\x06\x07" {
            let z64 = rd64(&loc, 8);
            let mut rec = [0u8; 56];
            f.seek(SeekFrom::Start(z64)).map_err(|e| io_refusal(&e))?;
            f.read_exact(&mut rec).map_err(|_| broken())?;
            if &rec[..4] != b"PK\x06\x06" {
                return Err(broken());
            }
            count = rd64(&rec, 32);
            cd_size = rd64(&rec, 40);
            cd_off = rd64(&rec, 48);
        }
    }
    if count > ZIP_MAX_ENTRIES {
        return Err(Refusal(ZIP_UNSAFE));
    }
    if cd_off.checked_add(cd_size).map(|e| e > size).unwrap_or(true) || cd_size > 256 * 1024 * 1024 {
        return Err(broken());
    }
    f.seek(SeekFrom::Start(cd_off)).map_err(|e| io_refusal(&e))?;
    let mut cd = vec![0u8; cd_size as usize];
    f.read_exact(&mut cd).map_err(|_| broken())?;
    let mut out = Vec::with_capacity(count as usize);
    let mut o = 0usize;
    for _ in 0..count {
        if o + 46 > cd.len() || &cd[o..o + 4] != b"PK\x01\x02" {
            return Err(broken());
        }
        let made_by = rd16(&cd, o + 4);
        let flags = rd16(&cd, o + 8);
        let method = rd16(&cd, o + 10);
        let crc = rd32(&cd, o + 16);
        let mut csize = rd32(&cd, o + 20) as u64;
        let mut usize_ = rd32(&cd, o + 24) as u64;
        let nl = rd16(&cd, o + 28) as usize;
        let xl = rd16(&cd, o + 30) as usize;
        let cl = rd16(&cd, o + 32) as usize;
        let ext_attr = rd32(&cd, o + 38);
        let mut local_off = rd32(&cd, o + 42) as u64;
        if o + 46 + nl + xl + cl > cd.len() {
            return Err(broken());
        }
        let raw_name = cd[o + 46..o + 46 + nl].to_vec();
        // ZIP64 の追加欄（0x0001）: 0xFFFFFFFF の欄だけが、その順に入っている
        let mut x = o + 46 + nl;
        let xe = x + xl;
        while x + 4 <= xe {
            let id = rd16(&cd, x);
            let len = rd16(&cd, x + 2) as usize;
            if x + 4 + len > xe {
                return Err(broken());
            }
            if id == 0x0001 {
                let mut p = x + 4;
                let pe = p + len;
                let mut take = |v: &mut u64| -> Result<(), Refusal> {
                    if *v == 0xFFFF_FFFF {
                        if p + 8 > pe {
                            return Err(broken());
                        }
                        *v = rd64(&cd, p);
                        p += 8;
                    }
                    Ok(())
                };
                take(&mut usize_)?;
                take(&mut csize)?;
                take(&mut local_off)?;
            }
            x += 4 + len;
        }
        out.push(Entry { raw_name, utf8_flag: flags & 0x0800 != 0, flags, method, crc, csize, usize: usize_, local_off, ext_attr, made_by });
        o += 46 + nl + xl + cl;
    }
    Ok(out)
}

/// 名前の字（UTF-8 の印 → UTF-8・無ければ UTF-8 として読めるなら・読めなければ None）
pub fn entry_name(e: &Entry) -> Option<String> {
    String::from_utf8(e.raw_name.clone()).ok()
}

/// ★危ない名前・リンク・暗号化（どれか 1 つでもあれば zip ごと断る）
pub fn unsafe_reason(e: &Entry) -> Option<&'static str> {
    if e.flags & 0x0001 != 0 || e.flags & 0x0040 != 0 {
        return Some("encrypted");
    }
    // Unix で作った zip の上位 16 ビットはファイルの種類（0o120000 はリンク）
    if (e.made_by >> 8) == 3 && ((e.ext_attr >> 16) & 0o170000) == 0o120000 {
        return Some("link");
    }
    let raw = &e.raw_name;
    if raw.contains(&b'\\') || raw.contains(&0u8) {
        return Some("backslash");
    }
    if raw.first() == Some(&b'/') {
        return Some("absolute");
    }
    if raw.len() >= 2 && raw[1] == b':' {
        return Some("drive");
    }
    if raw.split(|&b| b == b'/').any(|c| c == b".." || c == b".") {
        return Some("dotdot");
    }
    if e.method != 0 && e.method != 8 {
        return Some("method");
    }
    None
}

/// 中身を読む道（無圧縮か deflate）。申告の大きさを超えたら止める（爆弾）
fn entry_reader<'a, R: Read + Seek>(f: &'a mut R, e: &Entry) -> Result<Box<dyn Read + 'a>, Refusal> {
    let mut lh = [0u8; 30];
    f.seek(SeekFrom::Start(e.local_off)).map_err(|e| io_refusal(&e))?;
    f.read_exact(&mut lh).map_err(|_| broken())?;
    if &lh[..4] != b"PK\x03\x04" {
        return Err(broken());
    }
    let skip = rd16(&lh, 26) as u64 + rd16(&lh, 28) as u64;
    f.seek(SeekFrom::Start(e.local_off + 30 + skip)).map_err(|e| io_refusal(&e))?;
    let lim = f.take(e.csize);
    Ok(match e.method {
        0 => Box::new(lim),
        8 => Box::new(flate2::read::DeflateDecoder::new(lim)),
        _ => return Err(Refusal(ZIP_UNSAFE)),
    })
}

/// 1 件を一時のファイルへ展開（CRC と大きさを確かめる）
fn extract_to<R: Read + Seek>(f: &mut R, e: &Entry, to: &Path) -> Result<(), Refusal> {
    let mut r = entry_reader(f, e)?;
    let mut w = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(to).map_err(|e| io_refusal(&e))?);
    let mut crc = 0u32;
    let mut n = 0u64;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let k = r.read(&mut buf).map_err(|_| broken())?;
        if k == 0 {
            break;
        }
        n += k as u64;
        if n > e.usize || n > WORK_MAX {
            return Err(Refusal(ZIP_UNSAFE));
        }
        crc = crc32_update(crc, &buf[..k]);
        w.write_all(&buf[..k]).map_err(|e| io_refusal(&e))?;
    }
    w.flush().map_err(|e| io_refusal(&e))?;
    if n != e.usize || crc != e.crc {
        return Err(broken());
    }
    Ok(())
}

/// アルバムの名前（一番上のフォルダ）・置き場の中の名前（最後の部分）。フォルダの件（`/` で終わる）は None
fn split_entry(name: &str) -> Option<(Option<String>, String)> {
    if name.ends_with('/') {
        return None;
    }
    let parts: Vec<&str> = name.split('/').filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 => None,
        1 => Some((None, parts[0].to_string())),
        _ => Some((Some(parts[0].to_string()), parts[parts.len() - 1].to_string())),
    }
}

/// ★zip を取り込む（全部か何も入れない）。`work_dir` は一時の展開の置き場（名札のフォルダ）
pub fn import_zip(d: &Dirs, zip: &Path, album: &str, fallback: &str, work_dir: &Path) -> Result<ImportOutcome, Refusal> {
    import_zip_with(d, zip, album, fallback, work_dir, None)
}

/// 試しの口つき: `fail_after` 件を写したあとに失敗させる（全部戻ることを見る）
pub fn import_zip_with(d: &Dirs, zip: &Path, album: &str, fallback: &str, work_dir: &Path, fail_after: Option<usize>) -> Result<ImportOutcome, Refusal> {
    let mut f = File::open(zip).map_err(|e| io_refusal(&e))?;
    let entries = read_directory(&mut f)?;
    // 1) 先に全部を確かめる
    let mut total: u64 = 0;
    let mut biggest: u64 = 0;
    for e in &entries {
        if let Some(r) = unsafe_reason(e) {
            log_line(d, &format!("[io] zip refused reason={r}"));
            return Err(Refusal(ZIP_UNSAFE));
        }
        if e.usize > WORK_MAX {
            return Err(Refusal(ZIP_UNSAFE));
        }
        total = total.saturating_add(e.usize);
        biggest = biggest.max(e.usize);
    }
    // ★V229（独立レビューの指摘・直す）: 展開は 1 件ずつ一時の場所に置いてからライブラリへ写す＝同じボリュームなら、いちばん大きい件の分も
    //  同時に要る。一時の場所の側の空きも見る（別のボリュームのとき）
    mio::need_space(&d.lib, total.saturating_add(biggest))?;
    mio::need_space(work_dir, biggest)?;
    // 2) 作品・.kwz・.ppm を見分けながら写す。失敗したら全部戻す
    let tmp_dir = work_dir.join("x");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| io_refusal(&e))?;
    let mut out = ImportOutcome::default();
    let mut unnamed = 0u32;
    // ★.kwz・.ppm の索引の行は最後にまとめて 1 回で書く（件数ぶん索引を書き直さない）
    let mut notes: Vec<crate::pclib::LibraryItem> = Vec::new();
    // ★アルバムごとの使われている名前（1 件ごとにフォルダを読み直さない）
    let mut caches: std::collections::HashMap<PathBuf, mio::NameCache> = std::collections::HashMap::new();
    let res = (|| -> Result<(), Refusal> {
        for (i, e) in entries.iter().enumerate() {
            let Some(name) = entry_name(e).or_else(|| {
                unnamed += 1;
                Some(format!("{fallback} {unnamed}"))
            }) else {
                continue;
            };
            let Some((top, leaf)) = split_entry(&name) else { continue };
            let leaf_lower = leaf.to_ascii_lowercase();
            // 入れ子の zip は開かない（飛ばす）
            if leaf_lower.ends_with(".zip") {
                out.skipped += 1;
                continue;
            }
            let t = tmp_dir.join(format!("{i}"));
            extract_to(&mut f, e, &t)?;
            let size = e.usize;
            let kind = {
                let mut g = File::open(&t).map_err(|e| io_refusal(&e))?;
                sniff_reader(&mut g, size)
            };
            if !(kind.is_work() || kind.is_note()) {
                let _ = fs::remove_file(&t);
                out.skipped += 1;
                continue;
            }
            // アルバム: 一番上のフォルダ（無ければ作る）・直に置かれたものは選んでいるアルバム
            let (album_real, dir) = match &top {
                None => locate_album(d, album)?,
                Some(a) => match album_for(d, a, &mut out.albums_created) {
                    Ok(x) => x,
                    Err(r) => return Err(r),
                },
            };
            let display = if entry_name(e).is_some() { leaf.clone() } else { String::new() };
            if !caches.contains_key(&dir) {
                let c = mio::NameCache::load(&dir).map_err(|e| io_refusal(&e))?;
                caches.insert(dir.clone(), c);
            }
            let placed = place_file(d, &dir, &album_real, &t, kind, &display, &format!("{fallback} {}", out.placed.len() + 1), Some(&mut notes), caches.get_mut(&dir))?;
            out.placed.push(placed);
            let _ = fs::remove_file(&t);
            if fail_after.is_some_and(|n| out.placed.len() >= n) {
                return Err(Refusal(code::IO));
            }
        }
        if !notes.is_empty() {
            let _guard = crate::pclib::lock_lib();
            let mut index = crate::pclib::load_index(&d.lib).map_err(|_| Refusal(code::IO))?;
            index.items.extend(notes.drain(..));
            crate::pclib::save_index(&d.lib, &index).map_err(|_| Refusal(code::IO))?;
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp_dir);
    if let Err(r) = res {
        let left = unplace(d, &out.placed);
        if left > 0 {
            log_line(d, &format!("[io] zip rollback left={left}"));
        }
        for a in out.albums_created.iter().rev() {
            if let Ok((_, dir)) = locate_album(d, a) {
                let _ = fs::remove_dir(&dir);
            }
        }
        log_line(d, &format!("[io] zip import rolled back placed={}", out.placed.len()));
        return Err(r);
    }
    Ok(out)
}

/// zip の一番上のフォルダのアルバム（在ればそれ・無ければ作る＝作ったものを覚える）
fn album_for(d: &Dirs, raw: &str, created: &mut Vec<String>) -> Result<(String, PathBuf), Refusal> {
    let a = names::new_album_name(raw)?;
    if let Some(real) = names::resolve_album(&d.lib, &a).map_err(|e| io_refusal(&e))? {
        return locate_album(d, &real);
    }
    let made = super::ops::create_album(d, &a)?;
    created.push(made.album.clone());
    locate_album(d, &made.album)
}

// ---------------- 書く（全部書き出す） ----------------

/// 1 件の書き手の記録（中央の目録へ）
struct Written {
    name: Vec<u8>,
    crc: u32,
    size: u64,
    off: u64,
    dir: bool,
    dos: (u16, u16),
}

/// UNIX 秒 → DOS の日付と時刻（1980〜2107。範囲の外は 1980-01-01）
pub fn dos_time(secs: u64) -> (u16, u16) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // 日付（Howard Hinnant の civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mm <= 2 { y + 1 } else { y };
    if !(1980..=2107).contains(&y) {
        return (0, (1 << 5) | 1);
    }
    let time = ((rem / 3600) << 11 | ((rem % 3600) / 60) << 5 | ((rem % 60) / 2)) as u16;
    let date = (((y - 1980) as u16) << 9) | ((mm as u16) << 5) | dd as u16;
    (time, date)
}

/// ★zip の書き手（圧縮しない・UTF-8 の印・必要なら ZIP64）。位置を書き戻すので、出力は Seek できるファイル
pub struct ZipWriter<W: Write + Seek> {
    w: W,
    pos: u64,
    items: Vec<Written>,
}

impl<W: Write + Seek> ZipWriter<W> {
    pub fn new(w: W) -> Self {
        ZipWriter { w, pos: 0, items: Vec::new() }
    }
    fn put(&mut self, b: &[u8]) -> io::Result<()> {
        self.w.write_all(b)?;
        self.pos += b.len() as u64;
        Ok(())
    }
    /// フォルダの件（名前は `/` で終わる）
    pub fn add_dir(&mut self, name: &str, mtime: u64) -> io::Result<()> {
        let n = format!("{}/", nfc(name.trim_end_matches('/'))).into_bytes();
        let off = self.pos;
        let dos = dos_time(mtime);
        self.local_header(&n, 0, 0, dos, false)?;
        self.items.push(Written { name: n, crc: 0, size: 0, off, dir: true, dos });
        Ok(())
    }
    fn local_header(&mut self, n: &[u8], crc: u32, size: u64, dos: (u16, u16), z64: bool) -> io::Result<()> {
        let mut h = Vec::with_capacity(30 + n.len() + 20);
        h.extend_from_slice(b"PK\x03\x04");
        h.extend_from_slice(&(if z64 { 45u16 } else { 20u16 }).to_le_bytes());
        h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 の印
        h.extend_from_slice(&0u16.to_le_bytes()); // 圧縮しない
        h.extend_from_slice(&dos.0.to_le_bytes());
        h.extend_from_slice(&dos.1.to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        let s32 = if z64 { 0xFFFF_FFFFu32 } else { size as u32 };
        h.extend_from_slice(&s32.to_le_bytes());
        h.extend_from_slice(&s32.to_le_bytes());
        h.extend_from_slice(&(n.len() as u16).to_le_bytes());
        h.extend_from_slice(&(if z64 { 20u16 } else { 0 }).to_le_bytes());
        h.extend_from_slice(n);
        if z64 {
            h.extend_from_slice(&1u16.to_le_bytes());
            h.extend_from_slice(&16u16.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
        }
        self.put(&h)
    }
    /// ファイルの件。`src` を最後まで写す（開いたときの中身）。`expect` は始める前に見た大きさ（4GiB に近ければ ZIP64 の欄を先に取っておく）。
    /// やめる印が立ったら Interrupted
    pub fn add_file<R: Read>(&mut self, name: &str, src: &mut R, expect: u64, mtime: u64, cancel: &AtomicBool, progress: &AtomicU64) -> io::Result<u64> {
        let n = nfc(name).into_bytes();
        let off = self.pos;
        let dos = dos_time(mtime);
        let z64 = expect >= 0xFFFF_0000;
        self.local_header(&n, 0, 0, dos, z64)?;
        let mut crc = 0u32;
        let mut size = 0u64;
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
            }
            let k = src.read(&mut buf)?;
            if k == 0 {
                break;
            }
            crc = crc32_update(crc, &buf[..k]);
            self.put(&buf[..k])?;
            size += k as u64;
            progress.fetch_add(k as u64, Ordering::Relaxed);
        }
        if size >= 0xFFFF_FFFF && !z64 {
            return Err(io::Error::other("grew past 4GiB"));
        }
        // 頭を書き戻す（CRC・大きさ）
        let end = self.pos;
        self.w.seek(SeekFrom::Start(off + 14))?;
        self.w.write_all(&crc.to_le_bytes())?;
        if z64 {
            self.w.seek(SeekFrom::Start(off + 30 + n.len() as u64 + 4))?;
            self.w.write_all(&size.to_le_bytes())?;
            self.w.write_all(&size.to_le_bytes())?;
        } else {
            self.w.write_all(&(size as u32).to_le_bytes())?;
            self.w.write_all(&(size as u32).to_le_bytes())?;
        }
        self.w.seek(SeekFrom::Start(end))?;
        self.items.push(Written { name: n, crc, size, off, dir: false, dos });
        Ok(size)
    }
    /// 中央の目録と終わりの記録を書く（件数・大きさ・位置が 32 ビットを超えれば ZIP64）
    pub fn finish(mut self) -> io::Result<W> {
        let cd_off = self.pos;
        let items = std::mem::take(&mut self.items);
        for it in &items {
            let big_size = it.size >= 0xFFFF_FFFF;
            let big_off = it.off >= 0xFFFF_FFFF;
            let mut x = Vec::new();
            if big_size || big_off {
                let mut body = Vec::new();
                if big_size {
                    body.extend_from_slice(&it.size.to_le_bytes());
                    body.extend_from_slice(&it.size.to_le_bytes());
                }
                if big_off {
                    body.extend_from_slice(&it.off.to_le_bytes());
                }
                x.extend_from_slice(&1u16.to_le_bytes());
                x.extend_from_slice(&(body.len() as u16).to_le_bytes());
                x.extend_from_slice(&body);
            }
            let mut h = Vec::with_capacity(46 + it.name.len() + x.len());
            h.extend_from_slice(b"PK\x01\x02");
            h.extend_from_slice(&((3u16 << 8) | 45).to_le_bytes()); // Unix で作った・2.0 以上（ZIP64 は 4.5）
            h.extend_from_slice(&(if big_size || big_off { 45u16 } else { 20u16 }).to_le_bytes());
            h.extend_from_slice(&0x0800u16.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&it.dos.0.to_le_bytes());
            h.extend_from_slice(&it.dos.1.to_le_bytes());
            h.extend_from_slice(&it.crc.to_le_bytes());
            let s32 = if big_size { 0xFFFF_FFFFu32 } else { it.size as u32 };
            h.extend_from_slice(&s32.to_le_bytes());
            h.extend_from_slice(&s32.to_le_bytes());
            h.extend_from_slice(&(it.name.len() as u16).to_le_bytes());
            h.extend_from_slice(&(x.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // 注記
            h.extend_from_slice(&0u16.to_le_bytes()); // 円盤の番号
            h.extend_from_slice(&0u16.to_le_bytes()); // 内部の属性
            let mode: u32 = if it.dir { 0o040755 } else { 0o100644 };
            h.extend_from_slice(&((mode << 16) | if it.dir { 0x10 } else { 0 }).to_le_bytes());
            h.extend_from_slice(&(if big_off { 0xFFFF_FFFFu32 } else { it.off as u32 }).to_le_bytes());
            h.extend_from_slice(&it.name);
            h.extend_from_slice(&x);
            self.put(&h)?;
        }
        let cd_size = self.pos - cd_off;
        let n = items.len() as u64;
        let need64 = n >= 0xFFFF || cd_off >= 0xFFFF_FFFF || cd_size >= 0xFFFF_FFFF;
        if need64 {
            let z64_off = self.pos;
            let mut r = Vec::with_capacity(56 + 20);
            r.extend_from_slice(b"PK\x06\x06");
            r.extend_from_slice(&44u64.to_le_bytes());
            r.extend_from_slice(&((3u16 << 8) | 45).to_le_bytes());
            r.extend_from_slice(&45u16.to_le_bytes());
            r.extend_from_slice(&0u32.to_le_bytes());
            r.extend_from_slice(&0u32.to_le_bytes());
            r.extend_from_slice(&n.to_le_bytes());
            r.extend_from_slice(&n.to_le_bytes());
            r.extend_from_slice(&cd_size.to_le_bytes());
            r.extend_from_slice(&cd_off.to_le_bytes());
            r.extend_from_slice(b"PK\x06\x07");
            r.extend_from_slice(&0u32.to_le_bytes());
            r.extend_from_slice(&z64_off.to_le_bytes());
            r.extend_from_slice(&1u32.to_le_bytes());
            self.put(&r)?;
        }
        let mut e = Vec::with_capacity(22);
        e.extend_from_slice(b"PK\x05\x06");
        e.extend_from_slice(&0u16.to_le_bytes());
        e.extend_from_slice(&0u16.to_le_bytes());
        let n16 = if need64 { 0xFFFF } else { n as u16 };
        e.extend_from_slice(&n16.to_le_bytes());
        e.extend_from_slice(&n16.to_le_bytes());
        e.extend_from_slice(&(if need64 { 0xFFFF_FFFF } else { cd_size as u32 }).to_le_bytes());
        e.extend_from_slice(&(if need64 { 0xFFFF_FFFF } else { cd_off as u32 }).to_le_bytes());
        e.extend_from_slice(&0u16.to_le_bytes());
        self.put(&e)?;
        self.w.flush()?;
        Ok(self.w)
    }
}

/// 全部書き出すの 1 件（一覧は始める前に固める）
#[derive(Clone, Debug)]
pub struct AllItem {
    pub album: String,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: u64,
}

fn is_export_file(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    !l.starts_with('.') && (l.ends_with(&format!(".{PROJECT_EXT}")) || l.ends_with(&format!(".{PROJECT_EXT_LEGACY}")) || l.ends_with(".kwz") || l.ends_with(".ppm"))
}

/// ★書き出す一覧（アルバムのフォルダと作品だけ。索引・サムネ・控え・一時ファイル・リンクは入れない）
pub fn list_all(d: &Dirs) -> Result<(Vec<(String, u64)>, Vec<AllItem>), Refusal> {
    let mut albums = Vec::new();
    let mut items = Vec::new();
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let mut tops: Vec<_> = fs::read_dir(&d.lib).map_err(|e| io_refusal(&e))?.flatten().collect();
    tops.sort_by_key(|e| e.file_name());
    for a in tops {
        let an = a.file_name().to_string_lossy().into_owned();
        let ap = a.path();
        let Ok(m) = fs::symlink_metadata(&ap) else { continue };
        if an.starts_with('.') || !m.is_dir() || m.file_type().is_symlink() {
            continue;
        }
        if !matches!(ap.canonicalize(), Ok(c) if c.starts_with(&lib_c) && c != lib_c) {
            continue;
        }
        let secs = |m: &fs::Metadata| m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        albums.push((an.clone(), secs(&m)));
        let Ok(rd) = fs::read_dir(&ap) else { continue };
        let mut fsv: Vec<_> = rd.flatten().collect();
        fsv.sort_by_key(|e| e.file_name());
        for f in fsv {
            let fname = f.file_name().to_string_lossy().into_owned();
            let fp = f.path();
            let Ok(fm) = fs::symlink_metadata(&fp) else { continue };
            if !fm.is_file() || fm.file_type().is_symlink() || !is_export_file(&fname) {
                continue;
            }
            items.push(AllItem { album: an.clone(), name: fname, path: fp, size: fm.len(), mtime: secs(&fm) });
        }
    }
    Ok((albums, items))
}

/// 全部書き出すの進み具合（types.ExportAllStatus）
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllStatus {
    pub state: String,
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub skipped: u64,
    pub tag: Option<String>,
    pub refusal: Option<String>,
}

/// 動いている全部書き出すの共有の値
#[derive(Default)]
pub struct ExportAllJob {
    pub cancel: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub bytes: AtomicU64,
    pub total_bytes: AtomicU64,
    pub skipped: AtomicU64,
    pub result: std::sync::Mutex<Option<Result<String, Refusal>>>,
}

/// ★全部書き出す（呼ぶ側が別のスレッドで回す）。一時の場所に zip を作り、終えた名札を返す。やめた・失敗したら書きかけを消す
pub fn export_all(d: &Dirs, io: &IoDirs, file_name: &str, job: &Arc<ExportAllJob>) -> Result<String, Refusal> {
    let (albums, items) = list_all(d)?;
    let total_bytes: u64 = items.iter().map(|i| i.size).sum();
    job.total.store(items.len() as u64, Ordering::SeqCst);
    job.total_bytes.store(total_bytes, Ordering::SeqCst);
    // 目録とヘッダの分（1 件 200 バイトの見積り）も足す
    fs::create_dir_all(&io.root).map_err(|e| io_refusal(&e))?;
    mio::need_space(&io.root, total_bytes + items.len() as u64 * 200)?;
    let tag = mio::out_begin(io, "zip")?;
    let res = (|| -> Result<(), Refusal> {
        let part = io.out().join(&tag).join("data.part");
        let f = OpenOptions::new().write(true).truncate(true).open(&part).map_err(|e| io_refusal(&e))?;
        let mut z = ZipWriter::new(BufWriter::with_capacity(1 << 20, f));
        for (a, t) in &albums {
            z.add_dir(a, *t).map_err(|e| io_refusal(&e))?;
        }
        for it in &items {
            if job.cancel.load(Ordering::SeqCst) {
                return Err(Refusal(CANCELLED));
            }
            match File::open(&it.path) {
                Ok(mut src) => match z.add_file(&format!("{}/{}", it.album, it.name), &mut src, it.size, it.mtime, &job.cancel, &job.bytes) {
                    Ok(_) => {}
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(Refusal(CANCELLED)),
                    // 読む途中の失敗は書きかけの件が残るので、全体を止める（書き手の失敗＝空き容量など）
                    Err(e) => return Err(io_refusal(&e)),
                },
                Err(_) => {
                    job.skipped.fetch_add(1, Ordering::SeqCst);
                }
            }
            job.done.fetch_add(1, Ordering::SeqCst);
        }
        let w = z.finish().map_err(|e| io_refusal(&e))?;
        let f = w.into_inner().map_err(|e| io_refusal(e.error()))?;
        f.sync_all().map_err(|e| io_refusal(&e))?;
        Ok(())
    })();
    match res {
        Ok(()) => {
            mio::out_finish(io, &tag, file_name)?;
            log_line(d, &format!("[io] export-all ok items={} skipped={}", items.len(), job.skipped.load(Ordering::SeqCst)));
            Ok(tag)
        }
        Err(r) => {
            let _ = mio::out_abort(io, &tag);
            log_line(d, &format!("[io] export-all stopped reason={}", r.0));
            Err(r)
        }
    }
}

/// やめた（contract.json の refusals に足した値）
pub const CANCELLED: &str = code::CANCELLED;

#[cfg(test)]
pub fn kind_name(k: mio::Kind) -> &'static str {
    match k {
        mio::Kind::WorkPv6 => "workPv6",
        mio::Kind::WorkPv5 => "workPv5",
        mio::Kind::Kwz => "kwz",
        mio::Kind::Ppm => "ppm",
        mio::Kind::Zip => "zip",
        _ => "other",
    }
}

#[cfg(test)]
pub fn placed_names(p: &[mio::Placed]) -> Vec<String> {
    p.iter().map(|x| format!("{}/{}", x.album, x.name)).collect()
}
