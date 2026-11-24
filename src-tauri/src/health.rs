//! «فحص البرنامج»: a read-only health check of the database, data and backup folders,
//! stored files, recent failures and recent technical errors, plus a plain-text report the user can send to support.
//!
//! Privacy rule: nothing here reads or reports employee names, numbers, document contents,
//! usernames or passwords. Only counts, statuses, versions and anonymised folder paths.
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::services::storage_path;

#[derive(Debug, Clone, Serialize)]
pub struct HealthItem {
    pub key: String,
    pub title: String,
    /// "ok", "warn", "fail" or "info".
    pub status: String,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub generated_at: String,
    pub app_version: String,
    /// The worst status of all items: "ok", "warn" or "fail".
    pub overall: String,
    pub items: Vec<HealthItem>,
    /// The exact text written to the diagnostic file.
    pub text: String,
}

fn item(key: &str, title: &str, status: &str, details: Vec<String>) -> HealthItem {
    HealthItem { key: key.into(), title: title.into(), status: status.into(), details }
}

/// Replaces the Windows profile folder and account name in a path so the report does not
/// carry the computer user's name.
pub fn anonymise_path(path: &Path) -> String {
    let mut text = path.to_string_lossy().into_owned();
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy().into_owned();
        if !home.is_empty() && text.get(..home.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(&home)) {
            text = format!("%USERPROFILE%{}", &text[home.len()..]);
        }
    }
    for var in ["USERNAME", "USER"] {
        if let Ok(name) = std::env::var(var) {
            if name.chars().count() >= 3 {
                text = text.replace(&name, "<user>");
            }
        }
    }
    text
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

fn count(conn: &Connection, sql: &str) -> Option<i64> {
    conn.query_row(sql, [], |r| r.get(0)).ok()
}

fn check_app(app_version: &str, updater_configured: bool) -> HealthItem {
    let build = if cfg!(debug_assertions) { "تطوير" } else { "إصدار نهائي" };
    let mut details = vec![
        format!("الإصدار: {app_version} ({build})"),
        format!("نظام التشغيل: {} {}", std::env::consts::OS, std::env::consts::ARCH),
    ];
    let status = if updater_configured {
        details.push("التحديث التلقائي: مُعد".into());
        "ok"
    } else {
        details.push("التحديث التلقائي: غير مُعد في هذه النسخة".into());
        "warn"
    };
    item("app", "البرنامج", status, details)
}

fn check_database(conn: &Connection) -> HealthItem {
    let mut details = Vec::new();
    let mut status = "ok";

    let messages: Vec<String> = conn
        .prepare("PRAGMA integrity_check")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get::<_, String>(0))?.collect())
        .unwrap_or_else(|error| vec![format!("تعذر تشغيل الفحص: {error}")]);
    if messages.len() == 1 && messages[0] == "ok" {
        details.push("سلامة قاعدة البيانات: سليمة".into());
    } else {
        status = "fail";
        details.push(format!("سلامة قاعدة البيانات: توجد {} مشكلة", messages.len()));
        details.extend(messages.into_iter().take(5).map(|m| format!("  {m}")));
    }

    let broken_links = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| Ok(stmt.query_map([], |_| Ok(()))?.count()))
        .unwrap_or(0);
    if broken_links > 0 {
        if status == "ok" { status = "warn"; }
        details.push(format!("روابط غير مكتملة بين الجداول: {broken_links}"));
    } else {
        details.push("الروابط بين الجداول: سليمة".into());
    }

    match crate::db::schema_version(conn) {
        Ok(version) if version == crate::db::SCHEMA_VERSION => details.push(format!("إصدار هيكل القاعدة: {version}")),
        Ok(version) => {
            status = "fail";
            details.push(format!("إصدار هيكل القاعدة {version} لا يطابق المتوقع {}", crate::db::SCHEMA_VERSION));
        }
        Err(error) => {
            status = "fail";
            details.push(format!("تعذر قراءة إصدار هيكل القاعدة: {error}"));
        }
    }

    let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap_or_default();
    let pages = count(conn, "PRAGMA page_count").unwrap_or(0);
    let page_size = count(conn, "PRAGMA page_size").unwrap_or(0);
    details.push(format!("الحجم: {:.1} MB · وضع السجل: {journal}", (pages * page_size) as f64 / 1_048_576.0));

    let counts = [
        ("الموظفون", "SELECT COUNT(*) FROM employees"),
        ("وثائق الأرشيف", "SELECT COUNT(*) FROM general_docs"),
        ("الكتب الصادرة", "SELECT COUNT(*) FROM outgoing_docs"),
        ("المستخدمون", "SELECT COUNT(*) FROM users"),
    ];
    let line = counts
        .iter()
        .map(|(label, sql)| format!("{label}: {}", count(conn, sql).map(|n| n.to_string()).unwrap_or_else(|| "؟".into())))
        .collect::<Vec<_>>()
        .join(" · ");
    details.push(format!("الأعداد: {line}"));

    item("database", "قاعدة البيانات", status, details)
}

