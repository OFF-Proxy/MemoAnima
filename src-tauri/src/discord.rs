//! V193 (A-95): Discord にプレイ状況を表示する（Rich Presence）。要件は `docs/REQ_discord_rpc.md`。
//!
//! - 相手は**手元の Discord アプリだけ**（Windows は名前付きパイプ `\\?\pipe\discord-ipc-N`・
//!   Mac は `$TMPDIR/discord-ipc-N` の UNIX ソケット）。**このアプリ自身はインターネットへ出ない**
//! - 渡すのは [`activity_json`] の 4 つだけ（大きい絵・その説明・固定の 1 文・起動時刻）。
//!   作品名・ファイル名・アルバム名・パスを**受け取る口が無い**（`COLLAB_PROTOCOL` §1-b 例外 2・W-10）
//! - 接続を持つのは**専用のスレッド 1 本だけ**（[`worker`]）。フロントからの命令はチャンネルに積むだけで、
//!   呼んだ側は 1 回も待たない。つなぎ直しは**オンの間だけ** 30 秒に 1 回
//! - ★失敗はすべてここで握りつぶす。理由は `&'static str`（決まった短い語）だけで、表へは出さない。
//!   ヘッダの長さを信じて確保しない（[`MAX_FRAME`]）・返事は上限つきで待つ・終了で待つのも上限つき・
//!   スレッドの中の panic は `catch_unwind` で止める（本体へ伝えない）
//!
//! 部品（crate）は使っていない。第一候補の `discord-rich-presence` 1.1.0 は、受け取ったヘッダの長さを
//! そのまま確保する（最大 4 GiB・確保の失敗は panic ではなく abort＝アプリごと落ちる）・読み書きに
//! 上限が無い・返事を読まない、の 3 点で「失敗はすべて握りつぶす」を守れない（報告書 §1）。
//! このファイルは **std と serde_json だけ**で閉じている——`scripts/v193_smoke.ts` が別の小さな crate から
//! `#[path]` でこのファイルをそのまま読み込み、偽の Discord を相手に動かす。

use serde_json::{json, Value};
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Discord の Application ID（Developer Portal の「メモアニマ(MemoAnima)」・作者 2026-10-04）。
/// 秘密の値ではない（クライアント ID）。**この定数 1 か所だけ**に書く（v193_smoke [S-2]）
const DISCORD_APP_ID: &str = "1550992426779410472";
/// Art Assets に上げた絵の名前と、その上に出る説明（全言語共通＝製品名）
const LARGE_IMAGE: &str = "memoanima_icon_1024";
const LARGE_TEXT: &str = "メモアニマ";
/// 手元の Discord アプリの受け口の名前（`discord-ipc-0`〜`9` を順に探す）
const IPC_PREFIX: &str = "discord-ipc-";

/// つなぎ直しの間隔。**オンの間だけ**（オフの間は 1 回も試さない）
const RETRY_INTERVAL: Duration = Duration::from_secs(30);
/// つながっている間、届いた返事を読み捨てて「切れていないか」を見る間隔（読むだけ・書かない）
const WATCH_INTERVAL: Duration = Duration::from_secs(5);
/// 握手の返事を待つ上限（返事をしない相手に、このスレッドを預けっぱなしにしない）
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// 終了のとき、表示を消し終わるのを待つ上限（過ぎたら待たずに終わる＝終了を遅らせない）
pub const EXIT_WAIT: Duration = Duration::from_millis(500);
/// 切る前に「消した」の返事を待つ上限（このスレッドの中だけ・EXIT_WAIT より短く）
const CLOSE_WAIT: Duration = Duration::from_millis(300);
/// 1 通の上限。ヘッダが名乗る長さ（最大 4 GiB）を**そのまま信じて確保しない**
const MAX_FRAME: usize = 64 * 1024;
/// 1 回の見張りで読み捨てる上限（相手が流し続けても、ここで止まり続けない）
const DRAIN_MAX: usize = 64;
/// details の上限（Discord の決まり 2〜128 文字）
const DETAILS_MAX: usize = 128;

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

// ---------------- 渡す中身（純関数） ----------------

/// ★Discord に渡す activity。**これが全部**（v193_smoke [S-1]）。
/// 引数は固定の 1 文（`clean_details` を通したもの）と起動時刻だけ＝作品の情報が入る道が無い
pub fn activity_json(details: Option<&str>, start: u64) -> Value {
    let mut a = json!({
        "timestamps": { "start": start },
        "assets": { "large_image": LARGE_IMAGE, "large_text": LARGE_TEXT },
    });
    if let (Some(d), Some(m)) = (details, a.as_object_mut()) {
        m.insert("details".to_string(), Value::from(d));
    }
    a
}

/// SET_ACTIVITY の封筒（`activity` が None なら表示を消す）。
/// pid は Discord が表示をこのプロセスに結び付けるのに使う（アプリが終われば Discord 側でも消える）
pub fn set_activity_payload(activity: Option<Value>, pid: u32, nonce: u64) -> Value {
    json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": pid, "activity": activity },
        "nonce": nonce.to_string(),
    })
}

/// 握手（最初の 1 通）
pub fn handshake_payload(app_id: &str) -> Value {
    json!({ "v": 1, "client_id": app_id })
}

/// フロントから来た 1 文を整える（念のための網）。制御文字を落とし、128 文字で切る。
/// **パスに見えるもの（`\` `/`）・短すぎるものは使わない**（None ＝ details を出さない＝アプリ名と経過時間だけ）
pub fn clean_details(s: &str) -> Option<String> {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = t.trim();
    if t.contains('\\') || t.contains('/') {
        return None;
    }
    let t: String = t.chars().take(DETAILS_MAX).collect();
    if t.chars().count() < 2 {
        return None;
    }
    Some(t)
}

