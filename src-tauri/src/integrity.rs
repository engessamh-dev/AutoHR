//! Tamper evidence for the database and the stored attachments («كشف التلاعب»).
//!
//! The data folder can be opened with outside tools (for example DB Browser for SQLite) by anyone
//! signed in to Windows with the account that runs the program. This module does not stop that,
//! but it makes every change made outside the program visible:
//!
//! * **Row seals** — every row of every data table (users, employees, documents, settings, …) carries
//!   an HMAC-SHA256 seal in `integrity_rows`. A row changed, added or removed outside the program no
//!   longer matches. A per-table accumulator (an XOR of secret per-row values) also reveals a row
//!   that was deleted together with its seal.
//! * **Audit chain** — every `activity_log` entry is chained to the previous one in `integrity_audit`,
//!   and the last link is sealed in `integrity_meta`, so a removed, edited or inserted entry breaks
//!   the chain.
//! * **File seals** — every stored attachment has its SHA-256 sealed in `integrity_files`.
//!
//! Seals are written by TEMP triggers that exist only inside the program's own connections and call
//! SQL functions holding the key. An outside tool has neither, so what it writes is left unsealed.
//!
//! The key is 32 random bytes kept next to `config.json` (`%APPDATA%\CNSArch\integrity.key`),
//! protected with Windows DPAPI for the signed-in Windows user. It is never stored in the data
//! folder or in backups. The database records only the key's identifier (`kid`), so:
//!
//! * on the computer that sealed the data everything is checked («verified»);
//! * after moving the data or restoring it on another computer or Windows account the identifier
//!   differs («unapproved»): nothing can be checked until a System Admin approves the data once,
//!   which seals the current state with this computer's key and records it in the audit log.
//!
//! Limits: someone who can run their own code as the same Windows user can read the key, and someone
//! who deletes the key file forces the «unapproved» state; both are visible afterwards (the approval
//! is recorded with its time and user). Detection, not prevention.

use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::services::AppError;

#[cfg(not(test))]
const KEY_FILE: &str = "integrity.key";
const TAMPERED: &str = "tampered";
/// Tables that are never row-sealed: SQLite's own, this module's, the audit log (chained instead)
/// and the sign-in failure counters (changed on every failed sign-in, and harmless to reset).
const UNSEALED_TABLES: &[&str] = &["activity_log", "login_failures"];

// ── Key ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct LocalKey {
    key: [u8; 32],
    /// The key file did not exist before this run of the program.
    fresh: bool,
}

#[cfg(not(test))]
static LOCAL_KEY: std::sync::Mutex<Option<LocalKey>> = std::sync::Mutex::new(None);

#[cfg(test)]
thread_local! { static TEST_KEY: std::cell::Cell<Option<LocalKey>> = const { std::cell::Cell::new(None) }; }

fn random_key() -> [u8; 32] {
    use rand::RngCore;
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

#[cfg(not(test))]
fn load_or_create_key() -> Result<LocalKey, String> {
    let path = crate::services::app_data_path().join(KEY_FILE);
    if let Ok(stored) = std::fs::read_to_string(&path) {
        if let Ok(secret) = crate::secure::unprotect_secret(stored.trim()) {
            if let Ok(bytes) = hex::decode(secret.value.trim()) {
                if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return Ok(LocalKey { key, fresh: false });
                }
            }
        }
        // The file exists but cannot be read by this Windows account: start a new key. The data
        // sealed with the old one then needs approval, exactly as after a move.
        let key = random_key();
        write_key(&path, &key)?;
        return Ok(LocalKey { key, fresh: false });
    }
    let key = random_key();
    write_key(&path, &key)?;
    Ok(LocalKey { key, fresh: true })
}

#[cfg(not(test))]
fn write_key(path: &Path, key: &[u8; 32]) -> Result<(), String> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let protected = crate::secure::protect_secret(&hex::encode(key)).map_err(|e| e.to_string())?;
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut pending, protected.as_bytes()).map_err(|e| e.to_string())?;
    pending.as_file().sync_all().map_err(|e| e.to_string())?;
    pending.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn local_key() -> Result<LocalKey, String> {
    #[cfg(test)]
    {
        Ok(TEST_KEY.with(|cell| match cell.get() {
            Some(key) => key,
            None => {
                let key = LocalKey { key: random_key(), fresh: true };
                cell.set(Some(key));
                key
            }
        }))
    }
    #[cfg(not(test))]
    {
        let mut guard = LOCAL_KEY.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = *guard { return Ok(key); }
        let key = load_or_create_key()?;
        *guard = Some(key);
        Ok(key)
    }
}

/// Tests: act as another computer (a different key), or as this computer on a later run.
#[cfg(test)]
pub(crate) fn test_use_new_key(fresh: bool) {
    TEST_KEY.with(|cell| cell.set(Some(LocalKey { key: random_key(), fresh })));
}

// ── MAC ──────────────────────────────────────────────────────────────────────

fn hmac(key: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let inner = Sha256::new().chain_update(inner_pad).chain_update(data).finalize();
    Sha256::new().chain_update(outer_pad).chain_update(inner).finalize().into()
}

fn key_id(key: &[u8; 32]) -> String {
    hex::encode(&hmac(key, b"cnsarch-integrity-key-id")[..16])
}

fn push_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn push_value(out: &mut Vec<u8>, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => out.push(b'n'),
        ValueRef::Integer(v) => { out.push(b'i'); out.extend_from_slice(&v.to_le_bytes()); }
        ValueRef::Real(v) => { out.push(b'r'); out.extend_from_slice(&v.to_bits().to_le_bytes()); }
        ValueRef::Text(v) => { out.push(b't'); push_bytes(out, v); }
        ValueRef::Blob(v) => { out.push(b'b'); push_bytes(out, v); }
    }
}

