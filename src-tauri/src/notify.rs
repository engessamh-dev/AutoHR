//! Windows notifications whose delivery the program can know.
//!
//! The notification plugin only queues a toast and never says whether Windows accepted it, and on
//! Windows it reports the permission as always granted. Document alerts must not be counted as
//! announced when Windows refused them, so here the toast is shown directly: first Windows is asked
//! whether this program may show notifications (the setting in «الإعدادات ← النظام ← الإشعارات»,
//! or a policy), then the toast is handed to Windows, and any refusal or failure is returned.

/// Shows a notification. `Err` carries why it was not accepted (refused or failed).
#[cfg(windows)]
pub fn show(identifier: &str, title: &str, body: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};
    // The installed program has its own AppUserModelID (its identifier); a development build
    // running from target\ has none and borrows PowerShell's, as the notification plugin does.
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.display().to_string())).unwrap_or_default();
    let installed = !(exe_dir.ends_with("\\target\\debug") || exe_dir.ends_with("\\target\\release"));
    let app_id = if installed { identifier.to_string() } else { tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string() };
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&app_id)).map_err(|e| e.to_string())?;
    // When Windows cannot say (for example an app ID it does not know yet), the toast is tried.
    if let Ok(setting) = notifier.Setting() {
        let refused = match setting {
            NotificationSetting::Enabled => None,
            NotificationSetting::DisabledForApplication => Some("notifications are turned off for this program in Windows"),
            NotificationSetting::DisabledForUser => Some("notifications are turned off for this Windows user"),
            NotificationSetting::DisabledByGroupPolicy => Some("notifications are turned off by a policy"),
            NotificationSetting::DisabledByManifest => Some("notifications are not allowed for this program"),
            _ => Some("Windows does not allow notifications"),
        };
        if let Some(reason) = refused {
            return Err(reason.to_string());
        }
    }
    tauri_winrt_notification::Toast::new(&app_id)
        .title(title)
        .text1(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn show(_identifier: &str, _title: &str, _body: &str) -> Result<(), String> {
    Err("notifications are shown on Windows only".into())
}
