//! V220 (M-2b-1b・要件 docs/REQ_mobile_m2_editor.md §5-1 の 2・決-17・C5): **モバイルのログの口**（1 行足す）。
//!
//! ★置き場と回し方は [`super::log_line`] と同じ（`Dirs` の `logs`＝`app_config_dir/logs/memoanima.log`・1MB で回して 2 世代＝PC の
//!  `append_log_line`）。ファイル App から見えない所。取り出す道は書き出しと一緒に M-4。
//! ★Rust の側で、**制御文字と改行を落とす → 伏せる → 長さを切る** の順（[`clean`]）。切ってから伏せると、上限の境目にかかったパスが
//!  途中まで残る（伏せる字と一致しなくなる）ので、伏せてから切る。
//! ★伏せるもの: ライブラリ（`Dirs.lib`）と設定（`Dirs.config`）の置き場と、その 2 つの共通の親（入れ物の根＝iOS はアプリの
//!  コンテナ・Android はアプリのデータの根）。大小と区切り（`\` と `/`）の違いも拾う（PC の `redact_home` と同じ考え）。実の場所
//!  （`canonicalize`）が字と違うとき（シンボリックリンク・Windows の `\\?\`）は両方の字を伏せる。長いものから先に伏せる。
//!  入れ物の根は、深さが [`ROOT_MIN_DEPTH`] より浅いとき（`/`・`C:\`・`/data` のような誰のものでもない所）は伏せない（誤爆だけが増える）。
//! ★長さの上限は [`MAX_CHARS`] 字（文字の数・確かめ画面の記録は 200 字。こちらは例外の文などを 1 行で残すため少し長くした）。
//! ★作品名は呼ぶ側が渡さない（W-10・PC と同じ線引き）。ここは呼ぶ側が文面を決められないもの（例外の文）への保険。

use std::path::{Component, Path};

use super::{code, Dirs, Refusal};

/// 1 行の上限（文字の数）
pub const MAX_CHARS: usize = 300;

/// 入れ物の根を伏せるのは、ふつうの名前の段がこれ以上あるときだけ
pub const ROOT_MIN_DEPTH: usize = 3;

/// 伏せたあとの字
pub const LIB_MARK: &str = "<lib>";
pub const CONFIG_MARK: &str = "<config>";
pub const ROOT_MARK: &str = "<app>";

/// ログの口の引数（contract.json の mobile_log_append.args）
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogAppendArgs {
    pub line: String,
}

/// 2 つの場所の共通の親
fn common_parent(a: &Path, b: &Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for (x, y) in a.components().zip(b.components()) {
        if x != y {
            break;
        }
        out.push(x.as_os_str());
    }
    out
}

fn depth(p: &Path) -> usize {
    p.components().filter(|c| matches!(c, Component::Normal(_))).count()
}

/// 場所の字の形（そのまま・実の場所。Windows の `\\?\` は外す）
fn forms(p: &Path) -> Vec<String> {
    let mut v = vec![p.to_string_lossy().into_owned()];
    if let Ok(c) = p.canonicalize() {
        let s = c.to_string_lossy().into_owned();
        let s = s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s);
        v.push(s);
    }
    v.retain(|s| s.len() >= 4);
    v
}

/// `needle` を大小と区切りの違いを無視して全部 `mark` にする（PC の `redact_home` と同じ考え・区切りは両方の向きで探す）
pub fn redact_one(text: &str, needle: &str, mark: &str) -> String {
    if needle.len() < 4 {
        return text.to_string();
    }
    let mut out = text.to_string();
    for n in [needle.replace('\\', "/"), needle.replace('/', "\\")] {
        let ln = n.to_lowercase();
        let mut from = 0usize;
        loop {
            let lower = out.to_lowercase();
            if lower.len() != out.len() {
                // 小文字化で長さが変わる字が混ざると位置がずれる。字ごとに比べる遅い道で探す
                match find_fold(&out[from..], &n) {
                    Some((s, e)) => {
                        out.replace_range(from + s..from + e, mark);
                        from += s + mark.len();
                        continue;
                    }
                    None => break,
                }
            }
            let Some(rel) = lower[from..].find(&ln) else { break };
            let at = from + rel;
            let end = at + n.len();
            if !out.is_char_boundary(at) || !out.is_char_boundary(end) {
                break;
            }
            out.replace_range(at..end, mark);
            from = at + mark.len();
        }
    }
    out
}

