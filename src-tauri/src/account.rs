//! Accounts: the password policy («سياسة كلمة المرور»), the first administrator created by the
//! first-run wizard, and the administrator's recovery code («رمز الاستعادة»).
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::services::{
    assert_permission, get_setting, hash_password, log_activity, set_setting, verify_password, AppError, AppResult, User,
};

// ── Password policy ─────────────────────────────────────────────────────────

const POLICY_KEY: &str = "password_policy";

/// Rules for account passwords, set in «الإعدادات ← المستخدمين والصلاحيات».
/// Backup passwords keep their own fixed rule (`validate_new_password`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PasswordPolicy {
    pub min_length: u32,
    pub require_upper: bool,
    pub require_lower: bool,
    pub require_digit: bool,
    pub require_symbol: bool,
    pub reject_common: bool,
    /// Wrong sign-ins (within a short window) before the account is paused.
    pub max_failures: u32,
    pub lockout_minutes: u32,
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_length: 9, require_upper: true, require_lower: true, require_digit: true, require_symbol: false,
            reject_common: true, max_failures: 5, lockout_minutes: 5,
        }
    }
}

pub const MIN_LENGTH_FLOOR: u32 = 8;

pub fn password_policy(conn: &Connection) -> PasswordPolicy {
    get_setting(conn, POLICY_KEY).ok().flatten()
        .and_then(|value| serde_json::from_str::<PasswordPolicy>(&value).ok())
        .map(clamp)
        .unwrap_or_default()
}

fn clamp(mut policy: PasswordPolicy) -> PasswordPolicy {
    policy.min_length = policy.min_length.clamp(MIN_LENGTH_FLOOR, 64);
    policy.max_failures = policy.max_failures.clamp(3, 20);
    policy.lockout_minutes = policy.lockout_minutes.clamp(1, 60);
    policy
}

pub fn set_password_policy(conn: &Connection, caller: &str, policy: PasswordPolicy) -> AppResult<PasswordPolicy> {
    assert_permission(conn, caller, "users.manage")?;
    if policy.min_length < MIN_LENGTH_FLOOR || policy.min_length > 64 {
        return Err(AppError::Validation(format!("أقل طول لكلمة المرور من {MIN_LENGTH_FLOOR} إلى 64")));
    }
    if !(3..=20).contains(&policy.max_failures) {
        return Err(AppError::Validation("عدد المحاولات قبل الإيقاف من 3 إلى 20".into()));
    }
    if !(1..=60).contains(&policy.lockout_minutes) {
        return Err(AppError::Validation("مدة الإيقاف من 1 إلى 60 دقيقة".into()));
    }
    let before = password_policy(conn);
    set_setting(conn, POLICY_KEY, &serde_json::to_string(&policy).map_err(|e| AppError::Other(e.to_string()))?)?;
    let details = crate::services::audit_changes(
        &serde_json::to_value(&before).unwrap_or_default(),
        &serde_json::to_value(&policy).unwrap_or_default(),
        &[],
    );
    log_activity(conn, caller, "UPDATE_PASSWORD_POLICY", Some("settings"), None, None,
        Some(&serde_json::json!({ "changes": details }).to_string()));
    Ok(policy)
}

/// Arabic count agreement for letters: 3–10 «أحرف», 11+ «حرفًا».
fn letters(count: u32) -> String {
    if (3..=10).contains(&count) { format!("{count} أحرف") } else { format!("{count} حرفًا") }
}

/// Checks a new account password against the policy. `username` is the account it is for.
pub fn validate_account_password(conn: &Connection, username: &str, password: &str) -> AppResult<()> {
    check_against(&password_policy(conn), username, password)
}

