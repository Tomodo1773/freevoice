//! 録音キャンセル用の Esc 低レベルキーボードフック（WH_KEYBOARD_LL）。
//!
//! CANCELABLE が true のとき、最初の Esc keydown で一度だけ `recording-cancel` を emit する。
//! 捕捉した物理入力は keyup まで消費し、それ以外は CallNextHookEx で素通しする。
//! フラグは録音ジョブ（recorder.ts）が処理に入るとき開き、finally で閉じる区間に対応する。
//! keydown 時に自動で disarm するため、フロントエンドが応答しなくても Esc を奪い続けない。
//! この自己解除があるので、フロント側の同期は投げっぱなしでよい（取りこぼしても最悪 Esc 1回）。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

static CANCELABLE: AtomicBool = AtomicBool::new(false);
/// FreeVoice が keydown を消費した物理 Esc。対応する keyup までリピートを含めて消費する。
static ESCAPE_CAPTURED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq)]
enum EscapeDecision {
    Pass,
    Consume,
    EmitCancel,
}

fn handle_escape_keydown() -> EscapeDecision {
    // 捕捉済みならキーリピート。消費するがキャンセルイベントは増やさない。
    if ESCAPE_CAPTURED.load(Ordering::SeqCst) {
        return EscapeDecision::Consume;
    }
    // 一度の物理入力につき一回だけ発火し、即座に disarm する。
    if CANCELABLE.swap(false, Ordering::SeqCst) {
        ESCAPE_CAPTURED.store(true, Ordering::SeqCst);
        return EscapeDecision::EmitCancel;
    }
    EscapeDecision::Pass
}

fn handle_escape_keyup() -> EscapeDecision {
    // armed は既に false でも、捕捉した keydown と対になる keyup は必ず消費する。
    if ESCAPE_CAPTURED.swap(false, Ordering::SeqCst) {
        EscapeDecision::Consume
    } else {
        EscapeDecision::Pass
    }
}

/// フロントエンドから同期される「Esc を消費してよいか」フラグ。
pub fn set_cancelable(cancelable: bool) {
    CANCELABLE.store(cancelable, Ordering::SeqCst);
}

/// フックを専用スレッドに常駐設置する。設置失敗はアプリを止めず診断ログに残すだけ
/// （キャンセル機能だけが使えない状態で継続する）。
#[cfg(target_os = "windows")]
pub fn install(app: AppHandle) {
    use std::sync::{mpsc::Sender, OnceLock};
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP,
    };

    static CANCEL_TX: OnceLock<Sender<()>> = OnceLock::new();

    // LL フックのコールバックはシステムのタイムアウト内に返す必要があるため、
    // Tauri へ直接 emit せず、専用スレッドへの通知だけを行う。
    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            // injected か否かは問わない。FreeVoice が合成するのは貼り付け（Ctrl+V／本文）だけで
            // Esc を送ることは無いため自家中毒の心配が無く、逆に除外すると スクリーンキーボードや
            // リモートデスクトップ経由の Esc だけキャンセルできなくなる。
            if kb.vkCode == VK_ESCAPE as u32 {
                let msg = wparam as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    match handle_escape_keydown() {
                        EscapeDecision::Pass => {}
                        EscapeDecision::Consume => return 1,
                        EscapeDecision::EmitCancel => {
                            if let Some(tx) = CANCEL_TX.get() {
                                let _ = tx.send(());
                            }
                            return 1;
                        }
                    }
                }
                if (msg == WM_KEYUP || msg == WM_SYSKEYUP)
                    && handle_escape_keyup() == EscapeDecision::Consume
                {
                    return 1;
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    // フックコールバックからTauriイベント配送を分離する。
    let (cancel_tx, cancel_rx) = std::sync::mpsc::channel();
    let _ = CANCEL_TX.set(cancel_tx);
    let event_app = app.clone();
    std::thread::spawn(move || {
        while cancel_rx.recv().is_ok() {
            if let Err(e) = event_app.emit("recording-cancel", ()) {
                crate::diag_log_err(
                    &event_app,
                    "ERROR",
                    "cancel_hook.emit",
                    "emit recording-cancel failed",
                    e,
                );
            }
        }
    });

    std::thread::spawn(move || unsafe {
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook),
            GetModuleHandleW(std::ptr::null()),
            0,
        );
        if hook.is_null() {
            let err = std::io::Error::last_os_error();
            crate::diag_log_err(
                &app,
                "ERROR",
                "cancel_hook.install",
                "SetWindowsHookExW failed",
                err,
            );
            return;
        }
        crate::diag_log(&app, "INFO", "cancel_hook.install", "esc hook installed");

        // LL フックはこのスレッドのメッセージループ経由で呼ばれるため、ポンプを回し続ける。
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn install(_app: AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_is_emitted_once_and_consumed_through_keyup() {
        CANCELABLE.store(false, Ordering::SeqCst);
        ESCAPE_CAPTURED.store(false, Ordering::SeqCst);

        assert_eq!(handle_escape_keydown(), EscapeDecision::Pass);
        assert_eq!(handle_escape_keyup(), EscapeDecision::Pass);

        set_cancelable(true);
        assert_eq!(handle_escape_keydown(), EscapeDecision::EmitCancel);
        assert!(!CANCELABLE.load(Ordering::SeqCst));
        assert_eq!(handle_escape_keydown(), EscapeDecision::Consume);
        assert_eq!(handle_escape_keyup(), EscapeDecision::Consume);
        assert_eq!(handle_escape_keydown(), EscapeDecision::Pass);

        // フロントエンドが先に disarm しても、捕捉済み入力の keyup は漏らさない。
        set_cancelable(true);
        assert_eq!(handle_escape_keydown(), EscapeDecision::EmitCancel);
        set_cancelable(false);
        assert_eq!(handle_escape_keyup(), EscapeDecision::Consume);
        assert_eq!(handle_escape_keyup(), EscapeDecision::Pass);
    }
}