/// The seal of one record. Columns holding NULL are left out, so adding a column to a table later
/// does not change the seals of the existing rows; the rest are sorted by name.
fn record_mac(key: &[u8; 32], domain: &str, prev: Option<&str>, rid: i64, columns: &mut [(&str, ValueRef<'_>)]) -> String {
    columns.sort_by(|a, b| a.0.cmp(b.0));
    let mut data = Vec::with_capacity(256);
    push_bytes(&mut data, b"cnsarch-integrity-v1");
    push_bytes(&mut data, domain.as_bytes());
    match prev {
        Some(prev) => { data.push(1); push_bytes(&mut data, prev.as_bytes()); }
        None => data.push(0),
    }
    data.extend_from_slice(&rid.to_le_bytes());
    for (name, value) in columns.iter() {
        if matches!(value, ValueRef::Null) { continue; }
        push_bytes(&mut data, name.as_bytes());
        push_value(&mut data, *value);
    }
    hex::encode(hmac(key, &data))
}

fn accumulator_part(key: &[u8; 32], table: &str, rid: i64, seal: Option<&str>) -> [u8; 32] {
    let Some(seal) = seal else { return [0u8; 32] };
    let mut data = Vec::new();
    push_bytes(&mut data, b"acc");
    push_bytes(&mut data, table.as_bytes());
    data.extend_from_slice(&rid.to_le_bytes());
    push_bytes(&mut data, seal.as_bytes());
    hmac(key, &data)
}

fn accumulator_base(key: &[u8; 32], table: &str) -> [u8; 32] {
    let mut data = Vec::new();
    push_bytes(&mut data, b"acc-base");
    push_bytes(&mut data, table.as_bytes());
    hmac(key, &data)
}

fn xor_into(target: &mut [u8; 32], other: &[u8; 32]) {
    for (a, b) in target.iter_mut().zip(other) { *a ^= b; }
}

fn parse_hex32(text: &str) -> [u8; 32] {
    hex::decode(text).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok()).unwrap_or([0u8; 32])
}

fn file_mac(key: &[u8; 32], path: &str, sha256: &str) -> String {
    let mut data = Vec::new();
    push_bytes(&mut data, b"file");
    push_bytes(&mut data, path.as_bytes());
    push_bytes(&mut data, sha256.as_bytes());
    hex::encode(hmac(key, &data))
}

fn head_mac(key: &[u8; 32], chain: &str, id: i64) -> String {
    record_mac(key, "head", Some(chain), id, &mut [])
}

// ── Schema and connection hooks ──────────────────────────────────────────────

fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS integrity_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS integrity_rows(tbl TEXT NOT NULL, rid INTEGER NOT NULL, seal TEXT NOT NULL, PRIMARY KEY(tbl, rid)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS integrity_audit(log_id INTEGER PRIMARY KEY, chain TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS integrity_files(stored_path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, seal TEXT NOT NULL);",
    )
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM integrity_meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO integrity_meta(key,value) VALUES(?1,?2)", params![key, value]).map(|_| ())
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", [name], |_| Ok(())).is_ok()
}

/// The tables whose rows are sealed: every ordinary rowid table except the ones listed above.
fn sealed_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND wr=0 ORDER BY name")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.into_iter()
        .filter(|name| !name.starts_with("sqlite_") && !name.starts_with("integrity_") && !UNSEALED_TABLES.contains(&name.as_str()))
        .collect())
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

fn quote(name: &str) -> String { format!("\"{}\"", name.replace('"', "\"\"")) }
fn literal(text: &str) -> String { format!("'{}'", text.replace('\'', "''")) }

fn register_functions(conn: &Connection, key: [u8; 32]) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    // cns_mac(domain, prev, rid, name1, value1, name2, value2, ...)
    conn.create_scalar_function("cns_mac", -1, flags, move |ctx| {
        if ctx.len() < 3 || ctx.len() % 2 == 0 {
            return Err(rusqlite::Error::UserFunctionError("cns_mac: wrong number of arguments".into()));
        }
        let domain: String = ctx.get(0)?;
        let prev: Option<String> = ctx.get(1)?;
        let rid: i64 = ctx.get(2)?;
        let mut names = Vec::with_capacity((ctx.len() - 3) / 2);
        for index in (3..ctx.len()).step_by(2) { names.push(ctx.get::<String>(index)?); }
        let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
            .map(|(n, name)| (name.as_str(), ctx.get_raw(4 + n * 2)))
            .collect();
        Ok(record_mac(&key, &domain, prev.as_deref(), rid, &mut pairs))
    })?;
    // cns_acc(acc, table, rid, seal): XOR the row's secret part into the accumulator.
    conn.create_scalar_function("cns_acc", 4, flags, move |ctx| {
        let acc: String = ctx.get(0)?;
        let table: String = ctx.get(1)?;
        let rid: i64 = ctx.get(2)?;
        let seal: Option<String> = ctx.get(3)?;
        let mut value = parse_hex32(&acc);
        xor_into(&mut value, &accumulator_part(&key, &table, rid, seal.as_deref()));
        Ok(hex::encode(value))
    })?;
    conn.create_scalar_function("cns_head", 2, flags, move |ctx| {
        let chain: String = ctx.get(0)?;
        let id: i64 = ctx.get(1)?;
        Ok(head_mac(&key, &chain, id))
    })?;
    Ok(())
}

/// Removes this module's TEMP triggers from the connection (before a restore swaps the database).
pub fn detach(conn: &Connection) {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'cns\\_%' ESCAPE '\\'")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
        .unwrap_or_default();
    for name in names {
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS temp.{}", quote(&name))).ok();
    }
}

