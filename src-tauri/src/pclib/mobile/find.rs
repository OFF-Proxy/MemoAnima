//! V202 (§4-5・A5 の③): ライブラリの中で、**同じ ID か同じ指紋**の作品を探す（保存先が無いとき・ファイル App で移した・名前を変えた）。
//!
//! - ID は**作品のヘッダだけ**を読む（PV6 のトレーラの headerGzLen から先頭の gzip だけを開く＝pv6.ts 冒頭の器の説明）。
//!   PV5・.animemo は ID では探さず指紋だけ
//! - ID の形の確かめは JS の `WORK_ID_RE`（saveCore.ts）と同じ（小文字だけを正とする。崩れた値＝大文字を含む等は無いものとして扱う）。
//!   作品の ID を作るのは JS の `newWorkId` だけ（Rust は作らない）
//! - 指紋は**大きさが同じ作品だけ**を読む
//! - 読んでいる間は `lock_lib` を持たない（見つけた先へ書くときは、上書きの命令が鍵の中で確かめ直す）

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::fingerprint::Fingerprint;
use super::names;
use super::{code, Dirs, Refusal};
use crate::pclib::PROJECT_EXT;

/// 探す命令の引数（contract.json の mobile_find_works.args）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindArgs {
    pub work_id: Option<String>,
    pub fingerprint: Option<Fingerprint>,
}

/// 見つけた作品（contract.json の types.FoundWork）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundWork {
    pub album: String,
    pub name: String,
    /// ヘッダの ID が同じ
    pub id_match: bool,
    /// 中身の指紋が同じ
    pub fingerprint_match: bool,
}

/// ヘッダの JSON を開く上限（壊れた・細工したファイルで大きく膨らませない）
const HEADER_MAX: u64 = 64 << 20;

/// ★作品の ID の形（JS の WORK_ID_RE `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` と同じ）
pub fn is_work_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    for (i, &c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => (b'1'..=b'8').contains(&c),
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => hex(c),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// ★PV6 の作品のヘッダだけを開いて ID を読む（トレーラ "AMPV6END" + u32LE headerGzLen + u32LE blobSectionLen）。
/// PV6 でない・崩れている・ID の形でなければ None
pub fn header_work_id(p: &Path) -> Option<String> {
    header_work_id_with(p, HEADER_MAX)
}

/// 開く上限を受ける形（検査は小さい上限で「上限を超えるヘッダは読まない」を見る）
pub(super) fn header_work_id_with(p: &Path, max: u64) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    if len < 16 {
        return None;
    }
    let mut tail = [0u8; 16];
    f.seek(SeekFrom::End(-16)).ok()?;
    f.read_exact(&mut tail).ok()?;
    if &tail[..8] != b"AMPV6END" {
        return None;
    }
    let hl = u32::from_le_bytes(tail[8..12].try_into().ok()?) as u64;
    let bl = u32::from_le_bytes(tail[12..16].try_into().ok()?) as u64;
    if hl + bl + 16 != len || hl == 0 || hl > max {
        return None;
    }
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut gz = vec![0u8; hl as usize];
    f.read_exact(&mut gz).ok()?;
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).take(max).read_to_end(&mut json).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&json).ok()?;
    let id = v.get("meta")?.get("workId")?.as_str()?;
    is_work_id(id).then(|| id.to_string())
}

/// ★探す。ID か指紋のどちらかが合う作品を全部（アルバム・名前の順）。崩れた ID は無いものとして扱う
pub fn find_works(d: &Dirs, work_id: Option<&str>, fp: Option<&Fingerprint>) -> Result<Vec<FoundWork>, Refusal> {
    let id = work_id.filter(|s| is_work_id(s));
    let fp = fp.filter(|f| f.well_formed());
    let mut out = Vec::new();
    if id.is_none() && fp.is_none() {
        return Ok(out);
    }
    let Ok(albums) = fs::read_dir(&d.lib) else { return Err(Refusal(code::TARGET_MISSING)) };
    let mut albums: Vec<(String, std::path::PathBuf)> = albums
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| !n.starts_with('.'))
        .collect();
    albums.sort();
    // 封じ込め: リンクでライブラリの外を指すアルバムは見ない（locate_album と同じ作法。第三者レビュー D-L6）
    let Ok(lib_c) = d.lib.canonicalize() else { return Err(Refusal(code::TARGET_MISSING)) };
    for (album, dir) in albums {
        match dir.canonicalize() {
            Ok(c) if c.starts_with(&lib_c) && c != lib_c => {}
            _ => continue,
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut files: Vec<(String, std::path::PathBuf, u64)> = rd
            .flatten()
            .filter_map(|e| {
                let md = e.metadata().ok()?;
                md.is_file().then(|| (e.file_name().to_string_lossy().into_owned(), e.path(), md.len()))
            })
            .filter(|(n, _, _)| names::work_ext(n).is_some() && names::work_owner_base(n).is_some() && !n.to_ascii_lowercase().ends_with(".bak"))
            .collect();
        files.sort();
        for (name, path, size) in files {
            let id_match = match id {
                Some(want) if names::work_ext(&name) == Some(PROJECT_EXT) => header_work_id(&path).as_deref() == Some(want),
                _ => false,
            };
            let fingerprint_match = match fp {
                Some(want) if want.size == size => Fingerprint::of_file(&path).map(|g| &g == want).unwrap_or(false),
                _ => false,
            };
            if id_match || fingerprint_match {
                out.push(FoundWork { album: album.clone(), name, id_match, fingerprint_match });
            }
        }
    }
    Ok(out)
}
