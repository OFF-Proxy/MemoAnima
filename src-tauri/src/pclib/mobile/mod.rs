//! V202 (M-1a・要件 docs/REQ_mobile_m1_base.md §4-3・§4-4・§4-5): **モバイルだけ**が使う保存の仕組み。
//!
//! ★PC は呼ばない。PC の製品のビルドでは組み立てない（pclib.rs の `#[cfg(any(mobile, test, feature = "mobile-harness"))]`）。
//!  PC の命令（save_project_raw・create_project_raw・save_autosave_raw・load_autosave・move_project ほか）とその中身は 1 行も変えていない。
//! ★pclib の子に置いたのは、pclib の関数（`sanitize_component`・`validate_album`・`lock_lib`・`list_albums`・`load_index` ほか）と、
//!  lib.rs の関数（`parse_save_envelope`・`raw_body`・`pack_autosave_payload`・`parse_autosave`・`atomic_replace_with`）を、
//!  **見える範囲を広げずに**使うため（Rust では子のモジュールから親の非公開の関数が見える）。
//! ★中身の関数は、ライブラリ・オートセーブ・退避先のフォルダを**引数で受ける**（[`Dirs`]）。OS から置き場を取るのは命令の薄い皮
//!  （`commands.rs`）だけ。検査（単体テスト・examples/v202_mobile_harness.rs）は %TEMP% の下に置き場を作って渡す＝作者の設定・
//!  ライブラリ・オートセーブに届かない（P-0）。
//! ★想定内の断りは文ではなく決まった値（[`code`]）で返す。値の一覧と JS との約束は 1 か所の表（`src/mobile/contract.json`）にあり、
//!  `contract.rs` の単体テストが、表と命令・型を突き合わせる（片側だけ変えると赤）。
//! ★W-10: ログと断りの値に、作品名・パス・作品の中身を入れない（作品の中身や名前を返すのが役目の命令の戻り値は別）。
//!  絶対パスを保存しない（決-4）。通信はしない。

// V212 (M-1c・D-M1-3): Android で大きいバイト列を分けて送る・受け取る（中身は cfg(android) に閉じない＝cargo test で回す）
pub mod chunks;
pub mod commands;
pub mod contract;
// V211 (M-1b): 確かめ画面（開発用）の命令と試験用のライブラリ・故障を起こす口。ビルドの印（feature `mobile-devcheck`）の中だけ
//  （cargo test では中身の確かめのために組み立てる。Tauri の命令の皮は印の中だけ）
#[cfg(any(feature = "mobile-devcheck", test))]
pub mod devcheck;
pub mod evac;
pub mod find;
pub mod fingerprint;
pub mod init;
pub mod names;
pub mod ops;
pub mod place;
pub mod save;
pub mod sessions;

#[cfg(test)]
mod tests;
// V212: 分けて送る・受け取る道の単体テスト
#[cfg(test)]
mod chunk_tests;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 退避先のフォルダの名前（app_config_dir の下・ライブラリの外＝ファイル App から見えない）
pub const EVAC_DIR: &str = "save-evac";

/// 置き場（ライブラリ・開いた作品ごとのオートセーブ・退避先・ログ）。中身の関数はこれを引数で受ける
#[derive(Clone, Debug)]
pub struct Dirs {
    /// ライブラリ（iOS は Documents・Android は app_data_dir/library。命令の皮が毎回 OS から取る）
    pub lib: PathBuf,
    /// 開いた作品ごとのオートセーブ（app_config_dir/autosave/sessions）
    pub sessions: PathBuf,
    /// 退避先（app_config_dir/save-evac）
    pub evac: PathBuf,
    /// ログ（app_config_dir/logs・PC と同じ置き場）
    pub logs: PathBuf,
    /// 設定の置き場（app_config_dir。V211: ライブラリを作り終えた印を settings.json に書く）
    pub config: PathBuf,
}

