//! V202 (§4-4 の 10): **置き換えない置き方**（宛先が在れば OS が断る rename）を 1 つの関数に。
//!
//! - Linux・Android: `renameat2` の `RENAME_NOREPLACE`／Apple（macOS・iOS）: `renamex_np` の `RENAME_EXCL`／
//!   Windows: `MoveFileExW` を置き換えの印（MOVEFILE_REPLACE_EXISTING）も別のボリュームへ写す印（MOVEFILE_COPY_ALLOWED）も付けずに
//! - 宛先が在れば `AlreadyExists` で断り、何も動かさない
//! - 使えないファイルシステム・版では、**置き換える rename に落とさずに** `Unsupported` で断る（`fs::rename` は宛先を黙って置き換える
//!   ので、この仕組みのどの道でも使わない）
//! - 別のボリュームへは動かさない（写して消すことはしない＝`CrossesDevices` で断る）
//! - ★V200 の「hard_link → 元を消す」（`create_from_tmp`）はモバイルでは使えない: Android はアプリにハードリンクを作らせない
//!   （AOSP の sepolicy `app_neverallows.te`「neverallow all_untrusted_apps file_type:file link」）。PC の `create_project` は変えない
//! - ⚠ Android の libc に `renameat2` の関数があるのは API 30 から → V212 (M-1c) で syscall で呼ぶ形にした（最小の API 29 の端末でも
//!   .so を読み込める）。Android の枝は V212 で `cargo check --target aarch64-linux-android`・`x86_64-linux-android` とエミュレーターで確かめた

use std::io;
use std::path::Path;

/// ★置き換えない置き方。宛先が在れば `AlreadyExists`・使えなければ `Unsupported`・別のボリュームなら `CrossesDevices`
pub fn place_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    os::place(from, to)
}

/// 退避先とライブラリが同じボリュームか（別なら何も動かす前に断る）
pub fn same_volume(a: &Path, b: &Path) -> io::Result<bool> {
    os::same_volume(a, b)
}

/// 空き容量（利用者が使える分・全体）のバイト数
pub fn free_space(p: &Path) -> io::Result<(u64, u64)> {
    os::free_space(p)
}

#[cfg(windows)]
mod os {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Path};

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }

    /// 長いパス（260 字を超える）でも通るように、ドライブから始まる絶対パスは `\\?\` を付ける（std の fs と同じ考え方）
    fn wide(p: &Path) -> Vec<u16> {
        let raw: Vec<u16> = p.as_os_str().encode_wide().collect();
        let bs = b'\\' as u16;
        let sl = b'/' as u16;
        let fix = |c: u16| if c == sl { bs } else { c };
        let mut v: Vec<u16> = Vec::with_capacity(raw.len() + 9);
        let verbatim = raw.len() >= 4 && raw[0] == bs && raw[1] == bs && raw[2] == b'?' as u16 && raw[3] == bs;
        let drive = raw.len() >= 3 && raw[1] == b':' as u16 && (raw[2] == bs || raw[2] == sl);
        let unc = !verbatim && raw.len() >= 2 && (raw[0] == bs || raw[0] == sl) && (raw[1] == bs || raw[1] == sl);
        if verbatim {
            v.extend_from_slice(&raw);
        } else if drive {
            v.extend("\\\\?\\".encode_utf16());
            v.extend(raw.iter().map(|&c| fix(c)));
        } else if unc {
            v.extend("\\\\?\\UNC\\".encode_utf16());
            v.extend(raw[2..].iter().map(|&c| fix(c)));
        } else {
            v.extend_from_slice(&raw);
        }
        v.push(0);
        v
    }

    pub fn place(from: &Path, to: &Path) -> io::Result<()> {
        let f = wide(from);
        let t = wide(to);
        // flags = 0: 置き換えない（宛先が在れば ERROR_ALREADY_EXISTS／ERROR_FILE_EXISTS＝AlreadyExists）・
        // 別のボリュームへ写さない（ERROR_NOT_SAME_DEVICE＝CrossesDevices）
        let ok = unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0) };
        if ok != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn same_volume(a: &Path, b: &Path) -> io::Result<bool> {
        let pa = a.canonicalize()?;
        let pb = b.canonicalize()?;
        let pre = |p: &Path| match p.components().next() {
            Some(Component::Prefix(x)) => x.as_os_str().to_string_lossy().to_ascii_lowercase(),
            _ => String::new(),
        };
        Ok(pre(&pa) == pre(&pb) && !pre(&pa).is_empty())
    }

    pub fn free_space(p: &Path) -> io::Result<(u64, u64)> {
        let w = wide(p);
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
        if ok != 0 {
            Ok((avail, total))
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(unix)]
mod unix_common {
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    pub fn cpath(p: &Path) -> io::Result<CString> {
        Ok(CString::new(p.as_os_str().as_bytes())?)
    }

    pub fn same_volume(a: &Path, b: &Path) -> io::Result<bool> {
        use std::os::unix::fs::MetadataExt;
        Ok(std::fs::metadata(a)?.dev() == std::fs::metadata(b)?.dev())
    }

    pub fn free_space(p: &Path) -> io::Result<(u64, u64)> {
        let c = cpath(p)?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::statvfs(c.as_ptr(), &mut s) };
        if r != 0 {
            return Err(io::Error::last_os_error());
        }
        let unit = s.f_frsize as u64;
        Ok((s.f_bavail as u64 * unit, s.f_blocks as u64 * unit))
    }
}