/// 字ごとに大小を無視して比べる（小文字化で長さが変わる字が混ざったとき）。見つかった範囲（バイト）
fn find_fold(hay: &str, needle: &str) -> Option<(usize, usize)> {
    let nc: Vec<char> = needle.chars().flat_map(|c| c.to_lowercase()).collect();
    let idx: Vec<(usize, char)> = hay.char_indices().collect();
    'outer: for i in 0..idx.len() {
        let mut k = 0usize;
        let mut j = i;
        while k < nc.len() {
            if j >= idx.len() {
                continue 'outer;
            }
            for lc in idx[j].1.to_lowercase() {
                if k >= nc.len() || lc != nc[k] {
                    continue 'outer;
                }
                k += 1;
            }
            j += 1;
        }
        let end = if j < idx.len() { idx[j].0 } else { hay.len() };
        return Some((idx[i].0, end));
    }
    None
}

/// ★1 行にする: 制御文字と改行（行と段落の区切り U+2028・U+2029 も）を落とす → 置き場と入れ物の根を伏せる → 長さを切る
pub fn clean(d: &Dirs, line: &str) -> String {
    let flat: String = line.chars().filter(|c| !c.is_control() && *c != '\u{2028}' && *c != '\u{2029}').collect();
    let mut targets: Vec<(String, &str)> = Vec::new();
    for s in forms(&d.lib) {
        targets.push((s, LIB_MARK));
    }
    for s in forms(&d.config) {
        targets.push((s, CONFIG_MARK));
    }
    let lib_real = d.lib.canonicalize().unwrap_or_else(|_| d.lib.clone());
    let cfg_real = d.config.canonicalize().unwrap_or_else(|_| d.config.clone());
    for root in [common_parent(&d.lib, &d.config), common_parent(&lib_real, &cfg_real)] {
        if depth(&root) >= ROOT_MIN_DEPTH {
            for s in forms(&root) {
                targets.push((s, ROOT_MARK));
            }
        }
    }
    // 長いものから（ライブラリが入れ物の根の中にあるとき、先に根を伏せるとライブラリの字が残らないが、どれかが分からなくなる）
    targets.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    let mut out = flat;
    for (s, mark) in &targets {
        out = redact_one(&out, s, mark);
    }
    out.chars().take(MAX_CHARS).collect()
}