pub fn check_against(policy: &PasswordPolicy, username: &str, password: &str) -> AppResult<()> {
    let fail = |message: String| Err(AppError::Validation(message));
    if (password.chars().count() as u32) < policy.min_length {
        return fail(format!("كلمة المرور يجب أن تكون {} على الأقل", letters(policy.min_length)));
    }
    if password.len() > 72 {
        return fail("كلمة المرور طويلة جدًا (الحد 72 حرفًا إنجليزيًا أو 36 حرفًا عربيًا)".into());
    }
    if policy.require_upper && !password.chars().any(|c| c.is_ascii_uppercase()) {
        return fail("كلمة المرور يجب أن تحتوي على حرف إنجليزي كبير (A-Z)".into());
    }
    if policy.require_lower && !password.chars().any(|c| c.is_ascii_lowercase()) {
        return fail("كلمة المرور يجب أن تحتوي على حرف إنجليزي صغير (a-z)".into());
    }
    if policy.require_digit && !password.chars().any(|c| c.is_ascii_digit()) {
        return fail("كلمة المرور يجب أن تحتوي على رقم (0-9)".into());
    }
    if policy.require_symbol && !password.chars().any(|c| !c.is_alphanumeric() && !c.is_whitespace()) {
        return fail("كلمة المرور يجب أن تحتوي على رمز مثل ! @ # $".into());
    }
    let name = username.trim().to_lowercase();
    if name.chars().count() >= 3 && password.to_lowercase().contains(&name) {
        return fail("كلمة المرور يجب ألا تحتوي على اسم المستخدم".into());
    }
    if policy.reject_common && is_common(password) {
        return fail("كلمة المرور سهلة التخمين، اختر غيرها".into());
    }
    Ok(())
}

/// Well-known passwords, keyboard rows and runs. Compared without case and without the digits
/// and symbols people add at the end («Password123!» is «password»).
const COMMON: &[&str] = &[
    "password", "passw0rd", "p@ssword", "p@ssw0rd", "admin", "administrator", "sysadmin", "root", "user", "guest",
    "welcome", "letmein", "login", "master", "secret", "changeme", "default", "test", "qwerty", "qwertyuiop",
    "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "azerty", "iloveyou", "dragon", "monkey", "football", "baseball",
    "sunshine", "princess", "shadow", "superman", "michael", "freedom", "whatever", "trustno1", "abc", "abcd",
    "abcdef", "abcdefg", "abcdefgh", "abcdefghi", "aaaaaa", "cnsarch", "autohr", "gcaan", "gcans", "iraq",
    "baghdad", "company", "archive", "airport", "computer", "internet", "windows", "microsoft", "google", "samsung",
    "123456", "1234567", "12345678", "123456789", "1234567890", "987654321", "111111", "000000", "121212", "123123",
    "qazwsx", "1qaz2wsx", "1q2w3e4r", "1q2w3e", "q1w2e3r4", "zaq12wsx", "hello", "summer", "winter", "spring",
];

fn is_common(password: &str) -> bool {
    let lower = password.to_lowercase();
    let core = lower.trim_end_matches(|c: char| c.is_ascii_digit() || !c.is_alphanumeric())
        .trim_start_matches(|c: char| c.is_ascii_digit() || !c.is_alphanumeric());
    if COMMON.contains(&lower.as_str()) || (!core.is_empty() && COMMON.contains(&core)) {
        return true;
    }
    let chars: Vec<char> = lower.chars().collect();
    // One character repeated, or mostly one character («aaaaaaaa1»).
    let distinct: std::collections::HashSet<&char> = chars.iter().collect();
    if distinct.len() <= 2 { return true; }
    // A run up or down the alphabet / digits for the whole password («abcdefgh1», «987654321»).
    let ordered = |step: i32| chars.windows(2).filter(|w| w[1] as i32 - w[0] as i32 == step).count();
    let run = ordered(1).max(ordered(-1));
    run + 2 >= chars.len()
}

// ── Base administrator ──────────────────────────────────────────────────────

const BASE_ADMIN_KEY: &str = "base_admin_username";
const FIRST_RUN_PASSWORD: &str = "password";

/// The account that cannot be deleted, stopped or demoted. «sysadmin» unless the first-run
/// wizard gave it another name.
pub fn base_admin(conn: &Connection) -> String {
    get_setting(conn, BASE_ADMIN_KEY).ok().flatten().filter(|v| !v.is_empty()).unwrap_or_else(|| "sysadmin".into())
}