#[cfg(target_vendor = "apple")]
mod os {
    use std::io;
    use std::path::Path;

    pub use super::unix_common::{free_space, same_volume};

    pub fn place(from: &Path, to: &Path) -> io::Result<()> {
        let f = super::unix_common::cpath(from)?;
        let t = super::unix_common::cpath(to)?;
        // RENAME_EXCL: 宛先が在れば EEXIST（AlreadyExists）。使えないファイルシステムは ENOTSUP（Unsupported）
        let r = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
        if r == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(target_os = "android")]
mod os {
    use std::io;
    use std::path::Path;

    pub use super::unix_common::{free_space, same_volume};

    pub fn place(from: &Path, to: &Path) -> io::Result<()> {
        let f = super::unix_common::cpath(from)?;
        let t = super::unix_common::cpath(to)?;
        // V212 (M-1c): bionic の renameat2 の関数は API 30 から。関数で呼ぶと .so の未定義の記号に残り、API 29 の端末では読み込めない
        //  （ビルドは通る）。最小の API 29 のために、関数ではなく syscall で呼ぶ（Linux の枝と同じ）。.so に renameat2 が残らないことは
        //  台本（scripts/mobile_build.ts の checkSo）が llvm-readelf で見る。seccomp に止められると断りでなく SIGSYS で落ちるので、
        //  API 29 と 30 以上のエミュレーターで、アプリの中（確かめ画面の試験用のライブラリ）で確かめた（報告書 V212）。
        //  使えないファイルシステムは EINVAL・古いカーネルは ENOSYS → Unsupported にそろえる（置き換える rename には落とさない）
        let r = unsafe {
            libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), libc::RENAME_NOREPLACE)
        };
        if r == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EINVAL) || e.raw_os_error() == Some(libc::ENOSYS) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "RENAME_NOREPLACE unsupported"));
        }
        Err(e)
    }
}

#[cfg(target_os = "linux")]
mod os {
    use std::io;
    use std::path::Path;

    pub use super::unix_common::{free_space, same_volume};

    pub fn place(from: &Path, to: &Path) -> io::Result<()> {
        let f = super::unix_common::cpath(from)?;
        let t = super::unix_common::cpath(to)?;
        let r = unsafe {
            libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), libc::RENAME_NOREPLACE)
        };
        if r == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EINVAL) || e.raw_os_error() == Some(libc::ENOSYS) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "RENAME_NOREPLACE unsupported"));
        }
        Err(e)
    }
}

#[cfg(not(any(windows, target_vendor = "apple", target_os = "android", target_os = "linux")))]
mod os {
    use std::io;
    use std::path::Path;

    fn no() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, "no-replace rename unsupported")
    }
    pub fn place(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(no())
    }
    pub fn same_volume(_a: &Path, _b: &Path) -> io::Result<bool> {
        Err(no())
    }
    pub fn free_space(_p: &Path) -> io::Result<(u64, u64)> {
        Err(no())
    }
}