fn install_triggers(conn: &Connection) -> rusqlite::Result<()> {
    detach(conn);
    // REPLACE conflicts then fire the delete triggers, so a replaced row's seal is removed too.
    // The trigger bodies use no `OR REPLACE` of their own: when the statement that fires them is
    // an UPSERT (`ON CONFLICT … DO UPDATE`, as `set_setting` uses), SQLite applies that statement's
    // conflict handling inside the trigger, and an `INSERT OR REPLACE` there fails as UNIQUE.
    conn.pragma_update(None, "recursive_triggers", "ON")?;
    let mut sql = String::new();
    for table in sealed_tables(conn)? {
        let cols = columns(conn, &table)?;
        if cols.len() * 2 + 3 > 990 { continue; }
        let pairs = |row: &str| cols.iter().map(|c| format!(", {}, {row}.{}", literal(c), quote(c))).collect::<String>();
        let t = literal(&table);
        let qt = quote(&table);
        let acc = |rid: &str| format!(
            "UPDATE main.integrity_meta SET value=cns_acc(value,{t},{rid},(SELECT seal FROM main.integrity_rows WHERE tbl={t} AND rid={rid})) WHERE key={};",
            literal(&format!("acc:{table}"))
        );
        let mac_new = format!("cns_mac({},NULL,new.rowid{})", literal(&format!("row:{table}")), pairs("new"));
        let mac_old = format!("cns_mac({},NULL,old.rowid{})", literal(&format!("row:{table}")), pairs("old"));
        sql.push_str(&format!(
            "CREATE TEMP TRIGGER {} AFTER INSERT ON main.{qt} BEGIN
               {acc_new}
               DELETE FROM main.integrity_rows WHERE tbl={t} AND rid=new.rowid;
               INSERT INTO main.integrity_rows(tbl,rid,seal) VALUES({t},new.rowid,{mac_new});
               {acc_new}
             END;
             CREATE TEMP TRIGGER {} AFTER DELETE ON main.{qt} BEGIN
               {acc_old}
               DELETE FROM main.integrity_rows WHERE tbl={t} AND rid=old.rowid;
             END;
             CREATE TEMP TRIGGER {} AFTER UPDATE ON main.{qt} BEGIN
               {acc_old}
               DELETE FROM main.integrity_rows WHERE tbl={t} AND rid=new.rowid AND old.rowid<>new.rowid;
               UPDATE main.integrity_rows SET rid=new.rowid,
                 seal=CASE WHEN seal={mac_old} THEN {mac_new} ELSE '{TAMPERED}' END
                 WHERE tbl={t} AND rid=old.rowid;
               INSERT INTO main.integrity_rows(tbl,rid,seal) SELECT {t},new.rowid,'{TAMPERED}'
                 WHERE NOT EXISTS(SELECT 1 FROM main.integrity_rows WHERE tbl={t} AND rid=new.rowid);
               {acc_new}
             END;\n",
            quote(&format!("cns_i_{table}")), quote(&format!("cns_d_{table}")), quote(&format!("cns_u_{table}")),
            acc_new = acc("new.rowid"), acc_old = acc("old.rowid"),
        ));
    }
    if table_exists(conn, "activity_log") {
        let cols = columns(conn, "activity_log")?;
        let pairs = cols.iter().map(|c| format!(", {}, new.{}", literal(c), quote(c))).collect::<String>();
        sql.push_str(&format!(
            "CREATE TEMP TRIGGER cns_log AFTER INSERT ON main.activity_log BEGIN
               DELETE FROM main.integrity_audit WHERE log_id=new.rowid;
               INSERT INTO main.integrity_audit(log_id,chain) VALUES(new.rowid,
                 cns_mac('log',(SELECT chain FROM main.integrity_audit WHERE log_id<new.rowid ORDER BY log_id DESC LIMIT 1),new.rowid{pairs}));
               DELETE FROM main.integrity_meta WHERE key='audit_head';
               INSERT INTO main.integrity_meta(key,value) VALUES('audit_head',
                 cns_head((SELECT chain FROM main.integrity_audit WHERE log_id=new.rowid),new.rowid));
             END;\n"
        ));
    }
    conn.execute_batch(&sql)
}

// ── State ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Sealed with this computer's key: everything is checked.
    Verified,
    /// Sealed elsewhere (another computer or Windows account), or restored/opened without seals
    /// after this computer had already sealed data: waits for a System Admin's approval.
    Unapproved,
    /// No key could be read or written on this computer (for example a read-only profile).
    Unavailable,
}

/// The state of an open connection's database, without changing anything.
pub fn state(conn: &Connection) -> State {
    let Ok(local) = local_key() else { return State::Unavailable };
    match meta(conn, "kid") {
        Some(kid) if kid == key_id(&local.key) => State::Verified,
        _ => State::Unapproved,
    }
}

fn has_seal_data(conn: &Connection) -> bool {
    ["integrity_rows", "integrity_audit", "integrity_files"].iter().any(|table| {
        conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table})"), [], |r| r.get::<_, bool>(0)).unwrap_or(false)
    })
}

/// Prepares a freshly opened connection to the live database. Seals the data automatically the
/// first time (the first start after the update, or a brand-new database); otherwise checks that it
/// was sealed on this computer. `new_database` is true when `open_at` just created the file.
/// Never fails the opening of the database: problems are reported by the health check.
pub fn attach(conn: &Connection, new_database: bool) -> State {
    let result = (|| -> Result<State, String> {
        ensure_tables(conn).map_err(|e| e.to_string())?;
        let local = local_key()?;
        register_functions(conn, local.key).map_err(|e| e.to_string())?;
        let kid = meta(conn, "kid");
        let verified = kid.as_deref() == Some(key_id(&local.key).as_str());
        if !verified {
            let first_time = kid.is_none() && !has_seal_data(conn) && (local.fresh || new_database);
            if !first_time { return Ok(State::Unapproved); }
            seal_everything(conn, &local.key, &HashSet::new()).map_err(|e| e.to_string())?;
            set_meta(conn, "sealed_at", &now()).map_err(|e| e.to_string())?;
        }
        install_triggers(conn).map_err(|e| e.to_string())?;
        Ok(State::Verified)
    })();
    match result {
        Ok(state) => state,
        Err(error) => {
            crate::errlog::record_backend("database", &format!("integrity: {error}"));
            State::Unavailable
        }
    }
}

fn now() -> String { chrono::Local::now().format("%Y-%m-%d %H:%M").to_string() }