// ---------------- 枠（ヘッダ 8 バイト＝op・長さ〔どちらも LE〕＋ JSON） ----------------

pub fn encode_frame(op: u32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

#[derive(Debug, PartialEq)]
pub enum FrameError {
    TooLong,
    NotUtf8,
    NotJson,
}

/// 溜めた分から 1 通取り出す（足りなければ `Ok(None)`）。
/// ★名乗る長さが上限を超えたら、**確保もせず待ちもせず** Err（ゴミを送る相手で落ちない・止まらない）
pub fn take_frame(buf: &mut Vec<u8>) -> Result<Option<(u32, Value)>, FrameError> {
    if buf.len() < 8 {
        return Ok(None);
    }
    let op = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let len = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLong);
    }
    if buf.len() < 8 + len {
        return Ok(None);
    }
    let body: Vec<u8> = buf.drain(..8 + len).skip(8).collect();
    let text = std::str::from_utf8(&body).map_err(|_| FrameError::NotUtf8)?;
    let v = serde_json::from_str(text).map_err(|_| FrameError::NotJson)?;
    Ok(Some((op, v)))
}

// ---------------- 受け口との読み書き（OS ごとの `sys::Conn` が実装する。単体テストは偽物を渡す） ----------------

trait Wire {
    fn send_all(&mut self, b: &[u8]) -> io::Result<()>;
    /// いま届いている分だけ `out` に足す（`cap` まで）。待たない。相手が閉じていたら Err。
    /// ★Err のときも、それまでに読めた分は `out` に足してあることがある（返事と閉じが 1 回の読みで
    /// 同時に届いたとき）。読み手の [`Session::next`] はそれを先に取り出す（A-102）
    fn read_ready(&mut self, out: &mut Vec<u8>, cap: usize) -> io::Result<()>;
}

