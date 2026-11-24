//! Protection for secrets and data at rest on Windows.
//!
//! * `protect_secret` / `unprotect_secret` wrap a value with Windows DPAPI (CurrentUser scope), so a
//!   copy of `database.db` alone no longer reveals the automatic-backup password.
//! * `restrict_folder` limits a data or backup folder to the signed-in Windows user, the local
//!   Administrators group and SYSTEM, instead of the drive's default ACL (which on non-system drives
//!   usually lets every authenticated user read and modify the files).
//!
//! On other platforms (development and the test suite) values are stored with a `plain1:` prefix
//! and folder ACLs are left alone.

use crate::services::AppError;

const DPAPI_PREFIX: &str = "dpapi1:";
const PLAIN_PREFIX: &str = "plain1:";

/// Wraps a secret for storage in the database.
pub fn protect_secret(plain: &str) -> Result<String, AppError> {
    #[cfg(target_os = "windows")]
    {
        let protected = dpapi::protect(plain.as_bytes())
            .map_err(|code| AppError::Other(format!("Windows could not protect the secret (DPAPI error {code})")))?;
        Ok(format!("{DPAPI_PREFIX}{}", hex::encode(protected)))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(format!("{PLAIN_PREFIX}{plain}"))
    }
}

/// Result of reading a stored secret.
pub struct StoredSecret {
    pub value: String,
    /// The value was stored by an older release as plain text and should be re-saved protected.
    pub legacy: bool,
}

/// Reads a value written by `protect_secret`, or a legacy plain-text value from releases ≤ 1.0.3.
pub fn unprotect_secret(stored: &str) -> Result<StoredSecret, AppError> {
    if let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) {
        #[cfg(target_os = "windows")]
        {
            let bytes = hex::decode(encoded).map_err(|_| AppError::Validation("The stored secret is damaged".into()))?;
            let plain = dpapi::unprotect(&bytes).map_err(|_| AppError::Validation(
                "تعذر فك كلمة مرور النسخ التلقائي على هذا الجهاز أو بهذا المستخدم. أعد إدخالها من الإعدادات.".into(),
            ))?;
            let value = String::from_utf8(plain).map_err(|_| AppError::Validation("The stored secret is damaged".into()))?;
            return Ok(StoredSecret { value, legacy: false });
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = encoded;
            return Err(AppError::Validation("This secret was protected on Windows and cannot be read here".into()));
        }
    }
    if let Some(plain) = stored.strip_prefix(PLAIN_PREFIX) {
        return Ok(StoredSecret { value: plain.to_string(), legacy: cfg!(target_os = "windows") });
    }
    Ok(StoredSecret { value: stored.to_string(), legacy: true })
}

#[cfg(target_os = "windows")]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success the API returns a LocalAlloc'd buffer of `cbData` bytes that we own.
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        bytes
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, u32> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: `input` borrows `data` for the duration of the call; `out` is written by the API.
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 { return Err(unsafe { windows_sys::Win32::Foundation::GetLastError() }); }
        Ok(take(out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, u32> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as above.
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 { return Err(unsafe { windows_sys::Win32::Foundation::GetLastError() }); }
        Ok(take(out))
    }
}

/// Restricts `dir` (and, through inheritance, everything below it) to the current Windows user,
/// Administrators and SYSTEM. Returns an error message on failure; callers treat it as non-fatal.
pub fn restrict_folder(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let sid = current_user_sid()?;
        let output = Command::new("icacls.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .arg(dir)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("*{sid}:(OI)(CI)F"))
            .args(["/grant:r", "*S-1-5-32-544:(OI)(CI)F", "/grant:r", "*S-1-5-18:(OI)(CI)F", "/Q"])
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Who can open a managed folder, as far as the health check needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // each platform builds only some variants
pub enum FolderAccess {
    /// Only this Windows user, Administrators and SYSTEM.
    Restricted,
    /// Other accounts (for example «Users» or «Everyone») also have access; the count of such entries.
    Open(usize),
    /// Not a Windows build: folder permissions are not managed.
    NotApplicable,
}

/// Reads the folder's access list. Accounts other than the current user, Administrators, SYSTEM
/// and CREATOR OWNER count as open access.
pub fn folder_access(dir: &std::path::Path) -> Result<FolderAccess, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let sid = current_user_sid()?;
        // The path is passed in an environment variable so it never needs quoting in the script.
        let script = "$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath $env:CNSARCH_ACL_DIR;\
            foreach($r in $acl.Access){ if($r.AccessControlType -ne 'Allow'){continue}; \
            try{$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$r.IdentityReference.Value} }";
        let output = std::process::Command::new("powershell.exe")
            .creation_flags(0x0800_0000)
            .env("CNSARCH_ACL_DIR", dir)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect());
        }
        let allowed = [sid.as_str(), "S-1-5-32-544", "S-1-5-18", "S-1-3-0"];
        let open = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !allowed.contains(&line))
            .count();
        Ok(if open == 0 { FolderAccess::Restricted } else { FolderAccess::Open(open) })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Ok(FolderAccess::NotApplicable)
    }
}

#[cfg(target_os = "windows")]
fn current_user_sid() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("whoami.exe")
        .creation_flags(0x0800_0000)
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    // Output: "DOMAIN\user","S-1-5-21-..."
    text.trim()
        .rsplit(',')
        .next()
        .map(|sid| sid.trim().trim_matches('"').to_string())
        .filter(|sid| sid.starts_with("S-1-"))
        .ok_or_else(|| "Could not read the current Windows user".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_round_trip_and_legacy_values_are_flagged() {
        let stored = protect_secret("backup-password").unwrap();
        assert_ne!(stored, "backup-password", "secrets are never stored as-is");
        let read = unprotect_secret(&stored).unwrap();
        assert_eq!(read.value, "backup-password");
        let legacy = unprotect_secret("old-plain-password").unwrap();
        assert_eq!(legacy.value, "old-plain-password");
        assert!(legacy.legacy);
    }
}