/// Seals the current state of every row and of the whole audit log with this computer's key,
/// keeping `still_flagged` rows marked as changed outside the program. Files are sealed afterwards
/// by `seal_new_files`.
fn seal_everything(conn: &Connection, key: &[u8; 32], still_flagged: &HashSet<(String, i64)>) -> rusqlite::Result<()> {
    let own_tx = conn.is_autocommit();
    if own_tx { conn.execute_batch("BEGIN IMMEDIATE")?; }
    let result = (|| -> rusqlite::Result<()> {
        conn.execute_batch("DELETE FROM integrity_rows; DELETE FROM integrity_audit; DELETE FROM integrity_files;
                            DELETE FROM integrity_meta WHERE key LIKE 'acc:%' OR key='audit_head';")?;
        for table in sealed_tables(conn)? {
            let mut acc = accumulator_base(key, &table);
            let mut stmt = conn.prepare(&format!("SELECT rowid, * FROM {}", quote(&table)))?;
            let names: Vec<String> = stmt.column_names().skip(1).map(|n| n.to_string()).collect();
            let mut rows = stmt.query([])?;
            let mut insert = conn.prepare("INSERT INTO integrity_rows(tbl,rid,seal) VALUES(?1,?2,?3)")?;
            while let Some(row) = rows.next()? {
                let rid: i64 = row.get(0)?;
                let seal = if still_flagged.contains(&(table.clone(), rid)) {
                    TAMPERED.to_string()
                } else {
                    let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
                        .map(|(i, n)| Ok((n.as_str(), row.get_ref(i + 1)?)))
                        .collect::<rusqlite::Result<_>>()?;
                    record_mac(key, &format!("row:{table}"), None, rid, &mut pairs)
                };
                xor_into(&mut acc, &accumulator_part(key, &table, rid, Some(&seal)));
                insert.execute(params![table, rid, seal])?;
            }
            set_meta(conn, &format!("acc:{table}"), &hex::encode(acc))?;
        }
        if table_exists(conn, "activity_log") {
            let mut stmt = conn.prepare("SELECT rowid, * FROM activity_log ORDER BY rowid")?;
            let names: Vec<String> = stmt.column_names().skip(1).map(|n| n.to_string()).collect();
            let mut rows = stmt.query([])?;
            let mut insert = conn.prepare("INSERT INTO integrity_audit(log_id,chain) VALUES(?1,?2)")?;
            let mut prev: Option<String> = None;
            let mut last: Option<(i64, String)> = None;
            while let Some(row) = rows.next()? {
                let id: i64 = row.get(0)?;
                let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
                    .map(|(i, n)| Ok((n.as_str(), row.get_ref(i + 1)?)))
                    .collect::<rusqlite::Result<_>>()?;
                let chain = record_mac(key, "log", prev.as_deref(), id, &mut pairs);
                insert.execute(params![id, chain])?;
                prev = Some(chain.clone());
                last = Some((id, chain));
            }
            if let Some((id, chain)) = last { set_meta(conn, "audit_head", &head_mac(key, &chain, id))?; }
        }
        set_meta(conn, "kid", &key_id(key))?;
        Ok(())
    })();
    if own_tx {
        if result.is_ok() { conn.execute_batch("COMMIT")?; } else { conn.execute_batch("ROLLBACK").ok(); }
    }
    result
}

/// «اعتماد البيانات»: a System Admin accepts the data as it is now — after a move or restore to this
/// computer, or after changes made deliberately outside the program. Recorded in the audit log.
pub fn approve(conn: &Connection, user: &str, reason: &str) -> Result<(), AppError> {
    let local = local_key().map_err(AppError::Other)?;
    ensure_tables(conn)?;
    register_functions(conn, local.key)?;
    let before = state(conn);
    detach(conn);
    seal_everything(conn, &local.key, &HashSet::new())?;
    set_meta(conn, "approved_at", &now())?;
    set_meta(conn, "approved_by", user)?;
    install_triggers(conn)?;
    let details = format!("{reason}; before: {}", match before { State::Verified => "verified", State::Unapproved => "unapproved", State::Unavailable => "unavailable" });
    crate::services::log_activity(conn, user, "APPROVE_DATA_INTEGRITY", Some("settings"), None, None, Some(&details));
    seal_new_files(conn);
    Ok(())
}

/// After a schema upgrade of sealed data: re-seal every row with its new columns, keeping the rows
/// that were already changed outside the program flagged. Call with the set from `flagged_rows`
/// taken before the upgrade.
pub fn reseal_after_upgrade(conn: &Connection, flagged: &HashSet<(String, i64)>) {
    let Ok(local) = local_key() else { return };
    if state(conn) != State::Verified { return; }
    if let Err(error) = seal_everything(conn, &local.key, flagged) {
        crate::errlog::record_backend("database", &format!("integrity reseal: {error}"));
    }
}

/// The rows currently not matching their seal (for `reseal_after_upgrade`).
pub fn flagged_rows(conn: &Connection) -> HashSet<(String, i64)> {
    let Ok(local) = local_key() else { return HashSet::new() };
    if !table_exists(conn, "integrity_meta") || state(conn) != State::Verified { return HashSet::new(); }
    check_rows(conn, &local.key).map(|r| r.flagged).unwrap_or_default()
}

// ── Users ────────────────────────────────────────────────────────────────────

fn row_trusted(conn: &Connection, key: &[u8; 32], table: &str, rid: i64) -> rusqlite::Result<bool> {
    let stored: Option<String> = conn
        .query_row("SELECT seal FROM integrity_rows WHERE tbl=?1 AND rid=?2", params![table, rid], |r| r.get(0))
        .optional()?;
    let Some(stored) = stored else { return Ok(false) };
    let mut stmt = conn.prepare(&format!("SELECT rowid, * FROM {} WHERE rowid=?1", quote(table)))?;
    let names: Vec<String> = stmt.column_names().skip(1).map(|n| n.to_string()).collect();
    let mut rows = stmt.query([rid])?;
    let Some(row) = rows.next()? else { return Ok(false) };
    let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
        .map(|(i, n)| Ok((n.as_str(), row.get_ref(i + 1)?)))
        .collect::<rusqlite::Result<_>>()?;
    Ok(record_mac(key, &format!("row:{table}"), None, rid, &mut pairs) == stored)
}

/// False only when the data is verified on this computer and the user's row was changed or added
/// outside the program. Sign-in and every permission check refuse such an account.
pub fn user_trusted(conn: &Connection, user_id: i64) -> bool {
    if !table_exists(conn, "integrity_meta") { return true; }
    let Ok(local) = local_key() else { return true };
    if state(conn) != State::Verified { return true; }
    row_trusted(conn, &local.key, "users", user_id).unwrap_or(false)
}

/// False when the stored setting `key` was changed outside the program (its seal does not match).
/// A setting that is not stored is trusted (the built-in default applies).
pub fn setting_trusted(conn: &Connection, key: &str) -> bool {
    if !table_exists(conn, "integrity_meta") { return true; }
    let Ok(local) = local_key() else { return true };
    if state(conn) != State::Verified { return true; }
    let rid: Option<i64> = conn
        .query_row("SELECT rowid FROM app_settings WHERE key=?1", params![key], |r| r.get(0))
        .optional().ok().flatten();
    let Some(rid) = rid else { return true };
    row_trusted(conn, &local.key, "app_settings", rid).unwrap_or(false)
}

/// Shown on the sign-in screen for an account changed outside the program.
pub const TAMPERED_ACCOUNT_MESSAGE: &str =
    "تم تعديل بيانات هذا الحساب من خارج البرنامج، لذلك أُوقف الدخول به. اطلب من المسؤول حذف الحساب وإنشاءه من جديد، أو اعتماد البيانات من «الفحص والدعم».";

// ── Files ────────────────────────────────────────────────────────────────────

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

fn file_on_disk(conn: &Connection, relative: &str) -> Option<PathBuf> {
    let path = crate::files::safe_relative_path(relative).ok()?;
    let full = crate::services::storage_path(conn).join(path);
    full.is_file().then_some(full)
}

/// Seals one stored file right after the program wrote it (same transaction as its metadata).
pub fn seal_file(conn: &Connection, relative: &str, full_path: &Path) -> Result<(), AppError> {
    if !table_exists(conn, "integrity_files") || state(conn) != State::Verified { return Ok(()); }
    let local = local_key().map_err(AppError::Other)?;
    let sha = sha256_file(full_path).map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT OR REPLACE INTO integrity_files(stored_path,sha256,seal) VALUES(?1,?2,?3)",
        params![relative, sha, file_mac(&local.key, relative, &sha)],
    )?;
    Ok(())
}