fn folder_state(path: &Path) -> (&'static str, String) {
    if !path.is_dir() {
        return ("fail", "غير موجود أو غير متاح".into());
    }
    match crate::paths::ensure_writable(path) {
        Ok(()) => ("ok", "متاح وقابل للكتابة".into()),
        Err(_) => ("fail", "موجود لكن لا يمكن الكتابة فيه (صلاحيات)".into()),
    }
}

/// Only real faults count here: a folder that is missing or cannot be written to.
/// Placement advice from Settings (same disk, old AppData location) is guidance, not a fault,
/// so it is left out of the check.
fn check_folders(conn: &Connection) -> HealthItem {
    let backup_root = crate::paths::backup_root();
    let data_files = storage_path(conn);

    let mut status = "ok";
    let mut details = Vec::new();
    for (label, path) in [("مجلد البيانات", &data_files), ("مجلد النسخ الاحتياطية", &backup_root)] {
        let (state, text) = folder_state(path);
        if state == "fail" { status = "fail"; }
        details.push(format!("{label}: {text}"));
        details.push(format!("  {}", anonymise_path(path)));
    }
    item("folders", "المجلدات", status, details)
}

fn file_area(relative: &str) -> &'static str {
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with("Files/Employees/") { "ملفات الموظفين" }
    else if normalized.starts_with("Files/GeneralDocs/") { "أرشيف الوثائق" }
    else if normalized.starts_with("Files/OutgoingDocs/") { "الكتب الصادرة" }
    else if normalized.starts_with("Branding/") { "شعار الجهة" }
    else { "أخرى" }
}

fn check_files(conn: &Connection) -> HealthItem {
    let stored: Vec<String> = match conn
        .prepare("SELECT stored_path FROM document_metadata")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
    {
        Ok(paths) => paths,
        Err(error) => return item("files", "الملفات المرفقة", "fail", vec![format!("تعذر قراءة قائمة الملفات: {error}")]),
    };
    let mut missing: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for relative in &stored {
        if crate::scanner::effective_path(conn, relative).is_err() {
            *missing.entry(file_area(relative)).or_default() += 1;
        }
    }
    let total_missing: usize = missing.values().sum();
    let mut details = vec![format!("عدد الملفات المسجلة: {}", stored.len())];
    if total_missing == 0 {
        details.push("كل الملفات موجودة في مجلد البيانات".into());
        item("files", "الملفات المرفقة", "ok", details)
    } else {
        details.push(format!("ملفات مفقودة من مجلد البيانات: {total_missing}"));
        details.extend(missing.into_iter().map(|(area, n)| format!("  {area}: {n}")));
        item("files", "الملفات المرفقة", "warn", details)
    }
}

fn days_since(timestamp: &str) -> Option<i64> {
    let trimmed = timestamp.trim();
    let parsed = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f"))
        .ok()
        .or_else(|| chrono::DateTime::parse_from_rfc3339(trimmed).ok().map(|d| d.naive_utc()))
        .or_else(|| chrono::NaiveDate::parse_from_str(trimmed.get(..10)?, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0))?;
    Some((chrono::Local::now().naive_local() - parsed).num_days())
}

/// Counts the backup files (.autohrbak) under the backup folder and finds the newest one.
/// The folder holds Manual, PreUpdate, Daily, Weekly and Monthly, each split by year.
fn scan_backup_files(root: &Path) -> (usize, Option<chrono::DateTime<chrono::Local>>) {
    fn walk(dir: &Path, depth: usize, count: &mut usize, newest: &mut Option<std::time::SystemTime>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 4 { walk(&path, depth + 1, count, newest); }
            } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("autohrbak")) {
                *count += 1;
                if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                    if newest.is_none_or(|n| modified > n) { *newest = Some(modified); }
                }
            }
        }
    }
    let (mut count, mut newest) = (0, None);
    walk(root, 0, &mut count, &mut newest);
    (count, newest.map(chrono::DateTime::<chrono::Local>::from))
}

