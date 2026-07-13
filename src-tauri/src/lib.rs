use enigo::{Enigo, Settings};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct AppShortcutState {
    current: Arc<Mutex<String>>,
}

/// 診断ログへの書き込みを直列化するための排他制御。
/// オーバーレイウィンドウと設定ウィンドウから並行して invoke されうるため必要。
struct DiagLogState {
    mutex: Mutex<()>,
}

/// Rust発行tokenで所有者を管理し、旧録音の遅延unmuteが新録音へ干渉しないようにする。
/// MutexはOSのmute操作も含めて直列化するが、フロント側は期限付きで待つため
/// COM障害が録音ライフサイクル自体を停止させることはない。
#[derive(Default)]
struct SystemAudioMuteState {
    next_token: AtomicU64,
    lease: Arc<Mutex<SystemAudioMuteLease>>,
}

#[derive(Default, Debug, PartialEq, Eq)]
struct SystemAudioMuteLease {
    highest_seen_token: u64,
    owner: Option<u64>,
    released: HashSet<u64>,
}

fn update_mute_owner(
    lease: &mut SystemAudioMuteLease,
    lease_id: u64,
    mute: bool,
) -> bool {
    if mute {
        if lease_id >= lease.highest_seen_token && !lease.released.contains(&lease_id) {
            lease.highest_seen_token = lease_id;
            lease.owner = Some(lease_id);
        }
    } else {
        lease.highest_seen_token = lease.highest_seen_token.max(lease_id);
        lease.released.insert(lease_id);
        if lease.owner.is_some_and(|owner| owner <= lease_id) {
            lease.owner = None;
        }
    }
    // highest_seenより古いtombstoneは今後のacquireが世代比較で必ず拒否されるため不要。
    lease
        .released
        .retain(|released| *released >= lease.highest_seen_token);
    // stale/重複commandでも現在のdesired状態をOSへ再適用し、失敗後の再試行を可能にする。
    lease.owner.is_some()
}

#[cfg(test)]
mod mute_owner_tests {
    use super::{update_mute_owner, SystemAudioMuteLease};

    #[test]
    fn stale_release_cannot_unmute_a_new_attempt() {
        let mut lease = SystemAudioMuteLease::default();
        assert!(update_mute_owner(&mut lease, 1, true));
        assert!(update_mute_owner(&mut lease, 2, true));
        assert!(update_mute_owner(&mut lease, 1, false));
        assert_eq!(lease.owner, Some(2));
        assert!(!update_mute_owner(&mut lease, 2, false));
        assert!(!update_mute_owner(&mut lease, 2, false));
        assert_eq!(lease.owner, None);
    }

    #[test]
    fn out_of_order_commands_cannot_resurrect_an_old_mute() {
        let mut lease = SystemAudioMuteLease::default();
        assert!(!update_mute_owner(&mut lease, 2, false));
        assert!(!update_mute_owner(&mut lease, 1, true));
        assert!(!update_mute_owner(&mut lease, 2, true));
        assert_eq!(lease.owner, None);

        assert!(update_mute_owner(&mut lease, 3, true));
        assert_eq!(lease.owner, Some(3));
    }

    #[test]
    fn newer_release_clears_an_orphaned_old_owner() {
        let mut lease = SystemAudioMuteLease::default();
        assert!(update_mute_owner(&mut lease, 1, true));
        assert!(!update_mute_owner(&mut lease, 2, false));
        assert_eq!(lease.owner, None);

        assert!(update_mute_owner(&mut lease, 3, true));
        assert!(update_mute_owner(&mut lease, 2, false));
        assert_eq!(lease.owner, Some(3));
        assert!(lease.released.len() <= 1);
    }
}

/// 診断ログのパス。履歴ログと同じ `logs/` フォルダ直下。
/// `cleanup_old_logs` は `is_dir()` ガードで個別ファイルを除外するため衝突しない。
fn diag_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs")
        .join("freevoice.log"))
}

/// chrono 非依存で JST（UTC+9、DST なし固定オフセット）の ISO8601（ミリ秒精度）を返す。
/// 例: "2026-04-10T19:23:45.123+09:00"
fn format_iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    const JST_OFFSET_SECS: i64 = 9 * 3600;
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64 + JST_OFFSET_SECS;
    let millis = dur.subsec_millis();

    // Unix 秒 → 年月日時分秒（JST、Gregorian）
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let hour = (time_of_day / 3600) as u32;
    let minute = ((time_of_day % 3600) / 60) as u32;
    let second = (time_of_day % 60) as u32;

    // 1970-01-01 からの経過日数を年月日に変換
    // アルゴリズム: Howard Hinnant "date algorithms"
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}+09:00",
        y, m, d, hour, minute, second, millis
    )
}