/// Every file path the metadata refers to, with the metadata row's rowid.
fn referenced_files(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let cols = columns(conn, "document_metadata")?;
    let mut select = vec!["stored_path".to_string()];
    for extra in ["original_path", "processed_path"] {
        if cols.iter().any(|c| c == extra) { select.push(extra.into()); }
    }
    let mut stmt = conn.prepare(&format!("SELECT rowid, {} FROM document_metadata", select.join(",")))?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let rid: i64 = row.get(0)?;
        for index in 0..select.len() {
            if let Some(path) = row.get::<_, Option<String>>(index + 1)? {
                if !path.trim().is_empty() { out.push((rid, path)); }
            }
        }
    }
    Ok(out)
}

/// Seals stored files that have no seal yet (the existing attachments after the first start, files
/// written before a seal could be taken), when the metadata row that names them is itself trusted.
/// Runs in the background; returns how many were sealed.
pub fn seal_new_files(conn: &Connection) -> usize {
    let Ok(local) = local_key() else { return 0 };
    if !table_exists(conn, "integrity_files") || !table_exists(conn, "document_metadata") || state(conn) != State::Verified { return 0; }
    let Ok(files) = referenced_files(conn) else { return 0 };
    let sealed: HashSet<String> = conn
        .prepare("SELECT stored_path FROM integrity_files")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
        .unwrap_or_default();
    let mut count = 0;
    for (rid, relative) in files {
        if sealed.contains(&relative) { continue; }
        if !row_trusted(conn, &local.key, "document_metadata", rid).unwrap_or(false) { continue; }
        let Some(full) = file_on_disk(conn, &relative) else { continue };
        let Ok(sha) = sha256_file(&full) else { continue };
        if conn.execute(
            "INSERT OR IGNORE INTO integrity_files(stored_path,sha256,seal) VALUES(?1,?2,?3)",
            params![relative, sha, file_mac(&local.key, &relative, &sha)],
        ).is_ok() { count += 1; }
    }
    // Forget seals of files the program no longer refers to (deleted attachments).
    conn.execute(
        "DELETE FROM integrity_files WHERE stored_path NOT IN (SELECT stored_path FROM document_metadata)
           AND stored_path NOT IN (SELECT original_path FROM document_metadata WHERE original_path IS NOT NULL)
           AND stored_path NOT IN (SELECT processed_path FROM document_metadata WHERE processed_path IS NOT NULL)",
        [],
    ).ok();
    count
}

// ── Checking ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct RowCheck {
    sealed: usize,
    changed: BTreeMap<String, usize>,
    added: BTreeMap<String, usize>,
    removed: BTreeMap<String, usize>,
    flagged: HashSet<(String, i64)>,
    tampered_users: Vec<String>,
}