/// 非ブロッキングの読み（unix の受け口が使う）。届いている分を `cap` まで読み、相手が閉じていたら Err。
/// ★閉じを見る前に読めた分は `out` に**足したまま** Err を返す——Mac では断りの返事と閉じが同時に届き、
/// 1 回の呼び出しの中で「返事を読む → 閉じを見る」になる（A-102。Linux では閉じが少し遅れて次の呼び出しになる）。
/// OS によらずコンパイルして、単体テストで偽のソケットを相手に動かす（Windows の受け口は使わない）
#[cfg_attr(not(unix), allow(dead_code))]
fn read_nonblocking(s: &mut impl Read, out: &mut Vec<u8>, cap: usize) -> io::Result<()> {
    let mut buf = [0u8; 4096];
    let mut total = 0usize;
    while total < cap {
        let want = buf.len().min(cap - total);
        match s.read(&mut buf[..want]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                total += n;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

// ---------------- 受け口（OS ごと）。どれも「待たない」か「上限つき」 ----------------

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};

    #[link(name = "kernel32")]
    extern "system" {
        // namedpipeapi.h。読む前に「いま読める量」を聞く＝ReadFile の中で止まらない
        fn PeekNamedPipe(
            pipe: *mut c_void,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_avail: *mut u32,
            bytes_left: *mut u32,
        ) -> i32;
    }

    /// winnt.h の SECURITY_IDENTIFICATION（SecurityIdentification << 16）。名前付きパイプを開くとき、
    /// 相手（サーバー側）がこちらの権限を**借りられない**ようにする（std の `security_qos_flags` の文書どおり）
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

    pub struct Conn(File);

    /// 開くだけ。Discord が居ない・塞がっているときは**すぐ** Err（待たない）
    pub fn open(path: &Path) -> io::Result<Conn> {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(path)
            .map(Conn)
    }

    impl super::Wire for Conn {
        fn send_all(&mut self, b: &[u8]) -> io::Result<()> {
            self.0.write_all(b)
        }

        /// いま届いている分だけ読む（`cap` まで）。待たない。相手が閉じていたら Err。
        /// 1 回の呼び出しは「読めた分を足して Ok」か「何も足さずに Err」のどちらか。相手（サーバー側）が
        /// 閉じても、届いていた分は先に読める（`PeekNamedPipe` が量を返す）＝閉じは**次の**呼び出しで Err になる
        fn read_ready(&mut self, out: &mut Vec<u8>, cap: usize) -> io::Result<()> {
            let mut avail: u32 = 0;
            // SAFETY: 自分が持つ開いたハンドルと、書き先 1 つ（avail）だけを渡す。ほかは NULL（受け取らない）
            let ok = unsafe {
                PeekNamedPipe(
                    self.0.as_raw_handle() as *mut c_void,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut avail,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let n = (avail as usize).min(cap);
            if n == 0 {
                return Ok(());
            }
            let start = out.len();
            out.resize(start + n, 0);
            // n は届いている量以下なので、ここでは止まらない
            let got = match self.0.read(&mut out[start..]) {
                Ok(g) => g,
                Err(e) => {
                    // 0 で埋めた分を残さない（A-102 から `Session::next` は Err のあとも溜まった分を読むため）
                    out.truncate(start);
                    return Err(e);
                }
            };
            out.truncate(start + got);
            if got == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            Ok(())
        }
    }

    pub fn endpoints(prefix: &str, _dirs: Option<&[PathBuf]>) -> Vec<PathBuf> {
        (0..10).map(|i| PathBuf::from(format!(r"\\?\pipe\{prefix}{i}"))).collect()
    }
}

#[cfg(unix)]
mod sys {
    use std::io::{self, Write};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    pub struct Conn(UnixStream);

    /// 開くだけ。Discord が居ないときは**すぐ** Err。書き込みにも上限を付ける（相手が詰まっても預けっぱなしにしない）
    pub fn open(path: &Path) -> io::Result<Conn> {
        let s = UnixStream::connect(path)?;
        s.set_write_timeout(Some(Duration::from_secs(2)))?;
        Ok(Conn(s))
    }

    impl super::Wire for Conn {
        fn send_all(&mut self, b: &[u8]) -> io::Result<()> {
            self.0.write_all(b)
        }

        /// いま届いている分だけ読む（`cap` まで）。待たない。相手が閉じていたら Err
        /// （読めた分は足したまま＝[`super::read_nonblocking`]）
        fn read_ready(&mut self, out: &mut Vec<u8>, cap: usize) -> io::Result<()> {
            self.0.set_nonblocking(true)?;
            let r = super::read_nonblocking(&mut self.0, out, cap);
            let _ = self.0.set_nonblocking(false);
            r
        }
    }

    /// Mac は `$TMPDIR/discord-ipc-N`。念のため XDG_RUNTIME_DIR・TMP・TEMP・temp_dir()・/tmp も同じ順に見る
    pub fn endpoints(prefix: &str, dirs: Option<&[PathBuf]>) -> Vec<PathBuf> {
        let mut base: Vec<PathBuf> = Vec::new();
        match dirs {
            Some(d) => base.extend(d.iter().cloned()),
            None => {
                for k in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
                    if let Some(v) = std::env::var_os(k) {
                        base.push(PathBuf::from(v));
                    }
                }
                base.push(std::env::temp_dir());
                base.push(PathBuf::from("/tmp"));
            }
        }
        let mut uniq: Vec<PathBuf> = Vec::new();
        for b in base {
            if !uniq.contains(&b) {
                uniq.push(b);
            }
        }
        let mut out = Vec::new();
        for b in &uniq {
            for i in 0..10 {
                out.push(b.join(format!("{prefix}{i}")));
            }
        }
        out
    }
}

/// 受け口の一覧（`prefix` は本番 `discord-ipc-`。検査は別の名前を渡す＝本物の Discord に触れない）
pub fn endpoints(prefix: &str, dirs: Option<&[PathBuf]>) -> Vec<PathBuf> {
    sys::endpoints(prefix, dirs)
}

// ---------------- 1 本の接続 ----------------

/// `C` は本番では OS ごとの [`sys::Conn`]。単体テストは偽の接続を渡す（Mac の「返事と閉じが同時」を Windows でも作る）
struct Session<C = sys::Conn> {
    conn: C,
    buf: Vec<u8>,
    nonce: u64,
    /// 読みが相手の閉じを見た（A-102）。`buf` に溜まった返事を渡し切ってから "closed" を返す
    closed: bool,
}

impl Session {
    /// 手元の Discord につないで握手する。返事は `reply_timeout` まで待つ（待つのはこのスレッドだけ）
    fn open(endpoints: &[PathBuf], app_id: &str, reply_timeout: Duration) -> Result<Session, &'static str> {
        let conn = endpoints.iter().find_map(|p| sys::open(p).ok()).ok_or("no ipc")?;
        let mut s = Session::new(conn);
        s.send(OP_HANDSHAKE, &handshake_payload(app_id))?;
        let deadline = Instant::now().checked_add(reply_timeout).unwrap_or_else(Instant::now);
        wait_ready(&mut s, deadline)?;
        Ok(s)
    }
}

impl<C: Wire> Session<C> {
    fn new(conn: C) -> Session<C> {
        Session { conn, buf: Vec::new(), nonce: 0, closed: false }
    }

    fn send(&mut self, op: u32, v: &Value) -> Result<(), &'static str> {
        self.conn.send_all(&encode_frame(op, v)).map_err(|_| "write")
    }

    /// 届いている分から 1 通（待たない）。切れていたら・壊れた物が来たら Err。
    /// ★A-102: 読みが相手の閉じを見ても、**その読みで届いていた返事を先に渡す**（断るとき Discord は返事
    /// 〔op 2・code 4000〕を送ってすぐ閉じる。Mac では 2 つが 1 回の読みで同時に届き、前は返事ごと捨てて
    /// 「closed」と記録していた）。閉じは、溜まった返事を渡し切ったあとの呼び出しで "closed" として伝える
    fn next(&mut self) -> Result<Option<(u32, Value)>, &'static str> {
        let mut got = take_frame(&mut self.buf);
        if matches!(got, Ok(None)) && !self.closed {
            if self.conn.read_ready(&mut self.buf, MAX_FRAME + 8).is_err() {
                self.closed = true;
            }
            got = take_frame(&mut self.buf);
        }
        match got {
            Ok(Some(f)) => Ok(Some(f)),
            // 閉じたあとに残った切れ端・ゴミは読まない（理由は今までどおり "closed"）
            _ if self.closed => Err("closed"),
            Ok(None) => Ok(None),
            Err(_) => Err("garbage"),
        }
    }

    /// 表示を出す（`activity` は [`activity_json`] の出力）
    fn show(&mut self, activity: Value) -> Result<(), &'static str> {
        self.nonce += 1;
        let p = set_activity_payload(Some(activity), std::process::id(), self.nonce);
        self.send(OP_FRAME, &p)
    }

    /// 届いた返事を読み捨てる（溜めない）。切れていたら Err
    fn drain(&mut self) -> Result<(), &'static str> {
        for _ in 0..DRAIN_MAX {
            match self.next()? {
                None => return Ok(()),
                Some((OP_PING, v)) => self.send(OP_PONG, &v)?,
                Some((OP_CLOSE, _)) => return Err("closed"),
                Some(_) => {}
            }
        }
        Ok(())
    }

    /// 表示を消して切る。「消した」の返事を **CLOSE_WAIT まで**待ってから閉じる
    /// （送った直後に閉じると、相手が読む前に切れて「消す」が届かないことがある——V193 の検査で実際に見た）。
    /// 失敗しても構わない（どのみち閉じる。閉じれば Discord 側でも消える）
    fn close(mut self) {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        if self.send(OP_FRAME, &set_activity_payload(None, std::process::id(), self.nonce)).is_ok() {
            let deadline = Instant::now().checked_add(CLOSE_WAIT).unwrap_or_else(Instant::now);
            while Instant::now() < deadline {
                match self.next() {
                    Ok(Some((OP_FRAME, v))) if v["nonce"] == nonce.as_str() => break,
                    Ok(Some(_)) => {}
                    Ok(None) => thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
        }
        let _ = self.send(OP_CLOSE, &json!({}));
    }
}

/// 握手の返事を待つ所だけを接続から切り離す口（期限の扱いを単体テストで確かめるため）
trait FrameIo {
    fn next_frame(&mut self) -> Result<Option<(u32, Value)>, &'static str>;
    fn send_frame(&mut self, op: u32, v: &Value) -> Result<(), &'static str>;
}

impl<C: Wire> FrameIo for Session<C> {
    fn next_frame(&mut self) -> Result<Option<(u32, Value)>, &'static str> {
        self.next()
    }
    fn send_frame(&mut self, op: u32, v: &Value) -> Result<(), &'static str> {
        self.send(op, v)
    }
}

