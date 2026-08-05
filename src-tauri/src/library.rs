//! うごメモ3Dの保存フォルダ（例: `private/Nintendo 3DS/app/JKZJ/`）を **read-only** で
//! 再帰スキャンし、生の `.kwz` / `.ppm` を作品一覧として返す。
//!
//! 本体がこの配下に通常のファイルとして保存した作品を、そのまま読み込むだけ。
//! 直下の各サブフォルダ（作品管理フォルダ）を「アルバム」として扱う。

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct FlipnoteEntry {
    pub path: String,
    pub album: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
}

pub fn scan(root: &str) -> Result<Vec<FlipnoteEntry>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("フォルダが見つかりません: {root}"));
    }
    let mut out: Vec<FlipnoteEntry> = Vec::new();
    walk(root_path, root_path, &mut out);
    out.sort_by(|a, b| a.album.cmp(&b.album).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<FlipnoteEntry>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in entries.flatten() {
        let path = ent.path();
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };
        if ext != "kwz" && ext != "ppm" {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // アルバム = root からの相対パスの先頭コンポーネント（直下ならファイル名になるので "(直下)"）
        let album = path
            .strip_prefix(root)
            .ok()
            .and_then(|rel| rel.components().next())
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default();
        let album = if album.is_empty() || album == name {
            "(直下)".to_string()
        } else {
            album
        };
        let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(FlipnoteEntry {
            path: path.to_string_lossy().to_string(),
            album,
            name,
            ext,
            size,
        });
    }
}