fn check_rows(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<RowCheck> {
    let mut check = RowCheck::default();
    for table in sealed_tables(conn)? {
        let mut seals: HashMap<i64, String> = conn
            .prepare("SELECT rid, seal FROM integrity_rows WHERE tbl=?1")?
            .query_map([&table], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut acc = accumulator_base(key, &table);
        for (rid, seal) in &seals { xor_into(&mut acc, &accumulator_part(key, &table, *rid, Some(seal))); }
        let stored_acc = meta(conn, &format!("acc:{table}"));
        let mut stmt = conn.prepare(&format!("SELECT rowid, * FROM {}", quote(&table)))?;
        let names: Vec<String> = stmt.column_names().skip(1).map(|n| n.to_string()).collect();
        let username_index = (table == "users").then(|| names.iter().position(|n| n == "username")).flatten();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let rid: i64 = row.get(0)?;
            let ok = match seals.remove(&rid) {
                None => { *check.added.entry(table.clone()).or_default() += 1; false }
                Some(seal) => {
                    let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
                        .map(|(i, n)| Ok((n.as_str(), row.get_ref(i + 1)?)))
                        .collect::<rusqlite::Result<_>>()?;
                    let good = seal == record_mac(key, &format!("row:{table}"), None, rid, &mut pairs);
                    if good { check.sealed += 1; } else { *check.changed.entry(table.clone()).or_default() += 1; }
                    good
                }
            };
            if !ok {
                check.flagged.insert((table.clone(), rid));
                if let Some(index) = username_index {
                    if let Ok(name) = row.get::<_, String>(index + 1) { check.tampered_users.push(name); }
                }
            }
        }
        // Seals left over belong to rows that are gone; a wrong accumulator means rows were removed
        // together with their seals.
        let mut removed = seals.len();
        if removed == 0 && stored_acc.as_deref() != Some(hex::encode(acc).as_str()) { removed = 1; }
        if removed > 0 { *check.removed.entry(table.clone()).or_default() += removed; }
    }
    Ok(check)
}

#[derive(Default)]
struct AuditCheck { entries: usize, unsealed: usize, broken: usize, removed: usize, head_ok: bool }

fn check_audit(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<AuditCheck> {
    let mut check = AuditCheck { head_ok: true, ..Default::default() };
    if !table_exists(conn, "activity_log") { return Ok(check); }
    let mut chains: HashMap<i64, String> = conn
        .prepare("SELECT log_id, chain FROM integrity_audit")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare("SELECT rowid, * FROM activity_log ORDER BY rowid")?;
    let names: Vec<String> = stmt.column_names().skip(1).map(|n| n.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut prev: Option<String> = None;
    let mut last: Option<(i64, String)> = None;
    while let Some(row) = rows.next()? {
        check.entries += 1;
        let id: i64 = row.get(0)?;
        let mut pairs: Vec<(&str, ValueRef<'_>)> = names.iter().enumerate()
            .map(|(i, n)| Ok((n.as_str(), row.get_ref(i + 1)?)))
            .collect::<rusqlite::Result<_>>()?;
        let expected = record_mac(key, "log", prev.as_deref(), id, &mut pairs);
        match chains.remove(&id) {
            None => { check.unsealed += 1; prev = Some(expected); }
            Some(stored) => {
                if stored != expected { check.broken += 1; }
                last = Some((id, stored.clone()));
                prev = Some(stored);
            }
        }
    }
    check.removed = chains.len();
    let head = meta(conn, "audit_head");
    check.head_ok = match (&last, head) {
        (Some((id, chain)), Some(head)) => head == head_mac(key, chain, *id),
        (None, None) => true,
        _ => false,
    };
    Ok(check)
}

#[derive(Default)]
struct FileCheck { sealed: usize, changed: usize, unsealed: usize }

fn check_files(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<FileCheck> {
    let mut check = FileCheck::default();
    if !table_exists(conn, "document_metadata") { return Ok(check); }
    let seals: HashMap<String, (String, String)> = conn
        .prepare("SELECT stored_path, sha256, seal FROM integrity_files")?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let mut seen = HashSet::new();
    for (_, relative) in referenced_files(conn)? {
        if !seen.insert(relative.clone()) { continue; }
        let Some(full) = file_on_disk(conn, &relative) else { continue }; // missing files: «الملفات المرفقة»
        match seals.get(&relative) {
            None => check.unsealed += 1,
            Some((sha, seal)) => {
                let actual = sha256_file(&full).unwrap_or_default();
                if *seal != file_mac(key, &relative, sha) || actual != *sha { check.changed += 1; } else { check.sealed += 1; }
            }
        }
    }
    Ok(check)
}

fn table_label(table: &str) -> &'static str {
    match table {
        "users" => "المستخدمون",
        "employees" | "employee_spouses" | "employee_family_members" | "employee_vehicles" | "grade_history" | "name_split_originals" => "بيانات الموظفين",
        "employee_attachments" | "document_metadata" | "general_doc_attachments" | "outgoing_doc_attachments" => "سجلات المرفقات",
        "general_docs" | "general_doc_employees" => "أرشيف الوثائق",
        "outgoing_docs" | "outgoing_doc_employees" => "الكتب الصادرة",
        "app_settings" | "company_config" => "الإعدادات",
        _ => "بيانات أخرى",
    }
}

fn by_label(counts: &BTreeMap<String, usize>) -> String {
    let mut labels: BTreeMap<&str, usize> = BTreeMap::new();
    for (table, n) in counts { *labels.entry(table_label(table)).or_default() += n; }
    labels.iter().map(|(label, n)| format!("{label}: {n}")).collect::<Vec<_>>().join("، ")
}

/// Full result for «الفحص والدعم». Only counts; no names, values or paths.
pub struct Report {
    pub status: &'static str,
    pub details: Vec<String>,
    /// The System Admin can approve the current state from the health screen.
    pub can_approve: bool,
}

pub fn report(conn: &Connection, with_files: bool) -> Report {
    let approved = meta(conn, "approved_at").map(|at| format!("آخر اعتماد للبيانات: {at}"));
    match state(conn) {
        State::Unavailable => Report {
            status: "warn",
            details: vec!["تعذر تجهيز مفتاح التحقق على هذا الجهاز، لذلك لا يمكن كشف التعديلات من خارج البرنامج.".into()],
            can_approve: false,
        },
        State::Unapproved => Report {
            status: "warn",
            details: vec![
                "هذه البيانات منقولة من جهاز آخر أو حساب ويندوز آخر، أو مستعادة، ولم تُعتمد على هذا الجهاز بعد.".into(),
                "لا يمكن التحقق من سلامتها حتى يعتمدها المسؤول. إذا لم تنقل البيانات أنت، فقد يكون هذا تلاعبًا.".into(),
            ],
            can_approve: true,
        },
        State::Verified => {
            let Ok(local) = local_key() else { return Report { status: "warn", details: vec![], can_approve: false } };
            let rows = check_rows(conn, &local.key);
            let audit = check_audit(conn, &local.key);
            let files = if with_files { check_files(conn, &local.key).ok() } else { None };
            let (Ok(rows), Ok(audit)) = (rows, audit) else {
                return Report { status: "warn", details: vec!["تعذر إكمال فحص التلاعب.".into()], can_approve: false };
            };
            let mut details = Vec::new();
            let mut tampered = false;
            if !rows.changed.is_empty() { tampered = true; details.push(format!("سجلات عُدّلت من خارج البرنامج: {}", by_label(&rows.changed))); }
            if !rows.added.is_empty() { tampered = true; details.push(format!("سجلات أُضيفت من خارج البرنامج: {}", by_label(&rows.added))); }
            if !rows.removed.is_empty() { tampered = true; details.push(format!("سجلات حُذفت من خارج البرنامج: {}", by_label(&rows.removed))); }
            if audit.broken > 0 || audit.removed > 0 || audit.unsealed > 0 || !audit.head_ok {
                tampered = true;
                details.push("سجل النظام: عُدّلت أو حُذفت أو أُضيفت عمليات من خارج البرنامج".into());
            }
            if let Some(files) = &files {
                if files.changed > 0 { tampered = true; details.push(format!("مرفقات تغيّر محتواها من خارج البرنامج: {}", files.changed)); }
            }
            if tampered {
                details.push("إذا كانت هذه التعديلات مقصودة ومعروفة لك، يستطيع المسؤول اعتماد الحالة الحالية.".into());
            } else {
                details.push("لم يُكتشف أي تعديل من خارج البرنامج".into());
            }
            let mut counts = format!("السجلات المحمية: {} · عمليات سجل النظام: {}", rows.sealed, audit.entries);
            if let Some(files) = &files {
                counts.push_str(&format!(" · المرفقات المحمية: {}", files.sealed));
                if files.unsealed > 0 { counts.push_str(&format!(" · مرفقات بانتظار الختم: {}", files.unsealed)); }
            }
            details.push(counts);
            if let Some(approved) = approved { details.push(approved); }
            Report { status: if tampered { "fail" } else { "ok" }, details, can_approve: tampered }
        }
    }
}

/// For the System Admin after sign-in (rows and audit only, no file hashing).
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub state: State,
    pub tampered: bool,
    /// Accounts changed or added outside the program (shown to the System Admin only).
    pub tampered_users: Vec<String>,
}

pub fn status(conn: &Connection) -> Status {
    let current = state(conn);
    if current != State::Verified { return Status { state: current, tampered: false, tampered_users: vec![] }; }
    let Ok(local) = local_key() else { return Status { state: State::Unavailable, tampered: false, tampered_users: vec![] } };
    let rows = check_rows(conn, &local.key).unwrap_or_default();
    let audit = check_audit(conn, &local.key).unwrap_or(AuditCheck { head_ok: true, ..Default::default() });
    let tampered = !rows.flagged.is_empty() || !rows.removed.is_empty() || audit.broken > 0 || audit.removed > 0 || audit.unsealed > 0 || !audit.head_ok;
    Status { state: current, tampered, tampered_users: rows.tampered_users }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed_db() -> Connection {
        test_use_new_key(true);
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_tests(&conn);
        conn.execute("INSERT INTO users(username,password,role) VALUES('admin','$2b$12$x','system_admin'),('clerk','$2b$12$y','viewer')", []).unwrap();
        conn.execute("INSERT INTO employees(employee_number,full_name) VALUES('E-1','موظف أول'),('E-2','موظف ثان')", []).unwrap();
        conn.execute("INSERT INTO activity_log(username,action) VALUES('admin','LOGIN'),('admin','LOGOUT')", []).unwrap();
        assert_eq!(attach(&conn, false), State::Verified);
        conn
    }

    /// An outside tool: a plain connection without the program's functions and triggers.
    fn outside(conn: &Connection, sql: &str) {
        detach(conn);
        conn.execute_batch(sql).unwrap();
        install_triggers(conn).unwrap();
    }

    fn user_id(conn: &Connection, name: &str) -> i64 {
        conn.query_row("SELECT id FROM users WHERE username=?1", [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn first_start_seals_and_program_changes_stay_valid() {
        let conn = sealed_db();
        assert_eq!(report(&conn, true).status, "ok", "{:?}", report(&conn, true).details);
        conn.execute("UPDATE employees SET full_name='اسم جديد' WHERE employee_number='E-1'", []).unwrap();
        conn.execute("INSERT INTO employees(employee_number,full_name) VALUES('E-3','موظف ثالث')", []).unwrap();
        conn.execute("DELETE FROM employees WHERE employee_number='E-2'", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('theme','dark')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('theme','light')", []).unwrap();
        crate::services::log_activity(&conn, "admin", "CREATE_EMPLOYEE", None, None, None, None);
        let result = report(&conn, true);
        assert_eq!(result.status, "ok", "{:?}", result.details);
        assert!(user_trusted(&conn, user_id(&conn, "admin")));
    }

    /// The program saves settings with an UPSERT (`ON CONFLICT … DO UPDATE`). The seal triggers
    /// must keep working when that UPSERT updates an existing row (automatic backup bookkeeping).
    #[test]
    fn upsert_of_an_existing_row_keeps_its_seal() {
        let conn = sealed_db();
        let upsert = "INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        conn.execute(upsert, ["auto_backup_last_daily", "2026-11-23"]).unwrap();
        conn.execute(upsert, ["auto_backup_last_daily", "2026-11-24"]).unwrap();
        conn.execute(upsert, ["auto_backup_last_daily", "2026-11-25"]).unwrap();
        let result = report(&conn, true);
        assert_eq!(result.status, "ok", "{:?}", result.details);
    }

    #[test]
    fn outside_row_changes_are_detected() {
        let conn = sealed_db();
        outside(&conn, "UPDATE users SET role='system_admin' WHERE username='clerk'");
        assert!(!user_trusted(&conn, user_id(&conn, "clerk")));
        assert!(user_trusted(&conn, user_id(&conn, "admin")));
        let s = status(&conn);
        assert!(s.tampered);
        assert_eq!(s.tampered_users, vec!["clerk".to_string()]);
        // A later edit by the program does not hide it.
        conn.execute("UPDATE users SET must_change_password=1 WHERE username='clerk'", []).unwrap();
        assert!(!user_trusted(&conn, user_id(&conn, "clerk")));
        let result = report(&conn, false);
        assert_eq!(result.status, "fail");
        assert!(result.details.iter().any(|l| l.contains("عُدّلت") && l.contains("المستخدمون")), "{:?}", result.details);
    }

    #[test]
    fn role_permissions_changed_outside_the_program_fall_back_to_the_built_in_ones() {
        let conn = sealed_db();
        let saved = crate::services::RoleGroups { archive_officer: vec!["print".into()], viewer: vec![] };
        crate::services::set_setting(&conn, "role_permissions", &serde_json::to_string(&saved).unwrap()).unwrap();
        assert!(setting_trusted(&conn, "role_permissions"));
        assert_eq!(crate::services::role_groups(&conn), saved);
        // Someone gives «مشاهد» the delete row with a database tool.
        outside(&conn, r#"UPDATE app_settings SET value='{"archive_officer":["print"],"viewer":["delete"]}' WHERE key='role_permissions'"#);
        assert!(!setting_trusted(&conn, "role_permissions"));
        let groups = crate::services::role_groups(&conn);
        assert_eq!(groups.viewer, vec!["print"], "built-in, not the outside change");
        assert!(!crate::services::effective_permissions(&conn, "viewer").iter().any(|p| p == "employees.delete"));
    }

    #[test]
    fn outside_inserts_and_deletions_are_detected() {
        let conn = sealed_db();
        outside(&conn, "INSERT INTO users(username,password,role) VALUES('intruder','$2b$12$z','system_admin')");
        assert!(!user_trusted(&conn, user_id(&conn, "intruder")));
        let conn = sealed_db();
        outside(&conn, "DELETE FROM employees WHERE employee_number='E-2'");
        assert!(report(&conn, false).details.iter().any(|l| l.contains("حُذفت")));
        // Deleting the row together with its seal is caught by the accumulator.
        let conn = sealed_db();
        outside(&conn, "DELETE FROM integrity_rows WHERE tbl='employees' AND rid=(SELECT rowid FROM employees WHERE employee_number='E-2');
                        DELETE FROM employees WHERE employee_number='E-2';");
        assert!(report(&conn, false).details.iter().any(|l| l.contains("حُذفت")));
    }

    #[test]
    fn audit_log_tampering_is_detected() {
        for sql in [
            "DROP TRIGGER activity_log_no_delete; DELETE FROM activity_log WHERE action='LOGIN';",
            "DROP TRIGGER activity_log_no_update; UPDATE activity_log SET action='VIEW' WHERE action='LOGIN';",
            "INSERT INTO activity_log(username,action) VALUES('admin','FAKE')",
            "DROP TRIGGER activity_log_no_delete; DELETE FROM activity_log WHERE action='LOGOUT'; DELETE FROM integrity_audit WHERE log_id=(SELECT MAX(log_id) FROM integrity_audit);",
        ] {
            let conn = sealed_db();
            outside(&conn, sql);
            assert_eq!(report(&conn, false).status, "fail", "not detected: {sql}");
        }
    }

    #[test]
    fn sign_in_and_permissions_refuse_an_account_changed_outside() {
        let conn = sealed_db();
        let hash = bcrypt::hash("Correct-Horse-1", 4).unwrap();
        conn.execute("UPDATE users SET password=?1 WHERE username='clerk'", [&hash]).unwrap();
        assert!(crate::services::login(&conn, "clerk", "Correct-Horse-1").is_ok());
        outside(&conn, "UPDATE users SET role='system_admin' WHERE username='clerk'");
        match crate::services::login(&conn, "clerk", "Correct-Horse-1") {
            Err(AppError::Validation(message)) => assert_eq!(message, TAMPERED_ACCOUNT_MESSAGE),
            other => panic!("unexpected: {:?}", other.map(|u| u.username)),
        }
        assert!(crate::services::assert_permission(&conn, "clerk", "users.manage").is_err());
        assert!(crate::services::assert_permission(&conn, "admin", "users.manage").is_ok());
        // Approving the current state is the System Admin's repair.
        approve(&conn, "admin", "test").unwrap();
        assert!(crate::services::assert_permission(&conn, "clerk", "users.manage").is_ok());
    }

    #[test]
    fn another_computer_needs_approval_then_verifies() {
        let conn = sealed_db();
        test_use_new_key(false);
        detach(&conn);
        assert_eq!(attach(&conn, false), State::Unapproved);
        assert!(user_trusted(&conn, user_id(&conn, "clerk")), "nothing is enforced before approval");
        assert_eq!(report(&conn, false).status, "warn");
        approve(&conn, "admin", "test").unwrap();
        assert_eq!(state(&conn), State::Verified);
        let result = report(&conn, true);
        assert_eq!(result.status, "ok", "{:?}", result.details);
        let approvals: i64 = conn.query_row("SELECT COUNT(*) FROM activity_log WHERE action='APPROVE_DATA_INTEGRITY'", [], |r| r.get(0)).unwrap();
        assert_eq!(approvals, 1);
    }

    #[test]
    fn unsealed_data_is_sealed_silently_only_on_first_use() {
        test_use_new_key(false);
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_tests(&conn);
        assert_eq!(attach(&conn, false), State::Unapproved, "a key that already existed means this data should have been sealed");
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_tests(&conn);
        assert_eq!(attach(&conn, true), State::Verified, "a brand-new database is sealed");
    }

    #[test]
    fn replaced_attachment_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        crate::services::TEST_STORAGE_ROOT.with(|root| *root.borrow_mut() = Some(dir.path().to_path_buf()));
        let conn = sealed_db();
        std::fs::create_dir_all(dir.path().join("Files/Employees/1")).unwrap();
        std::fs::write(dir.path().join("Files/Employees/1/a.pdf"), b"%PDF-1.7 original").unwrap();
        conn.execute("INSERT INTO document_metadata(stored_path,original_name,mime_type,size_bytes) VALUES('Files/Employees/1/a.pdf','a.pdf','application/pdf',17)", []).unwrap();
        assert_eq!(seal_new_files(&conn), 1);
        assert_eq!(report(&conn, true).status, "ok");
        std::fs::write(dir.path().join("Files/Employees/1/a.pdf"), b"%PDF-1.7 replaced").unwrap();
        let result = report(&conn, true);
        assert_eq!(result.status, "fail");
        assert!(result.details.iter().any(|l| l.contains("مرفقات تغيّر")), "{:?}", result.details);
        crate::services::TEST_STORAGE_ROOT.with(|root| *root.borrow_mut() = None);
    }

    #[test]
    fn foreign_key_cascades_keep_seals_consistent() {
        let conn = sealed_db();
        let id: i64 = conn.query_row("SELECT id FROM employees WHERE employee_number='E-1'", [], |r| r.get(0)).unwrap();
        conn.execute("PRAGMA foreign_keys=ON", []).unwrap();
        conn.execute("INSERT INTO employee_vehicles(employee_id,plate) VALUES(?1,'123')", [id]).unwrap();
        conn.execute("DELETE FROM employees WHERE id=?1", [id]).unwrap();
        let result = report(&conn, false);
        assert_eq!(result.status, "ok", "{:?}", result.details);
    }

    #[test]
    fn schema_upgrade_reseal_keeps_flags() {
        let conn = sealed_db();
        outside(&conn, "UPDATE employees SET full_name='x' WHERE employee_number='E-2'");
        let flagged = flagged_rows(&conn);
        detach(&conn);
        conn.execute_batch("ALTER TABLE employees ADD COLUMN test_flag INTEGER NOT NULL DEFAULT 0").unwrap();
        reseal_after_upgrade(&conn, &flagged);
        install_triggers(&conn).unwrap();
        let s = status(&conn);
        assert!(s.tampered);
        let result = report(&conn, false);
        assert!(result.details.iter().any(|l| l.contains("بيانات الموظفين: 1")), "{:?}", result.details);
    }
}