/// 握手の返事（READY）を待つ。**期限は毎回見る**＝READY 以外を流し続ける相手でも、ここで抜ける（空回りしない・レビュー指摘）
fn wait_ready(io: &mut impl FrameIo, deadline: Instant) -> Result<(), &'static str> {
    loop {
        if Instant::now() >= deadline {
            return Err("no reply");
        }
        match io.next_frame()? {
            Some((OP_FRAME, v)) if v["evt"] == "READY" => return Ok(()),
            Some((OP_FRAME, v)) if v["evt"] == "ERROR" => return Err("rejected"),
            Some((OP_CLOSE, _)) => return Err("rejected"),
            Some((OP_PING, v)) => io.send_frame(OP_PONG, &v)?,
            Some(_) => {}
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
}

// ---------------- 専用のスレッド ----------------

pub struct Config {
    pub app_id: String,
    pub endpoints: Vec<PathBuf>,
    pub retry: Duration,
    pub watch: Duration,
    pub reply_timeout: Duration,
    /// 起動時刻（秒・UNIX 時刻）＝ timestamps.start
    pub start: u64,
    /// ログ 1 行（「つながった／つながらなかった／切れた／切った」だけ・作品名もパスも渡さない）
    pub log: Box<dyn Fn(&str) + Send>,
}

pub enum Cmd {
    Set { enabled: bool, details: String },
    Exit(Sender<()>),
}

/// 接続を持つスレッドへの口。送るだけ（待たない）
pub struct Presence {
    tx: Sender<Cmd>,
}

impl Presence {
    /// 専用のスレッドを 1 本立てる。立てられなければ、何もしない口が返る（送っても誰も受け取らない）
    pub fn spawn(cfg: Config) -> Presence {
        let (tx, rx) = mpsc::channel();
        let _ = thread::Builder::new().name("discord-presence".into()).spawn(move || {
            // スレッドの中で何が起きても本体へ伝えない
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || worker(rx, cfg)));
        });
        Presence { tx }
    }

    pub fn set(&self, enabled: bool, details: String) {
        let _ = self.tx.send(Cmd::Set { enabled, details });
    }

    /// 表示を消して切るよう頼み、**`wait` まで**待つ（スレッドが止まっていても、それ以上は待たない）
    pub fn shutdown(&self, wait: Duration) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(Cmd::Exit(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(wait);
        }
    }
}

/// 溜まっている命令は**最後の 1 つだけ**見る（⚙ を素早く何度も押しても、押した数だけつなぎ直さない。
/// 本物の Discord は返事に数秒かかることがあり、1 つずつ片付けると列が伸びる——V193 の開発ビルドの確認で実際に見た）。
/// 終了は最優先（見つけたらそこで止める）
fn latest(first: Cmd, rx: &Receiver<Cmd>) -> Cmd {
    let mut m = first;
    while !matches!(m, Cmd::Exit(_)) {
        match rx.try_recv() {
            Ok(next) => m = next,
            Err(_) => break,
        }
    }
    m
}