/// Rust 内部から診断ログに書き込む。setup() や Tauri コマンドから呼び出す。
/// 失敗は伝播せず Err を返すだけ（呼び出し側でログ出力は無視してよい）。
fn write_diag_log_internal(
    app: &AppHandle,
    level: &str,
    source: &str,
    message: &str,
    phase: Option<&str>,
    context: Option<&str>,
) -> Result<(), String> {
    let state = app.state::<DiagLogState>();
    let _guard = state
        .mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let path = diag_log_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // ローテーション: 1MB 超で .old に rename（既存 .old は上書き）
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= 1_000_000 {
            let old = path.with_file_name("freevoice.log.old");
            let _ = std::fs::rename(&path, &old);
        }
    }

    let ts = format_iso8601_now();
    // phase は録音制御 status。設定ウィンドウ等では None だが、[phase] [source] の
    // ブラケット位置を固定するため "-" で埋める（省略すると [source] だけが残り、
    // phase と source のどちらのブラケットか判別できなくなるため）。
    let phase_prefix = format!("[{}] ", phase.unwrap_or("-"));
    let line = match context {
        Some(ctx) => format!("{} {} {}[{}] {} | {}\n", ts, level, phase_prefix, source, message, ctx),
        None => format!("{} {} {}[{}] {}\n", ts, level, phase_prefix, source, message),
    };

    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn append_diag_log(
    app: AppHandle,
    level: String,
    source: String,
    message: String,
    phase: Option<String>,
    context: Option<String>,
) -> Result<(), String> {
    write_diag_log_internal(&app, &level, &source, &message, phase.as_deref(), context.as_deref())
}

/// Rust 内部用のログヘルパ。`write_diag_log_internal` の失敗は診断情報なので握り潰す。
fn diag_log(app: &AppHandle, level: &str, source: &str, message: &str) {
    let _ = write_diag_log_internal(app, level, source, message, None, None);
}

/// エラー情報付きで診断ログを記録する。`err` の文字列を JSON 風の `{"error":"..."}` に整形。
fn diag_log_err(
    app: &AppHandle,
    level: &str,
    source: &str,
    message: &str,
    err: impl std::fmt::Display,
) {
    let ctx = format!("{{\"error\":{:?}}}", err.to_string());
    let _ = write_diag_log_internal(app, level, source, message, None, Some(&ctx));
}