/// ★1 行足す（置き場と回し方は log_line と同じ）
pub fn append(d: &Dirs, line: &str) -> Result<(), Refusal> {
    let l = clean(d, line);
    std::fs::create_dir_all(&d.logs).map_err(|_| Refusal(code::IO))?;
    crate::append_log_line(&d.logs, &l).map_err(|_| Refusal(code::IO))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("v220-log-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    /// iOS の形: ライブラリは入れ物の根の Documents・設定は Library/Application Support の下
    fn ios_like(root: &Path) -> Dirs {
        let app = root.join("Containers").join("Data").join("Application").join("0A1B2C3D-UUID");
        let lib = app.join("Documents");
        let config = app.join("Library").join("Application Support").join("com.arcana.memoanima");
        fs::create_dir_all(&lib).unwrap();
        fs::create_dir_all(&config).unwrap();
        Dirs::under(lib, &config)
    }
    fn written(d: &Dirs) -> String {
        fs::read_to_string(d.logs.join("memoanima.log")).unwrap()
    }
    fn app_root(d: &Dirs) -> PathBuf {
        common_parent(&d.lib, &d.config)
    }

    /// ★ライブラリ・設定・入れ物の根のパスが残らない（大小・区切りの違いも）。改行を渡しても 1 行
    #[test]
    fn paths_never_reach_the_log() {
        let root = tmp("paths");
        let d = ios_like(&root);
        let lib = d.lib.to_string_lossy().into_owned();
        let cfg = d.config.to_string_lossy().into_owned();
        let app = app_root(&d).to_string_lossy().into_owned();
        let line = format!(
            "open failed {lib}/A/w.memoanima;\ncfg={cfg}\r\nroot={}{}tmp {} {}",
            app.to_uppercase(),
            std::path::MAIN_SEPARATOR,
            lib.replace('\\', "/"),
            cfg.replace('/', "\\")
        );
        append(&d, &line).unwrap();
        append(&d, "second\u{2028}line\u{0}x").unwrap();
        let s = written(&d);
        assert_eq!(s.lines().count(), 2, "改行で行が割れた: {s:?}");
        let low = s.to_lowercase().replace('\\', "/");
        for p in [&lib, &cfg, &app] {
            assert!(!low.contains(&p.to_lowercase().replace('\\', "/")), "パスが残った: {p}\n{s}");
        }
        // 入れ物の根の下の、根より上の段（UUID）も残らない
        assert!(!s.contains("0A1B2C3D-UUID") && !s.to_lowercase().contains("0a1b2c3d-uuid"), "{s}");
        assert!(s.contains(LIB_MARK) && s.contains(CONFIG_MARK) && s.contains(ROOT_MARK), "{s}");
        assert!(s.lines().nth(1).unwrap() == "secondlinex", "{s}");
        let _ = fs::remove_dir_all(&root);
    }

    /// ★上限の境目にパスがかかる行でも、パスの頭が残らない（伏せてから切る）。上限は MAX_CHARS 字
    #[test]
    fn path_at_the_cut_is_redacted_first() {
        let root = tmp("cut");
        let d = ios_like(&root);
        let lib = d.lib.to_string_lossy().into_owned();
        let app = app_root(&d).to_string_lossy().into_owned();
        for pad in 0..MAX_CHARS {
            let line = format!("{}{lib}{}", "a".repeat(pad), "z".repeat(10));
            let c = clean(&d, &line);
            assert!(c.chars().count() <= MAX_CHARS);
            // パスのどの頭も（4 字以上）残らない
            let low = c.to_lowercase().replace('\\', "/");
            let al = app.to_lowercase().replace('\\', "/");
            let tail_len = (MAX_CHARS.saturating_sub(pad)).min(al.len());
            if tail_len >= 8 {
                let head: String = al.chars().take(tail_len).collect();
                assert!(!low.contains(&head), "pad={pad}: パスの頭が残った: {c}");
            }
        }
        let long: String = "あ".repeat(MAX_CHARS + 50);
        assert_eq!(clean(&d, &long).chars().count(), MAX_CHARS);
        let _ = fs::remove_dir_all(&root);
    }

    /// 入れ物の根が浅い（誰のものでもない所）ときは、根を伏せない（ライブラリと設定は伏せる）
    #[test]
    fn shallow_root_is_not_redacted() {
        let d = Dirs::under(PathBuf::from("/data/lib"), Path::new("/data/cfg"));
        let c = clean(&d, "x /data/lib/a /data/cfg/b /data/other");
        assert_eq!(c, "x <lib>/a <config>/b /data/other");
    }

    /// 伏せ方: 大小と区切りの違い・小文字にすると長さが変わる字が混ざっても
    #[test]
    fn redact_one_folds_case_and_separators() {
        assert_eq!(redact_one(r"a Q:\Users\Me\x b", "q:/users/me", "<u>"), r"a <u>\x b");
        assert_eq!(redact_one("İ /Var/Mobile/x", "/var/mobile", "<u>"), "İ <u>/x");
        assert_eq!(redact_one("abc", "ab", "<u>"), "abc", "短すぎるものは伏せない");
    }
}