fn worker(rx: Receiver<Cmd>, cfg: Config) {
    let log = |s: &str| (cfg.log)(s);
    let mut enabled = false;
    let mut details: Option<String> = None;
    let mut session: Option<Session> = None;
    let mut last_try: Option<Instant> = None;
    // つながらない理由は、変わったときだけ書く（30 秒ごとに同じ行を積まない）
    let mut last_fail: Option<&'static str> = None;
    loop {
        // オフの間は命令が来るまで眠る（つなぎ直さない）。オンでつながっていれば見張り、いなければ次の試し
        let wait = if !enabled {
            None
        } else if session.is_some() {
            Some(cfg.watch)
        } else {
            Some(match last_try {
                Some(t) => cfg.retry.saturating_sub(t.elapsed()),
                None => Duration::ZERO,
            })
        };
        let msg = match wait {
            None => match rx.recv() {
                Ok(m) => Some(latest(m, &rx)),
                Err(_) => break, // 送り手が居なくなった＝アプリが終わる
            },
            Some(d) => match rx.recv_timeout(d) {
                Ok(m) => Some(latest(m, &rx)),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
        };
        match msg {
            Some(Cmd::Set { enabled: on, details: d }) => {
                let d = clean_details(&d);
                if !on {
                    // ⚙ でオフ → その場で消して切る
                    if let Some(s) = session.take() {
                        s.close();
                        log("[discord] closed");
                    }
                    enabled = false;
                    details = d;
                    continue;
                }
                let turning_on = !enabled;
                let changed = details != d;
                enabled = true;
                details = d;
                if turning_on {
                    // オンにした＝その場でつなぐ（30 秒を待たない）
                    last_try = None;
                    last_fail = None;
                } else if changed {
                    // 表示の言語を変えた → 新しい 1 文で出し直す
                    let failed = match session.as_mut() {
                        Some(s) => s.show(activity_json(details.as_deref(), cfg.start)).is_err(),
                        None => false,
                    };
                    if failed {
                        session = None;
                        log("[discord] disconnected: write");
                    }
                }
            }
            Some(Cmd::Exit(ack)) => {
                if let Some(s) = session.take() {
                    s.close();
                    log("[discord] closed");
                }
                let _ = ack.send(());
                break;
            }
            None => {}
        }
        if !enabled {
            continue;
        }
        // つながっている: 届いた返事を読み捨てる（溜めない）・切れていないかを見る
        if session.is_some() {
            let lost = session.as_mut().and_then(|s| s.drain().err());
            match lost {
                None => continue,
                Some(why) => {
                    session = None;
                    log(&format!("[discord] disconnected: {why}"));
                }
            }
        }
        // つなぐ（間隔に 1 回まで）
        if let Some(t) = last_try {
            if t.elapsed() < cfg.retry {
                continue;
            }
        }
        last_try = Some(Instant::now());
        let opened = Session::open(&cfg.endpoints, &cfg.app_id, cfg.reply_timeout)
            .and_then(|mut s| s.show(activity_json(details.as_deref(), cfg.start)).map(|_| s));
        match opened {
            Ok(s) => {
                session = Some(s);
                last_fail = None;
                log("[discord] connected");
            }
            Err(why) => {
                if last_fail != Some(why) {
                    last_fail = Some(why);
                    log(&format!("[discord] not connected: {why}"));
                }
            }
        }
    }
}

// ---------------- 本体から使う口（lib.rs） ----------------

static STARTED_AT: OnceLock<u64> = OnceLock::new();
static LOGGER: OnceLock<Box<dyn Fn(&str) + Send + Sync>> = OnceLock::new();
static PRESENCE: OnceLock<Presence> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 起動時刻を覚える（`run()` の頭で 1 回・通信しない）
pub fn note_start() {
    let _ = STARTED_AT.set(now_secs());
}

/// ログの書き先を渡す（setup で 1 回・覚えるだけ）
pub fn set_logger(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = LOGGER.set(Box::new(f));
}

/// 受け口の名前。**開発ビルド（debug）だけ**、環境変数 `MEMOANIMA_DISCORD_IPC_PREFIX` で差し替えられる
/// （自動の確認で本物の Discord につながないため・V193 の確認の途中で作者の Discord が起動されて実際につながった）。
/// 配布物（release）はこの環境変数を読まない＝常に `discord-ipc-`
fn ipc_prefix() -> String {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("MEMOANIMA_DISCORD_IPC_PREFIX") {
        if !p.is_empty() {
            return p.to_string_lossy().into_owned();
        }
    }
    IPC_PREFIX.to_string()
}

/// 本番の設定（検査の harness も同じ関数から作り、受け口と間隔だけ差し替える）
pub fn default_config(log: Box<dyn Fn(&str) + Send>) -> Config {
    Config {
        app_id: DISCORD_APP_ID.to_string(),
        endpoints: endpoints(&ipc_prefix(), None),
        retry: RETRY_INTERVAL,
        watch: WATCH_INTERVAL,
        reply_timeout: REPLY_TIMEOUT,
        start: STARTED_AT.get().copied().unwrap_or_else(now_secs),
        log,
    }
}

fn spawn_default() -> Presence {
    Presence::spawn(default_config(Box::new(|line: &str| {
        if let Some(f) = LOGGER.get() {
            f(line);
        }
    })))
}

/// フロント（起動時・⚙・言語の切り替え）から `discord_presence_set` 経由で呼ぶ。**チャンネルに積むだけ**＝待たない。
/// オフのまま呼ばれたときはスレッドを立てない（オフの人には Discord の処理が 1 つも走らない）
pub fn set(enabled: bool, details: String) {
    let p = if enabled { Some(PRESENCE.get_or_init(spawn_default)) } else { PRESENCE.get() };
    if let Some(p) = p {
        p.set(enabled, details);
    }
}

/// 終了時（`RunEvent::Exit`）。表示を消して切るよう頼む。待つのは [`EXIT_WAIT`] まで
pub fn shutdown() {
    if let Some(p) = PRESENCE.get() {
        p.shutdown(EXIT_WAIT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 決まった種の xorshift（外の crate を使わない）
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    fn leaves(v: &Value, pre: &str, out: &mut Vec<String>) {
        match v.as_object() {
            Some(m) => {
                for (k, x) in m {
                    let p = if pre.is_empty() { k.clone() } else { format!("{pre}.{k}") };
                    leaves(x, &p, out);
                }
            }
            None => out.push(pre.to_string()),
        }
    }

    #[test]
    fn frame_roundtrip_and_partial() {
        let f = encode_frame(1, &json!({"a": 1, "b": "パラパラ"}));
        for cut in 0..f.len() {
            let mut b = f[..cut].to_vec();
            assert_eq!(take_frame(&mut b), Ok(None), "途中まで（{cut}）で取り出せてしまう");
        }
        let mut b = f.clone();
        b.extend_from_slice(&encode_frame(4, &json!([1, 2])));
        assert_eq!(take_frame(&mut b), Ok(Some((1, json!({"a": 1, "b": "パラパラ"})))));
        assert_eq!(take_frame(&mut b), Ok(Some((4, json!([1, 2])))));
        assert!(b.is_empty());
    }

    #[test]
    fn frame_too_long_is_refused_without_waiting() {
        for len in [MAX_FRAME as u32 + 1, 0x7fff_ffff, u32::MAX] {
            let mut b = Vec::new();
            b.extend_from_slice(&1u32.to_le_bytes());
            b.extend_from_slice(&len.to_le_bytes());
            assert_eq!(take_frame(&mut b), Err(FrameError::TooLong), "長さ {len}");
        }
        let mut b = encode_frame(1, &json!("x".repeat(MAX_FRAME - 2)));
        assert!(matches!(take_frame(&mut b), Ok(Some(_))), "ちょうど上限は通す");
    }

    #[test]
    fn frame_bad_utf8_and_json() {
        let mut b = vec![1, 0, 0, 0, 3, 0, 0, 0, 0xff, 0xfe, 0x80];
        assert_eq!(take_frame(&mut b), Err(FrameError::NotUtf8));
        let mut b = vec![1, 0, 0, 0, 5, 0, 0, 0];
        b.extend_from_slice(b"{nope");
        assert_eq!(take_frame(&mut b), Err(FrameError::NotJson));
        // 深い入れ子でも落ちない（serde_json の深さの上限で Err）
        let deep = "[".repeat(10_000);
        let mut b = Vec::new();
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&(deep.len() as u32).to_le_bytes());
        b.extend_from_slice(deep.as_bytes());
        assert_eq!(take_frame(&mut b), Err(FrameError::NotJson));
    }

    #[test]
    fn frame_garbage_never_panics() {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..20_000 {
            let n = (r.next() % 300) as usize;
            let mut b: Vec<u8> = (0..n).map(|_| r.next() as u8).collect();
            // 小さい長さを名乗るゴミも混ぜる
            if n >= 8 && r.next() % 2 == 0 {
                let l = (r.next() % 40) as u32;
                b[4..8].copy_from_slice(&l.to_le_bytes());
            }
            for _ in 0..50 {
                match take_frame(&mut b) {
                    Ok(Some(_)) => continue,
                    _ => break,
                }
            }
            assert!(b.len() <= 300);
        }
    }

    #[test]
    fn details_net() {
        assert_eq!(clean_details("パラパラアニメを描いています").as_deref(), Some("パラパラアニメを描いています"));
        assert_eq!(clean_details("  Drawing a flipbook animation \n").as_deref(), Some("Drawing a flipbook animation"));
        assert_eq!(clean_details("a\u{7}b\u{0}c").as_deref(), Some("abc"));
        assert_eq!(clean_details(r"C:\Users\taro\MemoLib"), None);
        assert_eq!(clean_details("/Users/taro/Library"), None);
        assert_eq!(clean_details("x"), None);
        assert_eq!(clean_details(""), None);
        assert_eq!(clean_details(&"あ".repeat(400)).map(|s| s.chars().count()), Some(DETAILS_MAX));
    }

    #[test]
    fn activity_has_only_four_leaves() {
        let mut l = Vec::new();
        leaves(&activity_json(Some("パラパラアニメを描いています"), 1_759_500_000), "", &mut l);
        l.sort();
        assert_eq!(l, ["assets.large_image", "assets.large_text", "details", "timestamps.start"]);
        let mut l = Vec::new();
        leaves(&activity_json(None, 1), "", &mut l);
        l.sort();
        assert_eq!(l, ["assets.large_image", "assets.large_text", "timestamps.start"]);
        let a = activity_json(Some("ab"), 7);
        assert_eq!(a["assets"]["large_image"], LARGE_IMAGE);
        assert_eq!(a["assets"]["large_text"], LARGE_TEXT);
        assert_eq!(a["timestamps"]["start"], 7);
    }

    #[test]
    fn handshake_and_envelope() {
        assert_eq!(handshake_payload(DISCORD_APP_ID), json!({ "v": 1, "client_id": DISCORD_APP_ID }));
        let p = set_activity_payload(Some(activity_json(Some("ab"), 1)), 42, 3);
        let mut k: Vec<&String> = p.as_object().map(|m| m.keys().collect()).unwrap_or_default();
        k.sort();
        assert_eq!(k, ["args", "cmd", "nonce"]);
        assert_eq!(p["args"]["pid"], 42);
        assert!(set_activity_payload(None, 42, 4)["args"]["activity"].is_null());
    }

    /// 決まった順に返す偽の相手。並びを使い切ったら `rest` を返し続ける（2 秒たったら諦めて Err＝テストが終わらないことは無い）
    struct Script {
        frames: Vec<Option<(u32, Value)>>,
        rest: Option<(u32, Value)>,
        sent: Vec<u32>,
        started: Instant,
    }
    impl FrameIo for Script {
        fn next_frame(&mut self) -> Result<Option<(u32, Value)>, &'static str> {
            if self.started.elapsed() > Duration::from_secs(2) {
                return Err("test gave up");
            }
            if self.frames.is_empty() {
                return Ok(self.rest.clone());
            }
            Ok(self.frames.remove(0))
        }
        fn send_frame(&mut self, op: u32, _v: &Value) -> Result<(), &'static str> {
            self.sent.push(op);
            Ok(())
        }
    }
    fn script(frames: Vec<Option<(u32, Value)>>, rest: Option<(u32, Value)>) -> Script {
        Script { frames, rest, sent: Vec::new(), started: Instant::now() }
    }

    #[test]
    fn handshake_deadline_holds_even_when_flooded() {
        // READY 以外を途切れなく返し続ける相手: 期限（50 ms）で「no reply」になる（空回りしない）
        let mut s = script(vec![], Some((OP_FRAME, json!({ "evt": "NOISE" }))));
        let t = Instant::now();
        assert_eq!(wait_ready(&mut s, t + Duration::from_millis(50)), Err("no reply"));
        assert!(t.elapsed() < Duration::from_millis(500), "期限を過ぎても抜けない（{:?}）", t.elapsed());
        // 何も来ない相手も同じ
        let mut s = script(vec![], None);
        assert_eq!(wait_ready(&mut s, Instant::now() + Duration::from_millis(50)), Err("no reply"));
        // PING には PONG・READY で成功
        let ready = Some((OP_FRAME, json!({ "cmd": "DISPATCH", "evt": "READY" })));
        let mut s = script(vec![None, Some((OP_PING, json!({ "x": 1 }))), ready.clone()], None);
        assert_eq!(wait_ready(&mut s, Instant::now() + Duration::from_secs(1)), Ok(()));
        assert_eq!(s.sent, [OP_PONG]);
        // 断られる（ERROR・CLOSE）
        let mut s = script(vec![Some((OP_FRAME, json!({ "evt": "ERROR" })))], None);
        assert_eq!(wait_ready(&mut s, Instant::now() + Duration::from_secs(1)), Err("rejected"));
        let mut s = script(vec![Some((OP_CLOSE, json!({ "code": 4000 })))], None);
        assert_eq!(wait_ready(&mut s, Instant::now() + Duration::from_secs(1)), Err("rejected"));
    }

    #[test]
    fn presence_without_discord_never_waits() {
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let mut cfg = default_config(Box::new(move |s: &str| {
            if let Ok(mut v) = l2.lock() {
                v.push(s.to_string());
            }
        }));
        cfg.endpoints = endpoints(&format!("memoanima-v193-test-{}-none-", std::process::id()), None);
        cfg.retry = Duration::from_millis(50);
        let p = Presence::spawn(cfg);
        for i in 0..40 {
            let t = Instant::now();
            p.set(i % 3 != 0, "パラパラアニメを描いています".into());
            assert!(t.elapsed() < Duration::from_millis(30), "set が待たせた");
        }
        thread::sleep(Duration::from_millis(200));
        let t = Instant::now();
        p.shutdown(EXIT_WAIT);
        assert!(t.elapsed() < EXIT_WAIT + Duration::from_millis(300), "shutdown が待たせた");
        let v = lines.lock().map(|v| v.clone()).unwrap_or_default();
        assert!(v.iter().all(|s| s.starts_with("[discord] ")), "{v:?}");
        assert!(!v.iter().any(|s| s == "[discord] connected"), "{v:?}");
    }

    // ---- A-102: 返事と閉じが 1 回の読みで同時に届く（作者の Mac の v193_smoke [S-4] reject が赤） ----

    /// 届く順を決めた偽のソケット。非ブロッキングの読みと同じ返り方をする
    /// （来ていなければ WouldBlock・閉じたら Ok(0) がずっと続く）
    enum Arrive {
        Bytes(Vec<u8>),
        Nothing,
        Eof,
    }
    struct FakeSock(Vec<Arrive>);
    impl Read for FakeSock {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            match self.0.first_mut() {
                None => Err(io::ErrorKind::WouldBlock.into()),
                Some(Arrive::Eof) => Ok(0),
                Some(Arrive::Nothing) => {
                    self.0.remove(0);
                    Err(io::ErrorKind::WouldBlock.into())
                }
                Some(Arrive::Bytes(v)) => {
                    let n = v.len().min(b.len());
                    b[..n].copy_from_slice(&v[..n]);
                    v.drain(..n);
                    if v.is_empty() {
                        self.0.remove(0);
                    }
                    Ok(n)
                }
            }
        }
    }
    /// unix の受け口と同じ読み方（[`read_nonblocking`]）をする偽の接続。送った枠は op だけ覚える
    struct UnixLike {
        sock: FakeSock,
        sent: Vec<u32>,
    }
    impl Wire for UnixLike {
        fn send_all(&mut self, b: &[u8]) -> io::Result<()> {
            self.sent.push(u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
            Ok(())
        }
        fn read_ready(&mut self, out: &mut Vec<u8>, cap: usize) -> io::Result<()> {
            read_nonblocking(&mut self.sock, out, cap)
        }
    }
    fn unix_like(arrive: Vec<Arrive>) -> Session<UnixLike> {
        Session::new(UnixLike { sock: FakeSock(arrive), sent: Vec::new() })
    }
    /// 断られたときに Discord が返すもの（v193_smoke の偽の Discord の "reject" と同じ）
    fn reject_frame() -> Vec<u8> {
        encode_frame(OP_CLOSE, &json!({ "code": 4000, "message": "Invalid Client ID" }))
    }
    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(1)
    }

    #[test]
    fn reply_and_close_in_one_read_is_rejected_not_closed() {
        // 前提（Mac の形）: 1 回の読みが返事を out に足したあとで閉じを見て Err を返す
        let mut sock = FakeSock(vec![Arrive::Bytes(reject_frame()), Arrive::Eof]);
        let mut out = Vec::new();
        assert!(read_nonblocking(&mut sock, &mut out, MAX_FRAME + 8).is_err());
        assert_eq!(out, reject_frame(), "返事のバイトは out に入っている");
        // ★断り（CLOSE・code 4000）と閉じが同時 → "rejected"（"closed" ではない）
        let mut s = unix_like(vec![Arrive::Bytes(reject_frame()), Arrive::Eof]);
        assert_eq!(wait_ready(&mut s, soon()), Err("rejected"));
        // ERROR の通知と閉じが同時でも同じ
        let err = encode_frame(OP_FRAME, &json!({ "cmd": "DISPATCH", "evt": "ERROR", "data": { "code": 4000 } }));
        let mut s = unix_like(vec![Arrive::Bytes(err), Arrive::Eof]);
        assert_eq!(wait_ready(&mut s, soon()), Err("rejected"));
        // Linux の形（閉じが次の読みで届く）は前から "rejected"
        let mut s = unix_like(vec![Arrive::Bytes(reject_frame()), Arrive::Nothing, Arrive::Eof]);
        assert_eq!(wait_ready(&mut s, soon()), Err("rejected"));
        // READY と閉じが同時なら、握手は通る（切れたことは次の読みで分かる）
        let ready = encode_frame(OP_FRAME, &json!({ "cmd": "DISPATCH", "evt": "READY" }));
        let mut s = unix_like(vec![Arrive::Bytes(ready), Arrive::Eof]);
        assert_eq!(wait_ready(&mut s, soon()), Ok(()));
        assert_eq!(s.next(), Err("closed"));
    }

    #[test]
    fn frames_before_close_are_delivered_then_closed() {
        // 2 通と閉じが 1 回の読みで届く → 2 通とも渡してから "closed"（そのあとは何度呼んでも "closed"）
        let mut both = encode_frame(OP_FRAME, &json!({ "nonce": "1" }));
        both.extend_from_slice(&encode_frame(OP_PING, &json!({ "x": 1 })));
        let mut s = unix_like(vec![Arrive::Bytes(both), Arrive::Eof]);
        assert_eq!(s.next(), Ok(Some((OP_FRAME, json!({ "nonce": "1" })))));
        assert_eq!(s.next(), Ok(Some((OP_PING, json!({ "x": 1 })))));
        assert_eq!(s.next(), Err("closed"));
        assert_eq!(s.next(), Err("closed"));
        // 閉じの前に届いた切れ端（1 通に満たない）・名乗る長さが上限を超えるゴミは読まない＝理由は今までどおり "closed"
        let f = reject_frame();
        let mut s = unix_like(vec![Arrive::Bytes(f[..f.len() - 1].to_vec()), Arrive::Eof]);
        assert_eq!(s.next(), Err("closed"));
        let mut huge = vec![1, 0, 0, 0];
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        let mut s = unix_like(vec![Arrive::Bytes(huge.clone()), Arrive::Eof]);
        assert_eq!(s.next(), Err("closed"));
        // 閉じていなければ今までどおり（ゴミは "garbage"・何も来なければ None・切れ端は待つ）
        let mut s = unix_like(vec![Arrive::Bytes(huge)]);
        assert_eq!(s.next(), Err("garbage"));
        let mut s = unix_like(vec![]);
        assert_eq!(s.next(), Ok(None));
        let mut s = unix_like(vec![Arrive::Bytes(f[..5].to_vec()), Arrive::Nothing, Arrive::Bytes(f[5..].to_vec())]);
        assert_eq!(s.next(), Ok(None));
        assert_eq!(s.next(), Ok(Some((OP_CLOSE, json!({ "code": 4000, "message": "Invalid Client ID" })))));
        // 閉じを 1 回しか伝えない接続でも、閉じたことを覚えている（2 回目の読みが Ok でも "closed"）
        struct CloseOnce(Option<Vec<u8>>);
        impl Wire for CloseOnce {
            fn send_all(&mut self, _b: &[u8]) -> io::Result<()> {
                Ok(())
            }
            fn read_ready(&mut self, out: &mut Vec<u8>, _cap: usize) -> io::Result<()> {
                match self.0.take() {
                    Some(b) => {
                        out.extend_from_slice(&b);
                        Err(io::ErrorKind::UnexpectedEof.into())
                    }
                    None => Ok(()),
                }
            }
        }
        let mut s = Session::new(CloseOnce(Some(encode_frame(OP_FRAME, &json!({ "a": 1 })))));
        assert_eq!(s.next(), Ok(Some((OP_FRAME, json!({ "a": 1 })))));
        assert_eq!(s.next(), Err("closed"));
    }

    #[test]
    fn drain_answers_ping_that_came_with_close() {
        // 見張りの読み捨て: PING と閉じが同時 → PONG を返してから "closed"（返事を捨てない）
        let mut s = unix_like(vec![Arrive::Bytes(encode_frame(OP_PING, &json!({ "x": 1 }))), Arrive::Eof]);
        assert_eq!(s.drain(), Err("closed"));
        assert_eq!(s.conn.sent, [OP_PONG]);
        // 断り（CLOSE）と閉じが同時 → "closed"（今までどおり。見張りでは CLOSE も閉じも「切れた」）
        let mut s = unix_like(vec![Arrive::Bytes(reject_frame()), Arrive::Eof]);
        assert_eq!(s.drain(), Err("closed"));
        // 何も来ていなければ Ok（読み捨てる物が無い）
        let mut s = unix_like(vec![Arrive::Bytes(encode_frame(OP_FRAME, &json!({ "nonce": "2" })))]);
        assert_eq!(s.drain(), Ok(()));
    }
}