pub fn is_base_admin(conn: &Connection, username: &str) -> bool {
    username.eq_ignore_ascii_case(&base_admin(conn))
}

/// True while the database still holds only the built-in «sysadmin» with its first-run password:
/// the first-run wizard then asks for the administrator's own name and password.
pub fn needs_first_admin(conn: &Connection) -> bool {
    let rows: Vec<(String, bool, String)> = match conn.prepare("SELECT username,must_change_password,password FROM users")
        .and_then(|mut stmt| stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    matches!(rows.as_slice(), [(name, true, hash)] if name == "sysadmin" && verify_password(FIRST_RUN_PASSWORD, hash).unwrap_or(false))
}

pub fn valid_username(username: &str) -> AppResult<()> {
    if username.len() < 3 || username.len() > 64 || !username.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err(AppError::Validation("اسم المستخدم من 3 إلى 64 حرفًا: أحرف إنجليزية وأرقام و . - _ فقط".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct FirstRunSetup {
    pub username: String,
    pub password: String,
    #[serde(default)] pub department_name: String,
    #[serde(default)] pub division_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FirstRunResult {
    pub user: User,
    pub recovery_code: String,
}

pub const UNIT_NAME_MAX: usize = 40;

pub fn check_unit_names(department: &str, division: &str) -> AppResult<()> {
    if department.chars().count() > UNIT_NAME_MAX || division.chars().count() > UNIT_NAME_MAX {
        return Err(AppError::Validation(format!("اسم القسم أو الشعبة لا يزيد على {UNIT_NAME_MAX} حرفًا")));
    }
    Ok(())
}

/// Last step of the first-run wizard: the built-in «sysadmin» becomes the administrator's own
/// account (their name and password, no temporary password), the section and unit names are
/// saved, and a recovery code is made. Only allowed while `needs_first_admin` is true.
pub fn complete_first_run(conn: &Connection, data: &FirstRunSetup) -> AppResult<FirstRunResult> {
    if !needs_first_admin(conn) { return Err(AppError::Unauthorized); }
    let username = data.username.trim();
    valid_username(username)?;
    validate_account_password(conn, username, &data.password)?;
    let department = data.department_name.trim();
    let division = data.division_name.trim();
    check_unit_names(department, division)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE users SET username=?1, password=?2, must_change_password=0 WHERE username='sysadmin'",
        params![username, hash_password(&data.password)?])?;
    set_setting(&tx, BASE_ADMIN_KEY, username)?;
    tx.execute("UPDATE company_config SET department_name=?1, division_name=?2 WHERE id=1", params![department, division])?;
    let code = store_new_recovery_code(&tx)?;
    log_activity(&tx, username, "FIRST_RUN_SETUP", Some("user"), None, Some(username), None);
    tx.commit()?;
    let user = crate::services::login(conn, username, &data.password)?;
    Ok(FirstRunResult { user, recovery_code: code })
}

// ── Recovery code ───────────────────────────────────────────────────────────

const RECOVERY_HASH_KEY: &str = "admin_recovery_hash";
const RECOVERY_DATE_KEY: &str = "admin_recovery_created";
/// Failed recovery attempts share the sign-in lockout, under this key.
const RECOVERY_LOCK_KEY: &str = "#recovery";
/// No I, O, 0, 1: nothing that is misread when typed from paper.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn new_code() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let chars: Vec<char> = bytes.iter().map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char).collect();
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn store_new_recovery_code(conn: &Connection) -> AppResult<String> {
    let code = new_code();
    set_setting(conn, RECOVERY_HASH_KEY, &hash_password(&normalize_code(&code))?)?;
    set_setting(conn, RECOVERY_DATE_KEY, &chrono::Local::now().format("%Y-%m-%d %H:%M").to_string())?;
    Ok(code)
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryStatus {
    pub exists: bool,
    pub created_at: Option<String>,
    pub admin: String,
}

pub fn recovery_status(conn: &Connection) -> RecoveryStatus {
    let exists = get_setting(conn, RECOVERY_HASH_KEY).ok().flatten().is_some_and(|v| !v.is_empty());
    RecoveryStatus {
        exists,
        created_at: if exists { get_setting(conn, RECOVERY_DATE_KEY).ok().flatten() } else { None },
        admin: base_admin(conn),
    }
}

/// «إنشاء رمز استعادة جديد» in Settings: the old code stops working.
pub fn regenerate_recovery_code(conn: &Connection, caller: &str) -> AppResult<String> {
    assert_permission(conn, caller, "users.assign_system_admin")?;
    let code = store_new_recovery_code(conn)?;
    log_activity(conn, caller, "NEW_RECOVERY_CODE", Some("settings"), None, None, None);
    Ok(code)
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryResult {
    pub username: String,
    /// The old code is used up; this new one replaces it and is shown once.
    pub recovery_code: String,
}

/// «نسيت كلمة المرور؟» for the base administrator: the recovery code sets a new password.
pub fn recover_admin_password(conn: &Connection, code: &str, new_password: &str) -> AppResult<RecoveryResult> {
    let Some(stored) = get_setting(conn, RECOVERY_HASH_KEY)?.filter(|v| !v.is_empty()) else {
        return Err(AppError::Validation("لم يُنشأ رمز استعادة في هذا البرنامج. تواصل مع الدعم الفني.".into()));
    };
    if let Some(message) = crate::services::lockout_message(conn, RECOVERY_LOCK_KEY) {
        return Err(AppError::Validation(message));
    }
    let admin = base_admin(conn);
    validate_account_password(conn, &admin, new_password)?;
    if !verify_password(&normalize_code(code), &stored)? {
        crate::services::record_login_failure(conn, RECOVERY_LOCK_KEY);
        crate::services::log_audit(conn, Some(&admin), "RECOVER_ADMIN_PASSWORD", Some("user"), None, Some(&admin), "Failure", Some("Wrong recovery code"));
        if let Some(message) = crate::services::lockout_message(conn, RECOVERY_LOCK_KEY) {
            return Err(AppError::Validation(message));
        }
        return Err(AppError::Validation("رمز الاستعادة غير صحيح".into()));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE users SET password=?1, must_change_password=0 WHERE username=?2", params![hash_password(new_password)?, admin])?;
    let code = store_new_recovery_code(&tx)?;
    log_activity(&tx, &admin, "RECOVER_ADMIN_PASSWORD", Some("user"), None, Some(&admin), None);
    tx.commit()?;
    crate::services::clear_login_failures(conn, RECOVERY_LOCK_KEY);
    crate::services::clear_login_failures(conn, &admin);
    Ok(RecoveryResult { username: admin, recovery_code: code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_rules() {
        let p = PasswordPolicy::default();
        let ok = |pw: &str| check_against(&p, "hr.admin", pw).is_ok();
        assert!(!ok("Abc1234"));          // short
        assert!(!ok("abcdefgh12"));       // no upper
        assert!(!ok("ABCDEFGH12"));       // no lower
        assert!(!ok("Abcdefghij"));       // no digit
        assert!(!ok("Password123"));      // common
        assert!(!ok("Qwerty2026"));       // common keyboard row
        assert!(!ok("Abcdefghi1"));       // alphabet run
        assert!(!ok("Hr.Admin2026x"));    // contains the username
        assert!(!ok("Aaaaaaaaa1"));       // one letter repeated
        assert!(ok("Nakheel2026"));
        assert!(ok("Tigris7Bridge"));
    }

    #[test]
    fn policy_is_clamped_and_letters_agree() {
        assert_eq!(letters(9), "9 أحرف");
        assert_eq!(letters(12), "12 حرفًا");
        let p = clamp(PasswordPolicy { min_length: 3, max_failures: 0, lockout_minutes: 999, ..Default::default() });
        assert_eq!((p.min_length, p.max_failures, p.lockout_minutes), (8, 3, 60));
    }

    #[test]
    fn recovery_codes_are_readable() {
        let code = new_code();
        assert_eq!(code.len(), 19);
        assert!(!code.contains('O') && !code.contains('0') && !code.contains('I') && !code.contains('1'));
        assert_eq!(normalize_code(" abcd-efgh "), "ABCDEFGH");
    }
}