impl Dirs {
    /// `config` は app_config_dir（検査は %TEMP% の下のフォルダ）
    pub fn under(lib: PathBuf, config: &Path) -> Dirs {
        Dirs {
            lib,
            sessions: config.join("autosave").join("sessions"),
            evac: config.join(EVAC_DIR),
            logs: config.join("logs"),
            config: config.to_path_buf(),
        }
    }
}

/// 想定内の断り（決まった値）。命令は `Err(値の文字列)` で返す。一覧は `src/mobile/contract.json` の refusals と同じ（contract.rs が見る）
pub mod code {
    /// 封筒・引数の形が違う
    pub const BAD_REQUEST: &str = "bad-request";
    /// 名前として使えない（アルバムが「.」で始まる・作品の拡張子が違う・文字の置き換えで形が変わる名前）
    pub const BAD_NAME: &str = "bad-name";
    /// 名前が長すぎる（.memoanima.png・.bak・一時ファイルの印を足すと UTF-8 で 255 バイトを超える）
    pub const NAME_TOO_LONG: &str = "name-too-long";
    /// 使われている名前（本体か控えがある）
    pub const NAME_TAKEN: &str = "name-taken";
    /// アルバムが無い（作り直さない）
    pub const ALBUM_MISSING: &str = "album-missing";
    /// 保存先・対象の作品が無い
    pub const TARGET_MISSING: &str = "target-missing";
    /// 保存元の指紋が今のファイルと違う（外で中身が変わった）
    pub const FINGERPRINT_MISMATCH: &str = "fingerprint-mismatch";
    /// 同じ保存先に、再開しても片付かない退避の記録がある
    pub const PENDING_RECORD: &str = "pending-record";
    /// 古い世代の書き込み・消すこと（もっと新しい世代を受けている）
    pub const STALE_GENERATION: &str = "stale-generation";
    /// セッションの番号の形が違う
    pub const BAD_SESSION: &str = "bad-session";
    /// 読む前の大きさの門番を超える
    pub const TOO_LARGE: &str = "too-large";
    /// 退避先とライブラリが別のボリューム（何も動かさない）
    pub const CROSS_VOLUME: &str = "cross-volume";
    /// 空きが無い（書きかけは消した）
    pub const NO_SPACE: &str = "no-space";
    /// 置けない（置き換えない置き方が使えないファイルシステム・版。置き換える rename には落とさない）
    pub const CANNOT_PLACE: &str = "cannot-place";
    /// 書いたものを読み戻したら違った（置く前に止めた）
    pub const VERIFY_FAILED: &str = "verify-failed";
    /// ライブラリの外を指す
    pub const OUTSIDE: &str = "outside";
    /// この OS では使えない（ライブラリの場所＝モバイルだけ）
    pub const UNSUPPORTED: &str = "unsupported";
    /// そのほかの読み書きの失敗（種類はログに 1 行）
    pub const IO: &str = "io";

    /// 全部（contract.rs が表と突き合わせる）
    pub const ALL: &[&str] = &[
        BAD_REQUEST,
        BAD_NAME,
        NAME_TOO_LONG,
        NAME_TAKEN,
        ALBUM_MISSING,
        TARGET_MISSING,
        FINGERPRINT_MISMATCH,
        PENDING_RECORD,
        STALE_GENERATION,
        BAD_SESSION,
        TOO_LARGE,
        CROSS_VOLUME,
        NO_SPACE,
        CANNOT_PLACE,
        VERIFY_FAILED,
        OUTSIDE,
        UNSUPPORTED,
        IO,
    ];
}

/// 断り（決まった値）。`STOPPED` は検査の口で止めたときだけ（製品の手は止めない）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal(pub &'static str);

/// 検査の口（[`save::Hooks`]）が止めたとき。製品の命令には出てこない（`NoHooks` は止めない）
pub const STOPPED: &str = "stopped";