fn check_backups(conn: &Connection) -> HealthItem {
    let mut details = Vec::new();
    let (files, newest_file) = scan_backup_files(&crate::paths::backup_root());
    // Fall back to the audit log when the backup folder cannot be read right now.
    let logged: Option<String> = conn
        .query_row(
            "SELECT datetime(MAX(created_at),'localtime') FROM activity_log WHERE action IN ('CREATE_BACKUP','CREATE_AUTO_BACKUP') AND result='Success'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let last = newest_file
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .or(logged);
    let mut status = match last.as_deref().and_then(days_since) {
        None => {
            details.push("لا توجد أي نسخة احتياطية في مجلد النسخ".into());
            "fail"
        }
        Some(days) => {
            let age = if days <= 0 { "اليوم".to_string() } else { format!("قبل {days} يوم") };
            details.push(format!("آخر نسخة احتياطية: {} ({age}) · عدد ملفات النسخ: {files}", last.unwrap_or_default()));
            if days > 7 { "warn" } else { "ok" }
        }
    };

    let enabled: Vec<&str> = [("auto_backup_daily_enabled", "يومي"), ("auto_backup_weekly_enabled", "أسبوعي"), ("auto_backup_monthly_enabled", "شهري")]
        .into_iter()
        .filter(|(key, _)| setting(conn, key).as_deref() == Some("1"))
        .map(|(_, label)| label)
        .collect();
    if enabled.is_empty() {
        if status == "ok" { status = "warn"; }
        details.push("النسخ التلقائي: غير مفعّل".into());
    } else {
        details.push(format!("النسخ التلقائي: {}", enabled.join("، ")));
        if setting(conn, "auto_backup_password").is_none() {
            if status == "ok" { status = "warn"; }
            details.push("النسخ التلقائي مفعّل لكن كلمة مروره غير محفوظة".into());
        }
    }
    for (key, label) in [("auto_backup_last_daily", "آخر نسخة يومية"), ("auto_backup_last_weekly", "آخر نسخة أسبوعية"), ("auto_backup_last_monthly", "آخر نسخة شهرية")] {
        if let Some(value) = setting(conn, key) {
            details.push(format!("{label}: {value}"));
        }
    }
    item("backups", "النسخ الاحتياطية", status, details)
}

/// Plain-Arabic wording for a failed action in the audit log. `reason` is the fixed English
/// reason the backend writes for failed logins (never user input).
fn failure_label(action: &str, reason: Option<&str>) -> String {
    match (action, reason) {
        ("LOGIN", Some("Invalid password")) => "محاولات دخول بكلمة مرور خاطئة".into(),
        ("LOGIN", Some("Unknown username")) => "محاولات دخول باسم مستخدم غير موجود".into(),
        ("LOGIN", Some("Account temporarily locked")) => "محاولات دخول أثناء قفل الحساب مؤقتًا".into(),
        ("LOGIN", _) => "محاولات دخول فاشلة".into(),
        ("ACCESS_DENIED", _) => "محاولات فتح صفحة أو تنفيذ عملية بدون صلاحية".into(),
        ("CREATE_AUTO_BACKUP", _) => "نسخ احتياطية تلقائية لم تكتمل".into(),
        ("CREATE_BACKUP", _) => "نسخ احتياطية يدوية لم تكتمل".into(),
        ("RESTORE_BACKUP", _) => "عمليات استعادة لم تكتمل".into(),
        (other, _) => format!("عمليات أخرى لم تكتمل ({})", other.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<String>()),
    }
}

/// Failed actions from the audit log in the last 30 days, as counts per kind only:
/// no usernames, targets or details leave the database (the login reason is a fixed code).
fn check_recent_failures(conn: &Connection) -> HealthItem {
    let rows: Vec<(String, Option<String>, i64)> = conn
        .prepare(
            "SELECT action, CASE WHEN action='LOGIN' THEN details END AS reason, COUNT(*) FROM activity_log
             WHERE result='Failure' AND created_at >= datetime('now','-30 days')
             GROUP BY action, reason ORDER BY COUNT(*) DESC LIMIT 12",
        )
        .and_then(|mut stmt| stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect())
        .unwrap_or_default();
    let title = "العمليات الفاشلة خلال آخر 30 يومًا";
    if rows.is_empty() {
        return item("failures", title, "ok", vec!["لا توجد عمليات فاشلة مسجلة".into()]);
    }
    let backup_failed = rows.iter().any(|(action, _, _)| action.ends_with("BACKUP"));
    let mut details: Vec<String> = rows
        .iter()
        .map(|(action, reason, n)| format!("{}: {n}", failure_label(action, reason.as_deref())))
        .collect();
    details.push("محاولات الدخول الخاطئة القليلة أمر طبيعي (خطأ في الكتابة). التفاصيل في «سجل النظام».".into());
    item("failures", title, if backup_failed { "warn" } else { "info" }, details)
}

fn error_kind_label(kind: &str) -> &'static str {
    match kind {
        "database" => "قاعدة البيانات",
        "file" => "الملفات والمرفقات",
        "backup" => "النسخ الاحتياطي والاستعادة",
        "ocr" => "قراءة بيانات المستمسكات",
        "scanner" => "الماسح الضوئي",
        "update" => "التحديث",
        "script" => "واجهة البرنامج",
        "panic" => "توقف مفاجئ",
        _ => "البرنامج",
    }
}