/// CloseHandle が必要な実ハンドルだけを所有する。GetCurrentProcess の擬似ハンドルには使わない。
#[cfg(target_os = "windows")]
struct OwnedWinHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for OwnedWinHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// プロセストークンの Mandatory Integrity Level RID を返す。
/// RID の大小比較にすることで、FreeVoice 自身を管理者実行した場合も正しく扱える。
#[cfg(target_os = "windows")]
fn process_integrity_level(process: windows_sys::Win32::Foundation::HANDLE) -> Result<u32, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(format!(
                "OpenProcessToken failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let token = OwnedWinHandle(token);

        let mut required_len = 0u32;
        GetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            null_mut(),
            0,
            &mut required_len,
        );
        if required_len < size_of::<TOKEN_MANDATORY_LABEL>() as u32 {
            return Err(format!(
                "GetTokenInformation(size) failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        // Vec<u8> の alignment は1なので、ポインタを構造体へcastせずusizeで整列を保証する。
        let word_size = size_of::<usize>();
        let word_count = (required_len as usize).div_ceil(word_size);
        let mut buffer = vec![0usize; word_count];
        let buffer_len = (buffer.len() * word_size) as u32;
        if GetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast::<c_void>(),
            buffer_len,
            &mut required_len,
        ) == 0
        {
            return Err(format!(
                "GetTokenInformation(data) failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let label = &*(buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>());
        let sid = label.Label.Sid;
        if sid.is_null() {
            return Err("TokenIntegrityLevel returned a null SID".to_string());
        }
        let count_ptr = GetSidSubAuthorityCount(sid);
        if count_ptr.is_null() || *count_ptr == 0 {
            return Err("integrity SID has no sub-authority".to_string());
        }
        let rid_ptr = GetSidSubAuthority(sid, (*count_ptr - 1) as u32);
        if rid_ptr.is_null() {
            return Err("failed to read integrity RID".to_string());
        }
        Ok(*rid_ptr)
    }
}

fn requires_toggle_stop(own_level: u32, foreground_level: u32) -> bool {
    foreground_level > own_level
}

#[cfg(test)]
mod integrity_level_tests {
    use super::requires_toggle_stop;

    #[test]
    fn toggles_only_for_a_higher_integrity_foreground() {
        assert!(requires_toggle_stop(0x2000, 0x3000));
        assert!(!requires_toggle_stop(0x3000, 0x3000));
        assert!(!requires_toggle_stop(0x3000, 0x2000));
    }
}

/// フォアグラウンドプロセスの整合性レベルが FreeVoice より高い場合だけ、
/// Released を信用せず再押下停止へ切り替える。
#[cfg(target_os = "windows")]
fn foreground_requires_toggle_stop() -> Result<bool, String> {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Ok(false);
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return Ok(false);
        }

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(format!(
                "OpenProcess(pid={pid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let process = OwnedWinHandle(process);

        let own_level = process_integrity_level(GetCurrentProcess())?;
        let foreground_level = process_integrity_level(process.0)?;
        Ok(requires_toggle_stop(own_level, foreground_level))
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_requires_toggle_stop() -> Result<bool, String> {
    Ok(false)
}

/// 初期登録とショートカット変更後で同一のイベント処理を使う。
fn handle_shortcut_event(app: &AppHandle, state: ShortcutState) {
    match state {
        ShortcutState::Pressed => {
            let toggle_stop = match foreground_requires_toggle_stop() {
                Ok(value) => value,
                Err(e) => {
                    // 判定不能を高権限と断定すると通常環境の操作を変えうるため、通常PTTを維持する。
                    diag_log_err(
                        app,
                        "WARN",
                        "shortcut.integrity",
                        "foreground integrity detection failed; using hold mode",
                        e,
                    );
                    false
                }
            };
            if toggle_stop {
                diag_log(
                    app,
                    "INFO",
                    "shortcut.integrity",
                    "higher-integrity foreground detected; using toggle stop",
                );
            }
            if let Err(e) = app.emit(
                "recording-start",
                serde_json::json!({ "toggleStop": toggle_stop }),
            ) {
                diag_log_err(
                    app,
                    "ERROR",
                    "shortcut.press",
                    "emit recording-start failed",
                    e,
                );
            }
        }
        ShortcutState::Released => {
            if let Err(e) = app.emit("recording-stop", ()) {
                diag_log_err(
                    app,
                    "ERROR",
                    "shortcut.release",
                    "emit recording-stop failed",
                    e,
                );
            }
        }
    }
}

/// WebView の fetch() は LangSmith の OTLP エンドポイントの CORS で阻まれる
/// 可能性があるため Rust 側から送る。失敗は JS 側で握り潰す前提。
#[tauri::command]
async fn post_langsmith_trace(
    endpoint: String,
    api_key: String,
    project: String,
    body: String,
) -> Result<(), String> {
    static LANGSMITH_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = LANGSMITH_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest client for LangSmith")
    });

    let res = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("Langsmith-Project", project)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("langsmith {}: {}", status.as_u16(), snippet));
    }
    Ok(())
}

#[tauri::command]
async fn paste_text(text: String, method: String) -> Result<(), String> {
    std::thread::spawn(move || {
        if method == "keystroke" {
            use enigo::Keyboard;
            let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
            enigo.text(&text).map_err(|e| e.to_string())
        } else {
            use enigo::{Direction, Keyboard, Key};

            // クリップボードにテキストをセット
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(&text).map_err(|e| e.to_string())?;

            // クリップボードが確実にセットされるまで待機
            std::thread::sleep(std::time::Duration::from_millis(50));

            // Ctrl+V を送信
            let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
            enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
            enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
            enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;

            Ok(())
        }
    })
    .join()
    .map_err(|_| "スレッドパニック".to_string())?
}

/// フォアグラウンドウィンドウの識別情報を返す。
/// `id` はウィンドウハンドル（hwnd）を数値化した文字列で、同一アプリの別ウィンドウも
/// 一意に区別できる安定キー。`exe`/`title` は人間可読・ログ用。
/// 取得できない場合は各フィールドを空文字で返す（呼び出し側で「スコープなし」と扱う）。
#[tauri::command]
fn get_foreground_window() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HWND};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        };

        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_null() {
                return Ok(serde_json::json!({ "id": "", "exe": "", "title": "" }));
            }

            // id: hwnd ポインタを数値文字列化（ウィンドウ識別キー）
            let id = (hwnd as isize).to_string();

            // タイトル取得
            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
            let title = if len > 0 {
                String::from_utf16_lossy(&title_buf[..len as usize])
            } else {
                String::new()
            };

            // exe 名（basename）取得
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let exe = if pid != 0 {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    String::new()
                } else {
                    let mut path_buf = [0u16; 1024];
                    let mut size = path_buf.len() as u32;
                    let ok = QueryFullProcessImageNameW(handle, 0, path_buf.as_mut_ptr(), &mut size);
                    CloseHandle(handle);
                    if ok != 0 && size > 0 {
                        let full = String::from_utf16_lossy(&path_buf[..size as usize]);
                        full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string()
                    } else {
                        String::new()
                    }
                }
            } else {
                String::new()
            };

            Ok(serde_json::json!({ "id": id, "exe": exe, "title": title }))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "id": "", "exe": "", "title": "" }))
    }
}