impl From<Refusal> for String {
    fn from(r: Refusal) -> String {
        r.0.to_string()
    }
}

/// 読み書きの失敗を決まった値へ（空きが無いは no-space・ほかは io）
pub fn io_refusal(e: &io::Error) -> Refusal {
    match e.kind() {
        io::ErrorKind::StorageFull => Refusal(code::NO_SPACE),
        io::ErrorKind::CrossesDevices => Refusal(code::CROSS_VOLUME),
        io::ErrorKind::Unsupported => Refusal(code::CANNOT_PLACE),
        _ => Refusal(code::IO),
    }
}

/// 検査だけ: 生のボディの封筒（JS の packRawBody と同じ並び）
#[cfg(test)]
pub fn port_body_for_test(meta: &serde_json::Value, parts: &[&[u8]]) -> Vec<u8> {
    let m = serde_json::to_vec(meta).unwrap();
    let mut b = (m.len() as u32).to_le_bytes().to_vec();
    b.extend_from_slice(&m);
    for p in parts {
        b.extend_from_slice(&(p.len() as u32).to_le_bytes());
        b.extend_from_slice(p);
    }
    b
}

/// ログに 1 行（作品名・パスを渡さないこと。呼び出し側が決まった文だけを渡す）
pub fn log_line(d: &Dirs, line: &str) {
    let _ = fs::create_dir_all(&d.logs);
    let _ = crate::append_log_line(&d.logs, line);
}

/// ライブラリの中のアルバムを、受けた名前から実の名前で見つける（同じ字が在ればそれ・無ければ大小と NFC だけ違うものが 1 つ）。
/// 封じ込め: canonicalize してライブラリの配下（ライブラリそのものではない）のときだけ（`delete_item` と同じ作法）
pub fn locate_album(d: &Dirs, album: &str) -> Result<(String, PathBuf), Refusal> {
    let a = super::validate_album(album).map_err(|_| Refusal(code::BAD_NAME))?;
    if a != album {
        // 置き換えで形が変わる名前は、ライブラリの一覧から来た名前ではない
        return Err(Refusal(code::BAD_NAME));
    }
    if !d.lib.is_dir() {
        return Err(Refusal(code::ALBUM_MISSING));
    }
    let real = names::resolve_album(&d.lib, &a)
        .map_err(|e| io_refusal(&e))?
        .ok_or(Refusal(code::ALBUM_MISSING))?;
    let dir = d.lib.join(&real);
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let dir_c = dir.canonicalize().map_err(|e| io_refusal(&e))?;
    if !dir_c.starts_with(&lib_c) || dir_c == lib_c {
        return Err(Refusal(code::OUTSIDE));
    }
    Ok((real, dir))
}

/// 作品のファイル名（拡張子つき）として受けた名前を確かめる（置き換えで形が変わらない・作品の拡張子）。
/// `legacy_ok` は旧拡張子 `.animemo` も通すか
pub fn check_work_file_name(name: &str, legacy_ok: bool) -> Result<(), Refusal> {
    if super::sanitize_component(name) != name {
        return Err(Refusal(code::BAD_NAME));
    }
    let lower = name.to_ascii_lowercase();
    let ok = lower.ends_with(&format!(".{}", super::PROJECT_EXT))
        || (legacy_ok && lower.ends_with(&format!(".{}", super::PROJECT_EXT_LEGACY)));
    if ok && names::work_owner_base(name).is_some() && !lower.ends_with(".bak") {
        Ok(())
    } else {
        Err(Refusal(code::BAD_NAME))
    }
}

/// サムネ（`<作品のファイル名>.png`）を書く（PC の保存と同じ。空なら書かない・失敗しても保存は成功のまま）
pub fn write_thumb(dir: &Path, file: &str, png: &[u8]) {
    if !png.is_empty() {
        let _ = fs::write(dir.join(format!("{file}.png")), png);
    }
}
