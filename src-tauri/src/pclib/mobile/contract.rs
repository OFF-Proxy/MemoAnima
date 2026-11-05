//! V202 (指示 §0 (c)): JS と Rust の約束は**1 か所の表**（`src/mobile/contract.json`）。ここはそれを読む。
//! 単体テストが、表と命令（名前・引数の欄・封筒の印の欄）・型（戻り値の欄）・断る値・封筒のバイトの並び・指紋の形・ID と番号の形・
//! 名前の決まりの見本・大きさの門番を突き合わせる（片側だけ変えると赤）。JS の側は scripts/v202_smoke.ts が同じ表を読む

/// 約束の表（ビルドに埋め込む。製品の命令はこれを読まない＝表を変えても命令は変わらない。突き合わせるのは単体テスト）
pub const CONTRACT_JSON: &str = include_str!("../../../../src/mobile/contract.json");

#[cfg(test)]
mod tests {
    use super::CONTRACT_JSON;
    use crate::pclib::mobile::commands::*;
    use crate::pclib::mobile::evac::{self, RecordFile, ResumeItem};
    use crate::pclib::mobile::find::{self, FindArgs, FoundWork};
    use crate::pclib::mobile::fingerprint::Fingerprint;
    use crate::pclib::mobile::init::{self as init_mod, LibraryInit, LibraryInitArgs};
    use crate::pclib::mobile::names;
    use crate::pclib::mobile::ops::{self, AlbumPlace, FreeSpace, WorkPlace};
    use crate::pclib::mobile::save::{NewMeta, OverwriteMeta, SaveResult};
    use crate::pclib::mobile::sessions::{self, SessionEntry};
    use crate::pclib::mobile::{code, EVAC_DIR};
    use serde::de::DeserializeOwned;
    use serde::Serialize;
    use serde_json::Value;