#[tauri::command]
fn set_click_through(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = hwnd.0 as HWND;
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex_style | WS_EX_TRANSPARENT as isize | WS_EX_LAYERED as isize,
            );
        }
    }
    let _ = window;
    Ok(())
}

#[tauri::command]
fn position_overlay(window: WebviewWindow) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Ok(());
    }

    // カーソル位置からアクティブモニターを特定（物理座標で比較）
    let active = if let Ok(cursor) = window.cursor_position() {
        monitors.iter().find(|m| {
            let pos = m.position();
            let size = m.size();
            cursor.x >= pos.x as f64
                && cursor.x < (pos.x + size.width as i32) as f64
                && cursor.y >= pos.y as f64
                && cursor.y < (pos.y + size.height as i32) as f64
        })
    } else {
        None
    };

    // フォールバック: カーソル不明 → 最初のモニター
    let monitor = active.or_else(|| monitors.first());

    if let Some(monitor) = monitor {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let win_width = 600.0_f64;
        let win_height = 200.0_f64;
        // モニター中央下部に配置（物理座標）
        let x = pos.x as f64 + size.width as f64 / 2.0 - win_width * scale / 2.0;
        let y = pos.y as f64 + size.height as f64 - (win_height + 60.0) * scale;
        window
            .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_log(folder: String, filename: String, content: String) -> Result<(), String> {
    let dir = std::path::Path::new(&folder);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&filename), content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn cleanup_old_logs(folder: String, keep_days: u64) -> Result<(), String> {
    let dir = std::path::Path::new(&folder);
    if !dir.exists() {
        return Ok(());
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(keep_days * 24 * 60 * 60);
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // YYYY-MM-DD 形式のフォルダのみ対象
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.len() != 10 || !name.chars().nth(4).is_some_and(|c| c == '-') {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn read_logs(folder: String, limit: usize) -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&folder);
    if !dir.exists() {
        return Ok(vec![]);
    }
    // 日付フォルダを降順で走査
    let mut date_dirs: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    date_dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    let mut results = Vec::new();
    for date_dir in date_dirs {
        if results.len() >= limit {
            break;
        }
        let mut files: Vec<_> = std::fs::read_dir(date_dir.path())
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|ext| ext == "json")
            })
            .collect();
        files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        for file in files {
            if results.len() >= limit {
                break;
            }
            if let Ok(content) = std::fs::read_to_string(file.path()) {
                results.push(content);
            }
        }
    }
    Ok(results)
}

/// デフォルトのログフォルダ（`{app_local_data_dir}/logs`）を返す。
fn default_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs"))
}

#[tauri::command]
fn get_app_log_dir(app: AppHandle) -> Result<String, String> {
    Ok(default_log_dir(&app)?.to_string_lossy().into_owned())
}

/// ログフォルダをエクスプローラーで開く。
/// `folder` が空（未設定）ならデフォルト（`{app_local_data_dir}/logs`）を開く。
#[tauri::command]
fn open_log_folder(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    let path = match folder {
        Some(f) if !f.trim().is_empty() => PathBuf::from(f.trim()),
        _ => default_log_dir(&app)?,
    };
    // 履歴がまだ無いと既定フォルダが存在しないため、開く前に作成する
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn update_shortcut(
    app: AppHandle,
    shortcut_state: tauri::State<'_, AppShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let old = shortcut_state.current.lock().unwrap().clone();
    app.global_shortcut()
        .unregister(old.as_str())
        .map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, event| {
            handle_shortcut_event(&app_handle, event.state());
        })
        .map_err(|e| e.to_string())?;

    *shortcut_state.current.lock().unwrap() = shortcut;
    diag_log(&app, "INFO", "shortcut.update", "shortcut changed");
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe fn set_mute_raw(mute: bool) -> Result<(), String> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::Audio::Endpoints::*;
    use windows::Win32::System::Com::*;

    let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
    let result = (|| {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        let volume: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;
        volume
            .SetMute(mute, std::ptr::null())
            .map_err(|e| e.to_string())
    })();
    if initialized {
        CoUninitialize();
    }
    result
}