fn screen_label(screen: &str) -> String {
    match screen {
        "dashboard" => "الرئيسية".into(),
        "employees" => "الموظفون".into(),
        "documents" => "الوثائق".into(),
        "settings" => "الإعدادات".into(),
        "audit" => "سجل النظام".into(),
        "login" => "تسجيل الدخول".into(),
        other => other.into(),
    }
}

/// «آخر الأخطاء التقنية» from the local error log (errlog.rs), already cleaned of personal data.
/// Identical errors are shown once with how often they happened and when last.
fn check_technical_errors(entries: &[crate::errlog::ErrorEntry]) -> HealthItem {
    let title = "آخر الأخطاء التقنية خلال آخر 30 يومًا";
    let since = (chrono::Local::now() - chrono::Duration::days(30)).format("%Y-%m-%d %H:%M:%S").to_string();
    // entries are newest first, so the first of each group carries the latest time.
    let mut groups: Vec<(&crate::errlog::ErrorEntry, usize, &str)> = Vec::new();
    for e in entries.iter().filter(|e| e.time >= since) {
        match groups.iter_mut().find(|(g, _, _)| g.kind == e.kind && g.operation == e.operation && g.message == e.message) {
            Some(group) => { group.1 += 1; group.2 = e.time.as_str(); }
            None => groups.push((e, 1, e.time.as_str())),
        }
    }
    if groups.is_empty() {
        return item("errors", title, "ok", vec!["لا توجد أخطاء تقنية مسجلة".into()]);
    }
    let serious = groups.iter().any(|(e, _, _)| matches!(e.kind.as_str(), "database" | "backup" | "panic"));
    let total = groups.len();
    let mut details = Vec::new();
    for (e, count, first) in groups.into_iter().take(20) {
        let mut line = format!("{} | {}", &e.time[..e.time.len().min(16)], error_kind_label(&e.kind));
        if !e.operation.is_empty() { line.push_str(&format!(" | العملية: {}", e.operation)); }
        if !e.screen.is_empty() { line.push_str(&format!(" | الشاشة: {}", screen_label(&e.screen))); }
        line.push_str(&format!(" | الإصدار {}", e.version));
        line.push_str(&format!(" | الخطأ: {}", e.message));
        if count > 1 { line.push_str(&format!(" | تكرر {count} مرات منذ {}", &first[..first.len().min(16)])); }
        if !e.context.is_empty() { line.push_str(&format!(" | السياق: {}", e.context)); }
        details.push(line);
    }
    if total > 20 { details.push(format!("و{} أخطاء أخرى أقدم", total - 20)); }
    details.push("أُزيلت من هذه الرسائل المسارات وأسماء الملفات والأرقام الطويلة وعناوين البريد وكلمات المرور.".into());
    item("errors", title, if serious { "warn" } else { "info" }, details)
}

