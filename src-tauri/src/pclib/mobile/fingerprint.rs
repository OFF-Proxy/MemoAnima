//! V202 (§4-4 の 9): 保存元の指紋＝**ファイルの中身の SHA-256 と大きさの組**（Rust で取る。WebView の暗号の機能が使えない場合がある）。
//! 取るのは、作品を開くとき（読む命令が中身と一緒に返す）と、保存が終わるたび（書いた中身）。
//! 上書きは指紋で確かめる（ID と版では確かめない＝v1.9.5 までの版で開いて保存すると版が増えないので、外で直されたことが版では分からない）

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// 指紋（JS から見た形は `{"sha256": "<小文字の hex 64 字>", "size": <バイト数>}`＝contract.json の fingerprint）
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fingerprint {
    pub sha256: String,
    pub size: u64,
}

impl Fingerprint {
    pub fn of_bytes(b: &[u8]) -> Fingerprint {
        Fingerprint { sha256: hex::encode(Sha256::digest(b)), size: b.len() as u64 }
    }

    /// ファイルの指紋（1MiB ずつ読む＝作品まるごとをメモリに持たない）
    pub fn of_file(p: &Path) -> io::Result<Fingerprint> {
        let mut f = fs::File::open(p)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut size = 0u64;
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            size += n as u64;
        }
        Ok(Fingerprint { sha256: hex::encode(h.finalize()), size })
    }

    /// 形が正しいか（小文字の hex 64 字）
    pub fn well_formed(&self) -> bool {
        self.sha256.len() == 64 && self.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
}
