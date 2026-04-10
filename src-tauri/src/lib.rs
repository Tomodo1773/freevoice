use enigo::{Enigo, Settings};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

/// chrono 非依存で UTC の ISO8601（ミリ秒精度）を返す。
/// 例: "2026-04-10T10:23:45.123Z"
fn format_iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();

    // Unix 秒 → 年月日時分秒（UTC、Gregorian）
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
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
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
    let line = match context {
        Some(ctx) => format!("{} {} [{}] {} | {}\n", ts, level, source, message, ctx),
        None => format!("{} {} [{}] {}\n", ts, level, source, message),
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
    context: Option<String>,
) -> Result<(), String> {
    write_diag_log_internal(&app, &level, &source, &message, context.as_deref())
}

/// LangSmith の OTLP エンドポイントへ 1 span 分のトレースを POST する。
/// WebView の fetch() は CORS で阻まれる可能性があるため Rust 側から送る。
/// 失敗時はエラー文字列を返すが、呼び出し側（JS）で握り潰して本流に影響させない前提。
#[tauri::command]
async fn post_langsmith_trace(
    endpoint: String,
    api_key: String,
    project: String,
    body: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

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

#[tauri::command]
fn get_app_log_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("logs").to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
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
            match event.state() {
                ShortcutState::Pressed => {
                    if let Err(e) = app_handle.emit("recording-start", ()) {
                        let _ = write_diag_log_internal(
                            &app_handle,
                            "ERROR",
                            "shortcut.press",
                            "emit recording-start failed",
                            Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                        );
                    }
                }
                ShortcutState::Released => {
                    if let Err(e) = app_handle.emit("recording-stop", ()) {
                        let _ = write_diag_log_internal(
                            &app_handle,
                            "ERROR",
                            "shortcut.release",
                            "emit recording-stop failed",
                            Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                        );
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    *shortcut_state.current.lock().unwrap() = shortcut;
    let _ = write_diag_log_internal(
        &app,
        "INFO",
        "shortcut.update",
        "shortcut changed",
        None,
    );
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe fn set_mute_raw(mute: bool) -> Result<(), String> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::Audio::Endpoints::*;
    use windows::Win32::System::Com::*;

    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| e.to_string())?;
    let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
    volume
        .SetMute(mute, std::ptr::null())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(unused_variables)]
fn set_system_audio_mute(mute: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        set_mute_raw(mute)
    }
    #[cfg(not(target_os = "windows"))]
    Ok(())
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
        .setup(|app| {
            // 起動マーカー（以降の記録が同一プロセスのものか判別するため）
            let handle = app.handle().clone();
            let _ = write_diag_log_internal(&handle, "INFO", "app.setup", "startup", None);

            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "設定", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "再起動", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &restart_item, &quit])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "restart" => {
                        if let Err(e) = app.global_shortcut().unregister_all() {
                            let _ = write_diag_log_internal(
                                app,
                                "WARN",
                                "tray.restart",
                                "unregister_all failed",
                                Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                            );
                        }
                        app.restart();
                    }
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if let Err(e) = w.show() {
                                let _ = write_diag_log_internal(
                                    app,
                                    "WARN",
                                    "tray.settings",
                                    "show failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
                            }
                            if let Err(e) = w.set_focus() {
                                let _ = write_diag_log_internal(
                                    app,
                                    "WARN",
                                    "tray.settings",
                                    "set_focus failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
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
                                let _ = write_diag_log_internal(
                                    app,
                                    "WARN",
                                    "tray.doubleclick",
                                    "show failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
                            }
                            if let Err(e) = w.set_focus() {
                                let _ = write_diag_log_internal(
                                    app,
                                    "WARN",
                                    "tray.doubleclick",
                                    "set_focus failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
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
                let app_for_close = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Err(e) = main_win_clone.hide() {
                            let _ = write_diag_log_internal(
                                &app_for_close,
                                "WARN",
                                "main_win.close",
                                "hide failed",
                                Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                            );
                        }
                    }
                });
            }

            let app_handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut("Ctrl+Shift+Space", move |_app, _shortcut, event| {
                    match event.state() {
                        ShortcutState::Pressed => {
                            if let Err(e) = app_handle.emit("recording-start", ()) {
                                let _ = write_diag_log_internal(
                                    &app_handle,
                                    "ERROR",
                                    "shortcut.press",
                                    "emit recording-start failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
                            }
                        }
                        ShortcutState::Released => {
                            if let Err(e) = app_handle.emit("recording-stop", ()) {
                                let _ = write_diag_log_internal(
                                    &app_handle,
                                    "ERROR",
                                    "shortcut.release",
                                    "emit recording-stop failed",
                                    Some(&format!("{{\"error\":{:?}}}", e.to_string())),
                                );
                            }
                        }
                    }
                })?;

            // クラッシュ後の再起動時にミュートが残らないよう解除
            #[cfg(target_os = "windows")]
            let _ = unsafe { set_mute_raw(false) };

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            paste_text,
            set_click_through,
            position_overlay,
            update_shortcut,
            save_log,
            read_logs,
            get_app_log_dir,
            cleanup_old_logs,
            set_system_audio_mute,
            append_diag_log,
            post_langsmith_trace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FreeVoice");
}