fn status_label(status: &str) -> &'static str {
    match status {
        "ok" => "سليم",
        "warn" => "تنبيه",
        "fail" => "خلل",
        _ => "معلومة",
    }
}

fn render_text(report: &HealthReport) -> String {
    let mut out = String::new();
    out.push_str("CNSArch — تقرير فحص البرنامج\n");
    out.push_str(&format!("التاريخ: {}\n", report.generated_at));
    out.push_str(&format!("الإصدار: {}\n", report.app_version));
    out.push_str(&format!("النتيجة العامة: {}\n", status_label(&report.overall)));
    out.push_str("هذا الملف لا يحتوي على أسماء الموظفين أو أرقامهم أو صور مستمسكاتهم أو أسماء المستخدمين أو كلمات المرور.\n");
    for entry in &report.items {
        out.push_str(&format!("\n[{}] {} ({})\n", status_label(&entry.status), entry.title, entry.key));
        for line in &entry.details {
            out.push_str(&format!("- {line}\n"));
        }
    }
    out.replace('\n', "\r\n")
}

/// `errors` is the local error log, newest first (`errlog::recent`).
pub fn run(conn: &Connection, app_version: &str, updater_configured: bool, errors: &[crate::errlog::ErrorEntry]) -> HealthReport {
    run_with_progress(conn, app_version, updater_configured, errors, |_, _| {})
}

/// Number of steps reported to `progress` (the screen shows the same steps in the same order).
pub const STEPS: usize = 7;

/// Same as `run`, calling `progress(step, STEPS)` before each step starts (step counts from 0).
pub fn run_with_progress(
    conn: &Connection,
    app_version: &str,
    updater_configured: bool,
    errors: &[crate::errlog::ErrorEntry],
    mut progress: impl FnMut(usize, usize),
) -> HealthReport {
    let mut items = Vec::with_capacity(STEPS);
    progress(0, STEPS); items.push(check_app(app_version, updater_configured));
    progress(1, STEPS); items.push(check_database(conn));
    progress(2, STEPS); items.push(check_folders(conn));
    progress(3, STEPS); items.push(check_files(conn));
    progress(4, STEPS); items.push(check_backups(conn));
    progress(5, STEPS); items.push(check_recent_failures(conn));
    progress(6, STEPS); items.push(check_technical_errors(errors));
    progress(STEPS, STEPS);
    let overall = if items.iter().any(|i| i.status == "fail") {
        "fail"
    } else if items.iter().any(|i| i.status == "warn") {
        "warn"
    } else {
        "ok"
    };
    let mut report = HealthReport {
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        app_version: app_version.into(),
        overall: overall.into(),
        items,
        text: String::new(),
    };
    report.text = render_text(&report);
    report
}

/// Writes the report as UTF-8 with a BOM so Windows Notepad shows the Arabic correctly.
pub fn save(report: &HealthReport, destination: &Path) -> std::io::Result<()> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(report.text.as_bytes());
    std::fs::write(destination, bytes)
}

// ── Support contact («اتصل بنا») ─────────────────────────────────────────────

pub const SUPPORT_WHATSAPP: &str = "9647902234508";
pub const SUPPORT_WHATSAPP_DISPLAY: &str = "+964 790 223 4508";
pub const SUPPORT_EMAIL: &str = "eng_essam.h@hotmail.com";

#[derive(Debug, Clone, Serialize)]
pub struct SupportContact {
    pub whatsapp: String,
    pub email: String,
}