    fn contract() -> Value {
        serde_json::from_str(CONTRACT_JSON).expect("contract.json が JSON として読めない")
    }
    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        k.sort();
        k
    }
    fn strs(v: &Value) -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    }
    fn unhex(s: &str) -> Vec<u8> {
        hex::decode(s).expect("hex")
    }
    /// 見本を型に通して戻した欄（serde の rename_all を両方向で通す＝JS から見た名前）
    fn rt<T: Serialize + DeserializeOwned>(v: &Value) -> Result<Vec<String>, String> {
        let t: T = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        Ok(keys(&serde_json::to_value(t).unwrap()))
    }
    fn ser_keys<T: Serialize>(t: &T) -> Vec<String> {
        keys(&serde_json::to_value(t).unwrap())
    }
    /// 命令の皮の字（このファイルと同じフォルダの commands.rs）
    const COMMANDS_RS: &str = include_str!("commands.rs");

    /// generate_handler! に並べた名前
    fn handler_names() -> Vec<String> {
        let at = COMMANDS_RS.find("tauri::generate_handler![").expect("登録の表が無い");
        let rest = &COMMANDS_RS[at + "tauri::generate_handler![".len()..];
        let end = rest.find(']').expect("登録の表の終わり");
        rest[..end].split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }
    /// 命令の皮の引数の並び（`pub fn 名前(` から `)` まで）と戻り値の型
    fn signature(name: &str) -> (String, String) {
        let pat = format!("#[tauri::command]\npub fn {name}(");
        let at = COMMANDS_RS.replace("\r\n", "\n").find(&pat).unwrap_or_else(|| panic!("命令 {name} の皮が無い"));
        let src = COMMANDS_RS.replace("\r\n", "\n");
        let rest = &src[at + pat.len()..];
        let close = rest.find(") ->").or_else(|| rest.find(") {")).unwrap();
        let params = rest[..close].to_string();
        let ret = rest[close..].split('{').next().unwrap_or("").trim_start_matches(')').trim().trim_start_matches("->").trim().to_string();
        (params, ret)
    }

    /// ★命令の名前: 表・COMMANDS・登録の表（generate_handler!）がそろっている
    #[test]
    fn command_names_match_contract() {
        let c = contract();
        let names: Vec<String> = c["commands"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, COMMANDS.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "表と COMMANDS");
        assert_eq!(names, handler_names(), "表と登録の表");
        // 登録の表は組み立てられる（cfg(test) で handler を作る）
        let _h = handler();
    }

    /// ★命令ごとの受け方（生のボディ／args／引数なし）と引数・封筒の印の欄・戻り値の型
    #[test]
    fn command_shapes_match_contract() {
        let c = contract();
        assert_eq!(c["argsKey"], "args");
        for cmd in c["commands"].as_array().unwrap() {
            let name = cmd["name"].as_str().unwrap();
            let body = cmd["body"].as_str().unwrap();
            let (params, ret) = signature(name);
            match body {
                "raw" => assert!(params.contains("request: tauri::ipc::Request<'_>") && !params.contains("args:"), "{name} は生のボディ: {params}"),
                "args" => {
                    let ty = cmd["argsType"].as_str().unwrap();
                    assert!(params.contains(&format!("args: {ty}")) && !params.contains("request"), "{name} は args: {ty}: {params}");
                }
                "none" => assert!(!params.contains("args:") && !params.contains("request"), "{name} は引数なし: {params}"),
                _ => panic!("知らない受け方 {body}"),
            }
            // 引数の欄（JS から見た名前）
            if body == "args" {
                let sample = &cmd["args"];
                let got = match cmd["argsType"].as_str().unwrap() {
                    "WorkArgs" => rt::<WorkArgs>(sample),
                    "FindArgs" => rt::<FindArgs>(sample),
                    "RenameWorkArgs" => rt::<RenameWorkArgs>(sample),
                    "MoveWorkArgs" => rt::<MoveWorkArgs>(sample),
                    "AlbumNameArgs" => rt::<AlbumNameArgs>(sample),
                    "RenameAlbumArgs" => rt::<RenameAlbumArgs>(sample),
                    "SessionArgs" => rt::<SessionArgs>(sample),
                    "SessionGenArgs" => rt::<SessionGenArgs>(sample),
                    "LibraryInitArgs" => rt::<LibraryInitArgs>(sample),
                    t => panic!("知らない型 {t}"),
                };
                assert_eq!(got.unwrap_or_else(|e| panic!("{name} の見本が型に通らない: {e}")), keys(sample), "{name} の引数の欄");
            }
            if body == "raw" {
                let sample = &cmd["meta"];
                let got = match cmd["metaType"].as_str().unwrap() {
                    "NewMeta" => rt::<NewMeta>(sample),
                    "OverwriteMeta" => rt::<OverwriteMeta>(sample),
                    "AutosaveWriteMeta" => rt::<AutosaveWriteMeta>(sample),
                    t => panic!("知らない型 {t}"),
                };
                assert_eq!(got.unwrap_or_else(|e| panic!("{name} の見本が型に通らない: {e}")), keys(sample), "{name} の封筒の印の欄");
                // 封筒の部分の数（作品とサムネ／作品だけ）は body_* が parse_save_envelope に渡す数と同じ
                let n = strs(&cmd["parts"]).len();
                let f = match name {
                    "mobile_save_new" => "body_save_new",
                    "mobile_save_overwrite" => "body_save_overwrite",
                    _ => "body_autosave_write",
                };
                let src = COMMANDS_RS.replace("\r\n", "\n");
                let at = src.find(&format!("pub fn {f}(")).unwrap();
                assert!(src[at..].split("\n}\n").next().unwrap().contains(&format!("parse_save_envelope(body, {n})")), "{f} の部分の数");
            }
            // 戻り値
            let r = cmd["returns"].as_str().unwrap();
            let want = match r {
                "string" => "Result<String, String>".to_string(),
                "number" => "u64".to_string(),
                "null" => "Result<(), String>".to_string(),
                x if x.starts_with("envelope:") => "Result<tauri::ipc::Response, String>".to_string(),
                x if x.ends_with("[]") => format!("Result<Vec<{}>, String>", if x == "ResumeItem[]" { "evac::ResumeItem" } else { &x[..x.len() - 2] }),
                x => format!("Result<{x}, String>"),
            };
            assert_eq!(ret, want, "{name} の戻り値");
            // 引数を一つも足し引きしない（deny_unknown_fields）: 知らない欄を足した見本は通らない
            if body == "args" {
                let mut bad = cmd["args"].clone();
                bad["extraField"] = Value::Bool(true);
                let ok = match cmd["argsType"].as_str().unwrap() {
                    "WorkArgs" => rt::<WorkArgs>(&bad).is_ok(),
                    "FindArgs" => rt::<FindArgs>(&bad).is_ok(),
                    "RenameWorkArgs" => rt::<RenameWorkArgs>(&bad).is_ok(),
                    "MoveWorkArgs" => rt::<MoveWorkArgs>(&bad).is_ok(),
                    "AlbumNameArgs" => rt::<AlbumNameArgs>(&bad).is_ok(),
                    "RenameAlbumArgs" => rt::<RenameAlbumArgs>(&bad).is_ok(),
                    "SessionArgs" => rt::<SessionArgs>(&bad).is_ok(),
                    "LibraryInitArgs" => rt::<LibraryInitArgs>(&bad).is_ok(),
                    _ => rt::<SessionGenArgs>(&bad).is_ok(),
                };
                assert!(!ok, "{name} が知らない欄を受けた");
            }
        }
    }

    /// ★戻り値の欄（serde で出した鍵）
    #[test]
    fn return_types_match_contract() {
        let c = contract();
        let t = &c["types"];
        let fp = Fingerprint::of_bytes(b"x");
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("SaveResult", ser_keys(&SaveResult { fingerprint: fp.clone(), album: "a".into(), name: "n".into(), ours_moved: false, kept_copies: vec![], record_left: false })),
            ("FoundWork", ser_keys(&FoundWork { album: "a".into(), name: "n".into(), id_match: true, fingerprint_match: false })),
            ("ResumeItem", ser_keys(&ResumeItem { album: "a".into(), name: "n".into(), outcome: "copy".into() })),
            ("WorkPlace", ser_keys(&WorkPlace { album: "a".into(), name: "n".into() })),
            ("AlbumPlace", ser_keys(&AlbumPlace { album: "a".into() })),
            ("FreeSpace", ser_keys(&FreeSpace { available: 1, total: 2 })),
            ("SessionEntry", ser_keys(&SessionEntry { session: "s".into(), meta: Value::Null, from: "body".into() })),
            ("Fingerprint", ser_keys(&fp)),
            ("LibraryInit", ser_keys(&LibraryInit { steps: vec![], ready: true })),
            ("EvacRecord", ser_keys(&RecordFile { v: 1, album: "a".into(), name: "n".into(), source_fingerprint: fp.clone(), new_fingerprint: fp.clone() })),
        ];
        for (name, got) in cases {
            let mut want = strs(&t[name]);
            want.sort();
            assert_eq!(got, want, "型 {name} の欄");
        }
        // 読む命令の封筒の頭（WorkHead）: read_work が書く欄
        let src = include_str!("ops.rs");
        let mut want = strs(&t["WorkHead"]);
        want.sort();
        assert!(src.contains(r#"serde_json::json!({ "fingerprint": fp, "album": album_real })"#), "read_work の封筒の頭");
        assert_eq!(want, vec!["album".to_string(), "fingerprint".to_string()]);
        // オートセーブの印のうち Rust が読む欄（album・name）は表にある
        let am = strs(&t["AutosaveMeta"]);
        assert!(am.contains(&"album".to_string()) && am.contains(&"name".to_string()));
        let ss = include_str!("sessions.rs");
        assert!(ss.contains(r#"meta.get("album")"#) && ss.contains(r#"meta.get("name")"#) && ss.contains(r#"meta["album"]"#) && ss.contains(r#"meta["name"]"#));
        // 再開の結果・オートセーブの「どちらから」
        assert_eq!(strs(&c["resumeOutcomes"]), evac::OUTCOMES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(strs(&c["sessionFrom"]), vec!["body".to_string(), "bak".to_string()]);
        // V211: ライブラリを作り終える手順の名前と、作り終えた印の設定のキー
        assert_eq!(strs(&c["initSteps"]), init_mod::STEPS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(c["settingsKey"].as_str(), Some(init_mod::READY_KEY));
    }

    /// ★断る値
    #[test]
    fn refusals_match_contract() {
        let c = contract();
        assert_eq!(strs(&c["refusals"]), code::ALL.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    /// ★封筒のバイトの並び（同じ見本を両側で読む）
    #[test]
    fn envelopes_match_contract() {
        let c = contract();
        let e = &c["envelope"];
        let got = crate::pack_autosave_payload(&e["meta"], std::path::Path::new(e["path"].as_str().unwrap()), &unhex(e["dataHex"].as_str().unwrap()));
        assert_eq!(hex::encode(&got), e["hex"].as_str().unwrap(), "読む命令の封筒");
        let s = &c["saveBody"];
        let body = unhex(s["hex"].as_str().unwrap());
        let parts = strs(&s["partsHex"]);
        let (meta, got) = crate::parse_save_envelope(&body, parts.len()).unwrap();
        assert_eq!(meta, s["meta"], "生のボディの印");
        assert_eq!(got.iter().map(hex::encode).collect::<Vec<_>>(), parts, "生のボディの中身");
        // 見本は本物の命令の印の形（新しく保存）
        assert!(rt::<NewMeta>(&s["meta"]).is_ok());
    }

    /// ★指紋の形
    #[test]
    fn fingerprint_matches_contract() {
        let c = contract();
        let f = &c["fingerprint"];
        let fp = Fingerprint::of_bytes(f["text"].as_str().unwrap().as_bytes());
        assert_eq!(serde_json::to_value(&fp).unwrap(), serde_json::json!({ "sha256": f["sha256"], "size": f["size"] }));
        assert!(fp.well_formed());
        let dir = std::env::temp_dir().join(format!("v202-fp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x");
        std::fs::write(&p, f["text"].as_str().unwrap()).unwrap();
        let ff = Fingerprint::of_file(&p).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ff, fp, "ファイルから取っても同じ");
    }

    /// ★ID と番号の形・名前の決まりの見本・大きさの門番・置き場の名前
    #[test]
    fn formats_and_limits_match_contract() {
        let c = contract();
        let f = &c["formats"];
        for s in strs(&f["workId"]["valid"]) {
            assert!(find::is_work_id(&s), "ID として通るはず: {s}");
        }
        for s in strs(&f["workId"]["invalid"]) {
            assert!(!find::is_work_id(&s), "ID として通らないはず: {s}");
        }
        for s in strs(&f["session"]["valid"]) {
            assert!(sessions::is_session_id(&s), "番号として通るはず: {s}");
        }
        for s in strs(&f["session"]["invalid"]) {
            assert!(!sessions::is_session_id(&s), "番号として通らないはず: {s}");
        }
        for s in strs(&f["record"]["valid"]) {
            assert!(evac::is_recno(&s), "{s}");
        }
        for s in strs(&f["record"]["invalid"]) {
            assert!(!evac::is_recno(&s), "{s}");
        }
        for p in f["foldSame"].as_array().unwrap() {
            let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
            assert_eq!(names::fold_key(a), names::fold_key(b), "同じ名前のはず: {a:?} {b:?}");
        }
        for p in f["foldDiffer"].as_array().unwrap() {
            let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
            assert_ne!(names::fold_key(a), names::fold_key(b), "違う名前のはず: {a:?} {b:?}");
        }
        for p in f["newWorkBase"].as_array().unwrap() {
            let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
            assert_eq!(names::new_work_base(a).unwrap(), b, "新しい名前: {a:?}");
        }
        let l = &c["limits"];
        assert_eq!(l["readMaxBytes"].as_u64().unwrap(), ops::READ_MAX_BYTES);
        assert_eq!(l["nameMaxBytes"].as_u64().unwrap() as usize, names::NAME_MAX_BYTES);
        assert_eq!(l["tmpMarkMax"].as_u64().unwrap() as usize, names::TMP_MARK_MAX);
        assert_eq!(l["fileMaxBytes"].as_u64().unwrap() as usize, names::FILE_MAX_BYTES);
        let d = crate::pclib::mobile::Dirs::under("L".into(), std::path::Path::new("C"));
        assert_eq!(d.sessions, std::path::Path::new("C").join(c["dirs"]["sessions"].as_str().unwrap().replace('/', std::path::MAIN_SEPARATOR_STR)));
        assert_eq!(c["dirs"]["evac"].as_str().unwrap(), EVAC_DIR);
    }

    /// 反証: 表を 1 か所変えた写しは赤（名前・欄・断る値・封筒・形）。突き合わせが黙っていないこと
    #[test]
    fn mutated_contract_is_caught() {
        let base = contract();
        // 命令の名前
        let mut m = base.clone();
        m["commands"][2]["name"] = Value::String("mobile_read_works".into());
        let names: Vec<String> = m["commands"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
        assert_ne!(names, handler_names());
        // 引数の欄（destAlbum → dest_album）
        let mut a = base["commands"][6]["args"].clone();
        let v = a.as_object_mut().unwrap().remove("destAlbum").unwrap();
        a["dest_album"] = v;
        assert!(rt::<MoveWorkArgs>(&a).is_err());
        // 断る値
        let mut r = strs(&base["refusals"]);
        r.push("x".into());
        assert_ne!(r, code::ALL.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // 封筒の 1 バイト
        let mut h = base["envelope"]["hex"].as_str().unwrap().to_string();
        h.replace_range(0..2, "55");
        let e = &base["envelope"];
        let got = crate::pack_autosave_payload(&e["meta"], std::path::Path::new(e["path"].as_str().unwrap()), &unhex(e["dataHex"].as_str().unwrap()));
        assert_ne!(hex::encode(got), h);
        // 型の欄（SaveResult に 1 つ足す）
        let mut t = strs(&base["types"]["SaveResult"]);
        t.push("path".into());
        t.sort();
        assert_ne!(t, ser_keys(&SaveResult { fingerprint: Fingerprint::of_bytes(b""), album: "".into(), name: "".into(), ours_moved: false, kept_copies: vec![], record_left: false }));
    }
}
