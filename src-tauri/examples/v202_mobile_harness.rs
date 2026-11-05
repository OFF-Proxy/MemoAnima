//! V202 (M-1a) の検査用の実行ファイル。**製品に入らない**（Cargo.toml の [[example]]・required-features = ["mobile-harness"]）。
//!
//! scripts/v202_smoke.ts が、モバイルの部品（src/mobile/session.ts）と**本物の Rust の関数**をつなぐのに使う:
//! 部品が Tauri の invoke に渡すもの（命令の名前・引数の物・生のボディ）をそのまま受け、命令の皮の下の 1 段
//! （`pclib::mobile::commands::dispatch`＝命令と同じ関数）を呼び、戻りを返す。置き場は検査が作った %TEMP% の下のフォルダだけ
//! （`--lib` と `--config`。作者の設定・ライブラリ・オートセーブには届かない）。
//!
//! やり取り（標準入出力・どちらも [u32 LE JSON の長さ][JSON][u32 LE 本体の長さ][本体]）:
//!   → {"op":"call","cmd":"mobile_…","payload":…}（本体＝生のボディ）  ← {"ok":true,"kind":"json","value":…} か {"ok":true,"kind":"raw"}（本体＝生のバイト列）か {"ok":false,"err":"…"}
//!   → {"op":"hook","stage":"evacuated"}  … 次にその所へ来たら止めて ← {"event":"paused","stage":…,"dest":…,"evac":…} を送り、
//!      → {"op":"continue"}（続ける）／{"op":"stop"}（後片付けをせずに抜ける）／{"op":"crash"}（その場でプロセスを終える＝アプリが止められた）
//!   → {"op":"fail-write"}  … 次の一時ファイルの書き込みを途中で失敗させる（空きが無い）
//!   → {"op":"pc-save","album":…,"name":…}（本体＝[作品][サムネ] の save_project の封筒）… PC の保存（pclib::save_project）で書く＝A3 の逆向き
//!   → {"op":"quit"}

use animemo_lib::pclib;
use animemo_lib::pclib::mobile::commands::{dispatch, Reply};
use animemo_lib::pclib::mobile::save::{write_new, Hooks, Stage, StageCtx, Step};
use animemo_lib::pclib::mobile::Dirs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

fn read_frame(r: &mut impl Read) -> io::Result<Option<(serde_json::Value, Vec<u8>)>> {
    let mut n = [0u8; 4];
    if let Err(e) = r.read_exact(&mut n) {
        return if e.kind() == io::ErrorKind::UnexpectedEof { Ok(None) } else { Err(e) };
    }
    let mut j = vec![0u8; u32::from_le_bytes(n) as usize];
    r.read_exact(&mut j)?;
    r.read_exact(&mut n)?;
    let mut b = vec![0u8; u32::from_le_bytes(n) as usize];
    r.read_exact(&mut b)?;
    let v: serde_json::Value = serde_json::from_slice(&j).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(Some((v, b)))
}

fn write_frame(w: &mut impl Write, v: &serde_json::Value, body: &[u8]) -> io::Result<()> {
    let j = serde_json::to_vec(v).unwrap();
    w.write_all(&(j.len() as u32).to_le_bytes())?;
    w.write_all(&j)?;
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(body)?;
    w.flush()
}

struct Harness {
    pause_at: Vec<String>,
    fail_write: bool,
}

impl Hooks for Harness {
    fn at(&mut self, s: Stage, c: &StageCtx) -> Step {
        let Some(i) = self.pause_at.iter().position(|x| x == s.name()) else { return Step::Go };
        self.pause_at.remove(i);
        let ev = serde_json::json!({
            "event": "paused",
            "stage": s.name(),
            "dir": c.dir.to_string_lossy(),
            "dest": c.dest.to_string_lossy(),
            "evac": c.evac.map(|p| p.to_string_lossy().into_owned()),
        });
        let mut out = io::stdout().lock();
        if write_frame(&mut out, &ev, &[]).is_err() {
            std::process::exit(87);
        }
        drop(out);
        let mut inp = io::stdin().lock();
        match read_frame(&mut inp) {
            Ok(Some((v, _))) => match v["op"].as_str() {
                Some("continue") => Step::Go,
                Some("stop") => Step::Stop,
                // アプリが止められたのをまねる（後片付けも保全も無し）
                _ => std::process::exit(86),
            },
            _ => std::process::exit(86),
        }
    }
    fn write_tmp(&mut self, p: &Path, data: &[u8]) -> io::Result<()> {
        if self.fail_write {
            self.fail_write = false;
            std::fs::write(p, &data[..data.len() / 2])?;
            return Err(io::Error::new(io::ErrorKind::StorageFull, "disk full (harness)"));
        }
        write_new(p, data)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| panic!("{k} が要る"));
    let lib = PathBuf::from(arg("--lib"));
    let config = PathBuf::from(arg("--config"));
    let d = Dirs::under(lib.clone(), &config);
    let mut h = Harness { pause_at: Vec::new(), fail_write: false };
    loop {
        let frame = {
            let mut inp = io::stdin().lock();
            read_frame(&mut inp)
        };
        let Ok(Some((req, body))) = frame else { break };
        let (reply, raw): (serde_json::Value, Vec<u8>) = match req["op"].as_str().unwrap_or("") {
            "call" => {
                let cmd = req["cmd"].as_str().unwrap_or("");
                match dispatch(&d, cmd, &req["payload"], &body, &mut h) {
                    Ok(Reply::Json(v)) => (serde_json::json!({ "ok": true, "kind": "json", "value": v }), Vec::new()),
                    Ok(Reply::Raw(b)) => (serde_json::json!({ "ok": true, "kind": "raw" }), b),
                    Err(e) => (serde_json::json!({ "ok": false, "err": e }), Vec::new()),
                }
            }
            "hook" => {
                h.pause_at.push(req["stage"].as_str().unwrap_or("").to_string());
                (serde_json::json!({ "ok": true, "kind": "json", "value": null }), Vec::new())
            }
            "fail-write" => {
                h.fail_write = true;
                (serde_json::json!({ "ok": true, "kind": "json", "value": null }), Vec::new())
            }
            "pc-save" => {
                // PC の保存の道（save_project＝tmp → .bak → rename → 照合・サムネ）で書く。封筒は [u32 長さ][作品][u32 長さ][サムネ]
                let take = |o: usize| -> Option<(&[u8], usize)> {
                    let n = u32::from_le_bytes(body.get(o..o + 4)?.try_into().ok()?) as usize;
                    Some((body.get(o + 4..o + 4 + n)?, o + 4 + n))
                };
                match take(0).and_then(|(data, o)| take(o).map(|(thumb, _)| (data, thumb))) {
                    Some((data, thumb)) => match pclib::save_project(&lib.to_string_lossy(), req["album"].as_str().unwrap_or(""), req["name"].as_str().unwrap_or(""), data, thumb) {
                        Ok(p) => (serde_json::json!({ "ok": true, "kind": "json", "value": Path::new(&p).file_name().map(|s| s.to_string_lossy().into_owned()) }), Vec::new()),
                        Err(e) => (serde_json::json!({ "ok": false, "err": e }), Vec::new()),
                    },
                    None => (serde_json::json!({ "ok": false, "err": "bad pc-save body" }), Vec::new()),
                }
            }
            "quit" => break,
            _ => (serde_json::json!({ "ok": false, "err": "unknown op" }), Vec::new()),
        };
        let mut out = io::stdout().lock();
        if write_frame(&mut out, &reply, &raw).is_err() {
            break;
        }
    }
}
