//! V202 (§4-3・A6): モバイルの名前の決まり。PC の名前の付け方（`project_file_name`・`unique_dest`・`unique_project_dest`）は変えない。
//!
//! - 使えない文字の置き換えは PC と同じ（`sanitize_component`）
//! - 同じ名前かは、**大文字と小文字を区別せず、NFC にそろえて**比べる（[`fold_key`]）。iOS・Android は大小を区別するが、
//!   Windows・Mac は区別しない＝同期した先でぶつからないように。比べ方は純粋な関数（Windows・Mac のディスクには大小だけ違う
//!   名前を 2 つ置けないので、単体テストで見る）
//! - **NFC にそろえて書くのは新しく作る名前だけ**。在るファイルは、比べて見つけた実の名前のまま開く・直す（Mac から来た NFD の名前を
//!   「無い」と扱わない）
//! - 使われている名前＝本体（.memoanima・.animemo）か控え（.bak）がある名前。サムネ（.png）だけなら使ってよい
//! - Windows で使えない名前（CON・NUL・COM1 など。最初の「.」より前を大小無視で見る）は、その部分の後ろに `_` を足す
//!   （CON → CON_.memoanima・CON.v2 → CON_.v2.memoanima）
//! - 長さは、`.memoanima.png`・`.bak`・一時ファイルの印を足しても UTF-8 で 255 バイトに収まるまで（利用者の名前が超えたら断る・
//!   こちらで選ぶ名前は縮める）

use std::fs;
use std::io;
use std::path::Path;

use super::{code, Refusal};
use crate::pclib::{sanitize_component, validate_album, PROJECT_EXT, PROJECT_EXT_LEGACY};

/// ファイル名の上限（UTF-8 のバイト数）
pub const NAME_MAX_BYTES: usize = 255;
/// 一時ファイルの印の最大（`.<秒 10 桁>-<連番 20 桁>.tmp`＝PC の保存と同じ形）。`.png`・`.bak`（4）より長いのでこれで足りる
pub const TMP_MARK_MAX: usize = 36;
/// 作品のファイル名（`名前.memoanima`）の上限。これに一時ファイルの印・.png・.bak を足しても 255 に収まる
pub const FILE_MAX_BYTES: usize = NAME_MAX_BYTES - TMP_MARK_MAX;

/// NFC にそろえる
pub fn nfc(s: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(s).into_owned()
}

/// ★同じ名前かを比べる鍵: NFC → 小文字 → NFC（小文字にすると合成が崩れる字があるので、もう一度そろえる）
pub fn fold_key(s: &str) -> String {
    nfc(&nfc(s).to_lowercase())
}

/// 作品の本体か控えのファイル名なら、その「名前」（拡張子と控えの印を外したもの）。サムネ・一時ファイル・ほかは None
pub fn work_owner_base(entry: &str) -> Option<&str> {
    // to_ascii_lowercase はバイトの長さを変えない＝下の位置はそのまま使える
    let lower = entry.to_ascii_lowercase();
    let mut end = entry.len();
    if lower.ends_with(".bak") {
        end -= 4;
    }
    let l = &lower[..end];
    let ext = if l.ends_with(&format!(".{PROJECT_EXT}")) {
        PROJECT_EXT.len() + 1
    } else if l.ends_with(&format!(".{PROJECT_EXT_LEGACY}")) {
        PROJECT_EXT_LEGACY.len() + 1
    } else {
        return None;
    };
    Some(&entry[..end - ext])
}

/// Windows で使えない名前（最初の「.」より前・後ろの空白を除いて大小無視）
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²",
    "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

pub fn is_reserved(base: &str) -> bool {
    let head = base.split('.').next().unwrap_or("").trim_end_matches(' ');
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(head))
}

/// 予約名なら、最初の「.」の前（無ければ末尾）に `_` を足す
pub fn avoid_reserved(base: &str) -> String {
    if !is_reserved(base) {
        return base.to_string();
    }
    match base.find('.') {
        Some(i) => format!("{}_{}", &base[..i], &base[i..]),
        None => format!("{base}_"),
    }
}

/// 文字の境目で、`max` バイト以下に縮める
pub fn shrink(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// ★利用者が入れた作品の名前（拡張子なし）を、新しく作る名前にする: PC と同じ置き換え → 打ち込まれた作品の拡張子を外す →
/// NFC にそろえる → 予約名に `_`。長すぎれば断る（縮めない）
pub fn new_work_base(input: &str) -> Result<String, Refusal> {
    let s = sanitize_component(input);
    let lower = s.to_ascii_lowercase();
    let s = if lower.ends_with(&format!(".{PROJECT_EXT}")) {
        s[..s.len() - PROJECT_EXT.len() - 1].to_string()
    } else if lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}")) {
        s[..s.len() - PROJECT_EXT_LEGACY.len() - 1].to_string()
    } else {
        s
    };
    let s = avoid_reserved(&sanitize_component(&nfc(&s)));
    if s.len() + PROJECT_EXT.len() + 1 > FILE_MAX_BYTES {
        return Err(Refusal(code::NAME_TOO_LONG));
    }
    Ok(s)
}