pub fn support_contact() -> SupportContact {
    SupportContact { whatsapp: SUPPORT_WHATSAPP_DISPLAY.into(), email: SUPPORT_EMAIL.into() }
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Builds the only URLs the app may open for support. `channel` is "whatsapp" or "email",
/// `topic` is "suggestion" or "problem".
pub fn support_url(channel: &str, topic: &str, app_version: &str) -> Option<String> {
    let topic_text = match topic {
        "suggestion" => "اقتراح",
        "problem" => "الإبلاغ عن مشكلة",
        _ => return None,
    };
    let body = format!("مرحبًا، أتواصل بخصوص برنامج CNSArch (الإصدار {app_version}).\nالموضوع: {topic_text}\n\n");
    match channel {
        "whatsapp" => Some(format!("https://wa.me/{SUPPORT_WHATSAPP}?text={}", percent_encode(&body))),
        "email" => Some(format!(
            "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
            percent_encode(&format!("CNSArch {app_version} - {topic_text}")),
            percent_encode(&body.replace('\n', "\r\n")),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
        conn.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION).unwrap();
        conn
    }

    #[test]
    fn report_has_no_personal_data() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO employees(full_name) VALUES('موظف سري للاختبار')",
            [],
        ).ok();
        conn.execute(
            "INSERT INTO activity_log(username,action,target_name,result,details) VALUES('secret_user','LOGIN','target-secret','Failure','detail-secret')",
            [],
        ).unwrap();
        let report = run(&conn, "1.0.5", true, &[]);
        for secret in ["موظف سري", "secret_user", "target-secret", "detail-secret"] {
            assert!(!report.text.contains(secret), "report leaked {secret}");
        }
        assert!(report.text.contains("محاولات دخول فاشلة: 1"), "{}", report.text);
        assert!(report.items.iter().any(|i| i.key == "database" && i.status != "fail"));
    }

    #[test]
    fn technical_errors_are_grouped_with_time_and_operation() {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let e = |op: &str, msg: &str| crate::errlog::ErrorEntry {
            time: now.clone(), version: "1.0.5".into(), kind: "backup".into(), operation: op.into(),
            screen: "settings".into(), message: msg.into(), context: String::new(),
        };
        let entries = vec![e("cmd_create_backup", "database is locked"), e("cmd_create_backup", "database is locked"), e("cmd_restore_backup", "wrong password")];
        let item = check_technical_errors(&entries);
        assert_eq!(item.status, "warn");
        assert!(item.details[0].contains("العملية: cmd_create_backup") && item.details[0].contains("تكرر 2 مرات"), "{:?}", item.details);
        assert!(item.details[0].contains("الشاشة: الإعدادات"), "{:?}", item.details);
        assert_eq!(check_technical_errors(&[]).status, "ok");
        let report = run(&test_db(), "1.0.5", true, &entries);
        assert!(report.text.contains("آخر الأخطاء التقنية"), "{}", report.text);
    }

    #[test]
    fn a_logged_automatic_backup_counts() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO activity_log(username,action,result,created_at) VALUES('system','CREATE_AUTO_BACKUP','Success',datetime('now'))",
            [],
        ).unwrap();
        let report = run(&conn, "1.0.5", true, &[]);
        let backups = report.items.iter().find(|i| i.key == "backups").unwrap();
        assert_ne!(backups.status, "fail", "{:?}", backups.details);
    }

    #[test]
    fn backup_files_are_found_in_year_folders() {
        let dir = tempfile::tempdir().unwrap();
        let year = dir.path().join("Daily").join("2026");
        std::fs::create_dir_all(&year).unwrap();
        std::fs::write(year.join("autohr_daily_2026-11-24_020000.autohrbak"), b"x").unwrap();
        std::fs::write(year.join("notes.txt"), b"x").unwrap();
        let (count, newest) = scan_backup_files(dir.path());
        assert_eq!(count, 1);
        assert!(newest.is_some());
    }

    #[test]
    fn missing_backup_is_a_failure() {
        let conn = test_db();
        let report = run(&conn, "1.0.5", true, &[]);
        let backups = report.items.iter().find(|i| i.key == "backups").unwrap();
        assert_eq!(backups.status, "fail");
        assert_eq!(report.overall, "fail");
    }

    #[test]
    fn support_urls_are_fixed_and_encoded() {
        let url = support_url("whatsapp", "problem", "1.0.5").unwrap();
        assert!(url.starts_with("https://wa.me/9647902234508?text="));
        assert!(!url.contains(' ') && !url.contains('"'));
        let mail = support_url("email", "suggestion", "1.0.5").unwrap();
        assert!(mail.starts_with("mailto:eng_essam.h@hotmail.com?subject="));
        assert!(support_url("https://evil", "problem", "1").is_none());
        assert!(support_url("whatsapp", "other", "1").is_none());
    }

    #[test]
    fn home_folder_is_anonymised() {
        if let Some(home) = dirs::home_dir() {
            let text = anonymise_path(&home.join("CNSArch").join("Data"));
            assert!(text.starts_with("%USERPROFILE%"), "{text}");
        }
    }
}