#[tauri::command]
fn create_system_audio_mute_lease(
    state: tauri::State<'_, SystemAudioMuteState>,
) -> Result<u64, String> {
    let previous = state
        .next_token
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| "system audio mute lease token overflow".to_string())?;
    Ok(previous + 1)
}

#[tauri::command]
#[allow(unused_variables)]
async fn set_system_audio_mute(
    state: tauri::State<'_, SystemAudioMuteState>,
    lease_id: u64,
    mute: bool,
) -> Result<(), String> {
    let lease = Arc::clone(&state.lease);
    tauri::async_runtime::spawn_blocking(move || {
        // COM操作をblocking poolへ隔離する。MutexはOS操作まで保持してcommand順序を
        // 直列化するが、WebView/Tauriのイベント処理スレッドは停止させない。
        let mut lease = lease
            .lock()
            .map_err(|_| "system audio mute state was poisoned".to_string())?;
        let mute = update_mute_owner(&mut lease, lease_id, mute);
        #[cfg(target_os = "windows")]
        unsafe {
            set_mute_raw(mute)
        }
        #[cfg(not(target_os = "windows"))]
        Ok(())
    })
    .await
    .map_err(|e| format!("system audio mute task failed: {e}"))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppShortcutState {
            current: Arc::new(Mutex::new("Ctrl+Shift+Space".to_string())),
        })
        .manage(DiagLogState {
            mutex: Mutex::new(()),
        })
        .manage(SystemAudioMuteState::default())
        .setup(|app| {
            // パニックを最後の砦として診断ログに残す。windowed リリースビルドでは
            // stderr が見えないため、これが無いと Rust 側の異常終了は痕跡ゼロになる。
            let panic_app = app.handle().clone();
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let location = info
                    .location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_else(|| "unknown".to_string());
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                    .unwrap_or("(non-string panic payload)");
                diag_log_err(
                    &panic_app,
                    "ERROR",
                    "rust.panic",
                    &format!("panic at {location}"),
                    payload,
                );
                default_hook(info);
            }));

            // 起動マーカー（以降の記録が同一プロセスのものか判別するため）
            diag_log(app.handle(), "INFO", "app.setup", "startup");

            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "設定", true, None::<&str>)?;
            let open_logs_item = MenuItem::with_id(app, "open_logs", "ログを開く", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "再起動", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &open_logs_item, &restart_item, &quit])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "restart" => {
                        if let Err(e) = app.global_shortcut().unregister_all() {
                            diag_log_err(app, "WARN", "tray.restart", "unregister_all failed", e);
                        }
                        app.restart();
                    }
                    "quit" => app.exit(0),
                    "open_logs" => {
                        if let Err(e) = app.emit("open-log-folder", ()) {
                            diag_log_err(app, "WARN", "tray.open_logs", "emit failed", e);
                        }
                    }
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if let Err(e) = w.show() {
                                diag_log_err(app, "WARN", "tray.settings", "show failed", e);
                            }
                            if let Err(e) = w.set_focus() {
                                diag_log_err(app, "WARN", "tray.settings", "set_focus failed", e);
                            }
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if let Err(e) = w.show() {
                                diag_log_err(app, "WARN", "tray.doubleclick", "show failed", e);
                            }
                            if let Err(e) = w.set_focus() {
                                diag_log_err(app, "WARN", "tray.doubleclick", "set_focus failed", e);
                            }
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;

            // 設定画面を閉じたときは破棄せず非表示にする（2回目以降も開けるように）
            if let Some(main_win) = app.get_webview_window("main") {
                let main_win_clone = main_win.clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Err(e) = main_win_clone.hide() {
                            diag_log_err(
                                main_win_clone.app_handle(),
                                "WARN",
                                "main_win.close",
                                "hide failed",
                                e,
                            );
                        }
                    }
                });
            }

            let app_handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut("Ctrl+Shift+Space", move |_app, _shortcut, event| {
                    handle_shortcut_event(&app_handle, event.state());
                })?;

            // クラッシュ後の再起動時にミュートが残らないよう解除
            #[cfg(target_os = "windows")]
            let _ = unsafe { set_mute_raw(false) };

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            paste_text,
            get_foreground_window,
            set_click_through,
            position_overlay,
            update_shortcut,
            save_log,
            read_logs,
            get_app_log_dir,
            open_log_folder,
            cleanup_old_logs,
            create_system_audio_mute_lease,
            set_system_audio_mute,
            append_diag_log,
            post_langsmith_trace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FreeVoice");
}