/// ★利用者が入れたアルバムの名前を、新しく作る名前にする（PC の `validate_album` → NFC → 予約名に `_`）。長すぎれば断る
pub fn new_album_name(input: &str) -> Result<String, Refusal> {
    let a = validate_album(input).map_err(|_| Refusal(code::BAD_NAME))?;
    let a = avoid_reserved(&sanitize_component(&nfc(&a)));
    if a.starts_with('.') {
        return Err(Refusal(code::BAD_NAME));
    }
    if a.len() > NAME_MAX_BYTES {
        return Err(Refusal(code::NAME_TOO_LONG));
    }
    Ok(a)
}

/// ★dir の中で、`key`（[`fold_key`] 済みの名前）を使っている本体か控えの実の名前。`exclude` に挙げた実の名前は数えない
/// （自分自身の大小だけの変更・旧拡張子の作品を保存するとき）。種類（ファイル・フォルダ・リンク）は問わない
pub fn taken_by(dir: &Path, key: &str, exclude: &[String]) -> io::Result<Option<String>> {
    for ent in fs::read_dir(dir)?.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        if exclude.iter().any(|x| *x == n) {
            continue;
        }
        if let Some(b) = work_owner_base(&n) {
            if fold_key(b) == key {
                return Ok(Some(n));
            }
        }
    }
    Ok(None)
}

/// ★dir の中の作品の本体（控えではない）を、受けた名前から実の名前で見つける。同じ字が在ればそれ、無ければ大小と NFC だけ違うものが
/// ちょうど 1 つのとき（大小を区別するファイルシステムで 2 つ以上あれば、どれとも決めない＝None）
pub fn resolve_body(dir: &Path, file: &str) -> io::Result<Option<String>> {
    let key = fold_key(file);
    let mut hits: Vec<String> = Vec::new();
    for ent in fs::read_dir(dir)?.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        if n.to_ascii_lowercase().ends_with(".bak") || work_owner_base(&n).is_none() {
            continue;
        }
        if n == file {
            return Ok(Some(n));
        }
        if fold_key(&n) == key {
            hits.push(n);
        }
    }
    Ok(if hits.len() == 1 { hits.pop() } else { None })
}

/// ★ライブラリの中のアルバム（「.」で始まらないフォルダ）を実の名前で見つける（同じ字 → 大小と NFC だけ違うものが 1 つ）
pub fn resolve_album(lib: &Path, album: &str) -> io::Result<Option<String>> {
    let key = fold_key(album);
    let mut hits: Vec<String> = Vec::new();
    for ent in fs::read_dir(lib)?.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        if n.starts_with('.') || !ent.path().is_dir() {
            continue;
        }
        if n == album {
            return Ok(Some(n));
        }
        if fold_key(&n) == key {
            hits.push(n);
        }
    }
    Ok(if hits.len() == 1 { hits.pop() } else { None })
}

/// ★アルバムの名前が使われているか（ライブラリの直下の、同じ鍵の名前のもの全部。`exclude` は数えない）
pub fn album_taken(lib: &Path, key: &str, exclude: Option<&str>) -> io::Result<bool> {
    for ent in fs::read_dir(lib)?.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        if Some(n.as_str()) == exclude {
            continue;
        }
        if fold_key(&n) == key {
            return Ok(true);
        }
    }
    Ok(false)
}

/// ★こちらで選ぶ空いている名前（PC の移動と同じ付け方: `名前.ext`・`名前-1.ext`・`名前-2.ext` …。`from_one` なら `名前-1` から）。
/// 比べ方はこの決まり（大小と NFC を無視・本体か控えがあれば使われている）。長ければ名前を縮める（文字の境目で）
pub fn free_file_name(dir: &Path, base: &str, ext: &str, from_one: bool, exclude: &[String]) -> io::Result<String> {
    let start = if from_one { 1 } else { 0 };
    for i in start..10_000u32 {
        let tail = if i == 0 { format!(".{ext}") } else { format!("-{i}.{ext}") };
        let b = shrink(base, FILE_MAX_BYTES.saturating_sub(tail.len()));
        let cand = if i == 0 { b.to_string() } else { format!("{b}-{i}") };
        if taken_by(dir, &fold_key(&cand), exclude)?.is_none() {
            return Ok(format!("{cand}.{ext}"));
        }
    }
    Err(io::Error::other("no free name"))
}

/// 作品のファイル名の拡張子（`memoanima` か `animemo`。小文字）。作品のファイル名でなければ None
pub fn work_ext(file: &str) -> Option<&'static str> {
    let lower = file.to_ascii_lowercase();
    if lower.ends_with(&format!(".{PROJECT_EXT}")) {
        Some(PROJECT_EXT)
    } else if lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}")) {
        Some(PROJECT_EXT_LEGACY)
    } else {
        None
    }
}
