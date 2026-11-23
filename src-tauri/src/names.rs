//! Person names split into the fields of the Iraqi national card and the passport.
//!
//! The combined text column (`full_name`, `mother_name`, spouse `name`, ...) stays the
//! source for display, search, sorting and reports. The parts live beside it in a
//! `name_parts` JSON column, and every save rebuilds the combined text from the parts.
//! Splitting an existing name is best effort: anything the splitter is unsure about is
//! flagged `review` so a person can confirm it, and every original text is copied to
//! `name_split_originals` before the first split, so nothing is ever lost.

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// الاسم، الأب، الجد، اللقب
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArabicName {
    #[serde(default)] pub first: String,
    #[serde(default)] pub father: String,
    #[serde(default)] pub grandfather: String,
    #[serde(default)] pub surname: String,
    #[serde(default)] pub review: bool,
}

/// Given names / Surname, as printed in the passport.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassportName {
    #[serde(default)] pub given: String,
    #[serde(default)] pub surname: String,
    #[serde(default)] pub review: bool,
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl ArabicName {
    pub fn joined(&self) -> String {
        [&self.first, &self.father, &self.grandfather, &self.surname]
            .iter()
            .map(|part| clean(part))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn trimmed(mut self) -> Self {
        for part in [&mut self.first, &mut self.father, &mut self.grandfather, &mut self.surname] {
            *part = clean(part);
        }
        self
    }
}

impl PassportName {
    pub fn joined(&self) -> String {
        [clean(&self.given), clean(&self.surname)].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
    }
    fn trimmed(mut self) -> Self {
        self.given = clean(&self.given);
        self.surname = clean(&self.surname);
        self
    }
}

const PREFIXES: [&str; 6] = ["عبد", "ابو", "أبو", "آل", "ال", "بن"];
const SUFFIXES: [&str; 3] = ["الله", "الدين", "الرحمن"];

/// Words joined with a neighbour: "عبد الله", "أبو بكر", "آل محمد", "نور الدين", "فتح الله".
fn tokens(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let mut token = words[i].to_string();
        while PREFIXES.contains(&words[i]) && i + 1 < words.len() {
            i += 1;
            token = format!("{token} {}", words[i]);
        }
        i += 1;
        while i < words.len() && SUFFIXES.contains(&words[i]) && !token.ends_with(words[i]) {
            token = format!("{token} {}", words[i]);
            i += 1;
        }
        result.push(token);
    }
    result
}

fn looks_like_surname(token: &str) -> bool {
    token.starts_with("ال") || token.starts_with("آل ") || token.starts_with("ال ")
}

/// Best-effort split of an Arabic name into الاسم، الأب، الجد، اللقب. Confident only for
/// four parts ending in a surname-like word (starts with "ال" or "آل"). Everything else is
/// filled in order and flagged: extra words go to the surname so no text is lost.
pub fn split_arabic(text: &str) -> ArabicName {
    let parts = tokens(text);
    let take = |i: usize| parts.get(i).cloned().unwrap_or_default();
    match parts.len() {
        0 => ArabicName::default(),
        4 if looks_like_surname(&parts[3]) => {
            ArabicName { first: take(0), father: take(1), grandfather: take(2), surname: take(3), review: false }
        }
        3 if looks_like_surname(&parts[2]) => {
            ArabicName { first: take(0), father: take(1), surname: take(2), review: true, ..Default::default() }
        }
        n if n <= 3 => ArabicName { first: take(0), father: take(1), grandfather: take(2), review: true, ..Default::default() },
        _ => ArabicName { first: take(0), father: take(1), grandfather: take(2), surname: parts[3..].join(" "), review: true },
    }
}

/// Passport names: the last word is the surname, the rest are the given names.
pub fn split_passport(text: &str) -> PassportName {
    let words: Vec<&str> = text.split_whitespace().collect();
    match words.len() {
        0 => PassportName::default(),
        1 => PassportName { given: words[0].to_string(), review: true, ..Default::default() },
        n => PassportName { given: words[..n - 1].join(" "), surname: words[n - 1].to_string(), review: false },
    }
}

/// Decides the parts to store for one name on save.
/// * parts sent by the form win, and the combined text is rebuilt from them;
/// * otherwise the stored parts are kept while they still match the text;
/// * otherwise the text is split again (best effort, flagged when unsure).
/// Returns the combined text and the parts (both None when the name is empty).
fn resolve<T>(sent: Option<&Value>, stored: Option<&Value>, text: Option<&str>, normalize: fn(T) -> T, joined: fn(&T) -> String, split: fn(&str) -> T) -> (Option<String>, Option<Value>)
where
    T: Serialize + for<'de> Deserialize<'de>,
{
    let parse = |value: Option<&Value>| value.and_then(|v| serde_json::from_value::<T>(v.clone()).ok()).map(normalize);
    let text = text.map(clean).filter(|t| !t.is_empty());
    if let Some(parts) = parse(sent) {
        let combined = joined(&parts);
        if !combined.is_empty() {
            return (Some(combined), serde_json::to_value(parts).ok());
        }
    }
    let Some(text) = text else { return (None, None) };
    if let Some(parts) = parse(stored) {
        if joined(&parts) == text {
            return (Some(text), serde_json::to_value(parts).ok());
        }
    }
    let parts = split(&text);
    (Some(text), serde_json::to_value(parts).ok())
}

pub fn resolve_arabic(sent: Option<&Value>, stored: Option<&Value>, text: Option<&str>) -> (Option<String>, Option<Value>) {
    resolve::<ArabicName>(sent, stored, text, ArabicName::trimmed, ArabicName::joined, split_arabic)
}

pub fn resolve_passport(sent: Option<&Value>, stored: Option<&Value>, text: Option<&str>) -> (Option<String>, Option<Value>) {
    resolve::<PassportName>(sent, stored, text, PassportName::trimmed, PassportName::joined, split_passport)
}

/// Parses a `name_parts` column or field into a JSON object (empty when absent/invalid).
pub fn parts_object(value: Option<&str>) -> Map<String, Value> {
    value.and_then(|v| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn parts_from_value(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(text)) => parts_object(Some(text)),
        _ => Map::new(),
    }
}

/// Which names of which table are split, and how.
pub const EMPLOYEE_ARABIC: [&str; 3] = ["full_name", "mother_name", "residence_head_name"];
pub const EMPLOYEE_PASSPORT: [&str; 1] = ["passport_name"];
pub const SPOUSE_ARABIC: [&str; 2] = ["name", "mother_name"];
pub const FAMILY_ARABIC: [&str; 1] = ["name"];

fn has_column(conn: &Connection, table: &str, column: &str) -> SqlResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<Vec<_>>>()?;
    Ok(columns.iter().any(|c| c == column))
}

fn split_rows(conn: &Connection, table: &str, arabic: &[&str], passport: &[&str], employee_column: &str) -> SqlResult<()> {
    let fields: Vec<&str> = arabic.iter().chain(passport.iter()).copied().collect();
    let select = format!("SELECT id,{employee_column},{} FROM {table} WHERE name_parts IS NULL", fields.join(","));
    let rows: Vec<(i64, Option<i64>, Vec<Option<String>>)> = {
        let mut stmt = conn.prepare(&select)?;
        let rows = stmt.query_map([], |r| {
            let mut values = Vec::new();
            for i in 0..fields.len() {
                values.push(r.get::<_, Option<String>>(i + 2)?);
            }
            Ok((r.get(0)?, r.get(1)?, values))
        })?.collect::<SqlResult<Vec<_>>>()?;
        rows
    };
    for (id, employee_id, values) in rows {
        let mut parts = Map::new();
        for (field, value) in fields.iter().zip(values.iter()) {
            let Some(original) = value.as_deref().filter(|v| !v.trim().is_empty()) else { continue };
            conn.execute(
                "INSERT INTO name_split_originals(table_name,row_id,employee_id,field,original_text) VALUES(?1,?2,?3,?4,?5)",
                params![table, id, employee_id, field, original],
            )?;
            let split = if passport.contains(field) {
                serde_json::to_value(split_passport(original))
            } else {
                serde_json::to_value(split_arabic(original))
            };
            if let Ok(split) = split {
                parts.insert(field.to_string(), split);
            }
        }
        if !parts.is_empty() {
            conn.execute(&format!("UPDATE {table} SET name_parts=?1 WHERE id=?2"), params![Value::Object(parts).to_string(), id])?;
        }
    }
    Ok(())
}

/// Schema step 2: adds the `name_parts` columns and splits every existing name.
/// Runs inside the versioned upgrade, after the verified PreUpgrade snapshot.
/// The combined text columns are left exactly as they were.
pub fn upgrade_to_v2(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS name_split_originals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name    TEXT NOT NULL,
            row_id        INTEGER NOT NULL,
            employee_id   INTEGER,
            field         TEXT NOT NULL,
            original_text TEXT NOT NULL,
            created_at    TEXT DEFAULT (datetime('now'))
        );",
    )?;
    for table in ["employees", "employee_spouses", "employee_family_members"] {
        if !has_column(conn, table, "name_parts")? {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN name_parts TEXT"), [])?;
        }
    }
    // Only rows without parts are split, so a repeated run changes nothing.
    split_rows(conn, "employees", &EMPLOYEE_ARABIC, &EMPLOYEE_PASSPORT, "id")?;
    split_rows(conn, "employee_spouses", &SPOUSE_ARABIC, &[], "employee_id")?;
    split_rows(conn, "employee_family_members", &FAMILY_ARABIC, &[], "employee_id")?;
    Ok(())
}

/// One name waiting for review, for the review screen.
#[derive(Debug, Serialize)]
pub struct ReviewItem {
    pub employee_id: i64,
    pub employee_name: String,
    /// "employee", "spouse" or "family"
    pub owner: String,
    /// Position of the spouse / family member (0 for the employee).
    pub index: i64,
    pub field: String,
    pub text: String,
    pub original_text: Option<String>,
    pub parts: Value,
}

fn original_for(conn: &Connection, table: &str, employee_id: i64, row_id: i64, field: &str) -> Option<String> {
    conn.query_row(
        "SELECT original_text FROM name_split_originals WHERE table_name=?1 AND employee_id=?2 AND field=?3 AND (row_id=?4 OR table_name<>'employees')
         ORDER BY (row_id=?4) DESC, id LIMIT 1",
        params![table, employee_id, field, row_id],
        |r| r.get(0),
    ).ok()
}

pub fn list_review(conn: &Connection) -> SqlResult<Vec<ReviewItem>> {
    let mut items = Vec::new();
    let sources: [(&str, &str, &[&str], &str); 3] = [
        ("employees", "employee", &["full_name", "mother_name", "residence_head_name", "passport_name"], "id"),
        ("employee_spouses", "spouse", &["name", "mother_name"], "employee_id"),
        ("employee_family_members", "family", &["name"], "employee_id"),
    ];
    for (table, owner, fields, employee_column) in sources {
        let order = if table == "employees" { "0" } else { "t.sort_order" };
        let order_by = if table == "employees" { "t.id" } else { "t.sort_order" };
        let sql = format!(
            "SELECT t.id, t.{employee_column}, {order}, t.name_parts, e.full_name, {} FROM {table} t JOIN employees e ON e.id=t.{employee_column}
             WHERE t.name_parts LIKE '%\"review\":true%' ORDER BY e.full_name, {order_by}",
            fields.iter().map(|f| format!("t.{f}")).collect::<Vec<_>>().join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            let mut texts = Vec::new();
            for i in 0..fields.len() {
                texts.push(r.get::<_, Option<String>>(i + 5)?);
            }
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, texts))
        })?.collect::<SqlResult<Vec<_>>>()?;
        for (row_id, employee_id, index, parts, employee_name, texts) in rows {
            let parts = parts_object(parts.as_deref());
            for (field, text) in fields.iter().zip(texts) {
                let Some(value) = parts.get(*field) else { continue };
                if value.get("review").and_then(Value::as_bool) != Some(true) { continue; }
                items.push(ReviewItem {
                    employee_id,
                    employee_name: employee_name.clone(),
                    owner: owner.to_string(),
                    index,
                    field: field.to_string(),
                    text: text.unwrap_or_default(),
                    original_text: original_for(conn, table, employee_id, row_id, field),
                    parts: value.clone(),
                });
            }
        }
    }
    Ok(items)
}

/// Saves corrected parts for one reviewed name and clears its review flag. The combined
/// text is rebuilt from the parts. Returns the new combined text.
pub fn save_review(conn: &Connection, employee_id: i64, owner: &str, index: i64, field: &str, parts: &Value) -> Result<String, String> {
    let (table, key, allowed): (&str, &str, &[&str]) = match owner {
        "employee" => ("employees", "id", &["full_name", "mother_name", "residence_head_name", "passport_name"]),
        "spouse" => ("employee_spouses", "employee_id", &SPOUSE_ARABIC),
        "family" => ("employee_family_members", "employee_id", &FAMILY_ARABIC),
        _ => return Err("نوع الاسم غير معروف".into()),
    };
    if !allowed.contains(&field) {
        return Err("حقل الاسم غير معروف".into());
    }
    let (combined, value) = if field == "passport_name" {
        let mut p: PassportName = serde_json::from_value(parts.clone()).map_err(|e| e.to_string())?;
        p.review = false;
        let p = p.trimmed();
        (p.joined(), serde_json::to_value(p).map_err(|e| e.to_string())?)
    } else {
        let mut p: ArabicName = serde_json::from_value(parts.clone()).map_err(|e| e.to_string())?;
        p.review = false;
        let p = p.trimmed();
        (p.joined(), serde_json::to_value(p).map_err(|e| e.to_string())?)
    };
    if combined.is_empty() {
        return Err("أدخل الاسم".into());
    }
    if field == "full_name" && combined.chars().count() > 200 {
        return Err("الاسم طويل جدًا".into());
    }
    let filter = if table == "employees" { format!("{key}=?1") } else { format!("{key}=?1 AND sort_order=?2") };
    let (row_id, stored): (i64, Option<String>) = conn.query_row(
        &format!("SELECT id,name_parts FROM {table} WHERE {filter}"),
        rusqlite::params_from_iter(if table == "employees" { vec![employee_id] } else { vec![employee_id, index] }),
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| "لم يتم العثور على السجل".to_string())?;
    let mut map = parts_object(stored.as_deref());
    map.insert(field.to_string(), value);
    conn.execute(
        &format!("UPDATE {table} SET {field}=?1, name_parts=?2 WHERE id=?3"),
        params![combined, Value::Object(map).to_string(), row_id],
    ).map_err(|e| e.to_string())?;
    if table == "employee_spouses" && index == 0 {
        let column = if field == "name" { "spouse_name" } else { "spouse_mother_name" };
        conn.execute(&format!("UPDATE employees SET {column}=?1 WHERE id=?2"), params![combined, employee_id]).map_err(|e| e.to_string())?;
    }
    if table == "employees" {
        conn.execute("UPDATE employees SET updated_at=datetime('now') WHERE id=?1", params![employee_id]).map_err(|e| e.to_string())?;
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(first: &str, father: &str, grandfather: &str, surname: &str, review: bool) -> ArabicName {
        ArabicName { first: first.into(), father: father.into(), grandfather: grandfather.into(), surname: surname.into(), review }
    }

    #[test]
    fn four_parts_with_surname_are_confident() {
        assert_eq!(split_arabic("زينب علي حسن الموسوي"), a("زينب", "علي", "حسن", "الموسوي", false));
        assert_eq!(split_arabic("أبو بكر فتح الله علي الربيعي"), a("أبو بكر", "فتح الله", "علي", "الربيعي", false));
    }

    #[test]
    fn compound_names_stay_together() {
        assert_eq!(split_arabic("عبد الله محمد نور الدين آل محمد"), a("عبد الله", "محمد", "نور الدين", "آل محمد", false));
    }

    #[test]
    fn unsure_splits_are_flagged() {
        // Five parts (a great-grandfather): the extra word joins the surname, for review.
        assert_eq!(split_arabic("أحمد علي حسين كاظم الجبوري"), a("أحمد", "علي", "حسين", "كاظم الجبوري", true));
        // Four parts with no surname-like word: the fourth is kept as the surname, for review.
        assert_eq!(split_arabic("علي حسين كاظم جاسم"), a("علي", "حسين", "كاظم", "جاسم", true));
        assert_eq!(split_arabic("موظف تجريبي"), a("موظف", "تجريبي", "", "", true));
        assert_eq!(split_arabic("علي حسن الربيعي"), a("علي", "حسن", "", "الربيعي", true));
        let long = split_arabic("أ ب ج د هـ و");
        assert!(long.review);
        assert_eq!(long.surname, "د هـ و");
        assert_eq!(long.joined(), "أ ب ج د هـ و");
    }

    #[test]
    fn split_never_loses_text() {
        for text in ["أحمد علي حسين كاظم الجبوري", "عبد الله محمد", "  علي   حسن  ", "أ ب ج د هـ و ز", "عبد", "ال"] {
            assert_eq!(split_arabic(text).joined(), clean(text), "{text}");
        }
    }

    #[test]
    fn passport_last_word_is_surname() {
        assert_eq!(split_passport("AHMED ALI HUSSEIN ALJABOURI"), PassportName { given: "AHMED ALI HUSSEIN".into(), surname: "ALJABOURI".into(), review: false });
        assert!(split_passport("AHMED").review);
    }

    #[test]
    fn resolve_prefers_form_parts_then_stored_then_split() {
        let sent = serde_json::json!({"first":"علي","father":"حسن","grandfather":"كاظم","surname":"الربيعي","review":false});
        let (text, parts) = resolve_arabic(Some(&sent), None, Some("ignored"));
        assert_eq!(text.as_deref(), Some("علي حسن كاظم الربيعي"));
        assert_eq!(parts.unwrap()["review"], false);

        // Stored parts are kept while they match the text.
        let stored = serde_json::json!({"first":"علي حسن","father":"كاظم","review":false});
        let (_, parts) = resolve_arabic(None, Some(&stored), Some("علي حسن كاظم"));
        assert_eq!(parts.unwrap()["first"], "علي حسن");

        // Text changed elsewhere: split again.
        let (_, parts) = resolve_arabic(None, Some(&stored), Some("زينب علي حسن الموسوي"));
        assert_eq!(parts.unwrap()["first"], "زينب");

        assert_eq!(resolve_arabic(None, None, Some("  ")), (None, None));
    }
}

#[cfg(test)]
mod save_tests {
    use crate::services::{self, EmployeeData};
    use rusqlite::Connection;
    use serde_json::json;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::initialize_test(&conn).unwrap();
        conn.execute("INSERT INTO users(username,password,role) VALUES('editor','x','archive_officer')", []).unwrap();
        conn.execute("INSERT INTO users(username,password,role) VALUES('reader','x','viewer')", []).unwrap();
        conn
    }

    fn data(value: serde_json::Value) -> EmployeeData {
        serde_json::from_value(value).unwrap()
    }

    fn stored(conn: &Connection, id: i64) -> serde_json::Value {
        let text: String = conn.query_row("SELECT name_parts FROM employees WHERE id=?1", [id], |r| r.get(0)).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn form_parts_rebuild_the_combined_names() {
        let conn = conn();
        let employee = services::create_employee(&conn, &data(json!({
            "full_name": "anything",
            "passport_name": "x",
            "name_parts": {
                "full_name": {"first": " علي ", "father": "حسن", "grandfather": "كاظم", "surname": "الربيعي"},
                "passport_name": {"given": "ALI HASSAN", "surname": "ALRUBAIE"}
            },
            "spouses": serde_json::to_string(&json!([{"name": "", "name_parts": {"name": {"first": "مريم", "father": "علي", "grandfather": "حسن", "surname": "الساعدي"}}, "mother_name": "سعاد كريم"}])).unwrap(),
            "family_members": serde_json::to_string(&json!([{"name": "حسن علي حسن كاظم الربيعي"}])).unwrap(),
        })), "editor").unwrap();
        assert_eq!(employee.full_name, "علي حسن كاظم الربيعي");
        assert_eq!(employee.passport_name.as_deref(), Some("ALI HASSAN ALRUBAIE"));
        assert_eq!(employee.name_parts.as_ref().unwrap()["full_name"]["first"], "علي");
        let spouses: serde_json::Value = serde_json::from_str(employee.spouses.as_deref().unwrap()).unwrap();
        assert_eq!(spouses[0]["name"], "مريم علي حسن الساعدي");
        assert_eq!(spouses[0]["name_parts"]["mother_name"]["review"], true);
        let legacy: Option<String> = conn.query_row("SELECT spouse_name FROM employees WHERE id=?1", [employee.id], |r| r.get(0)).unwrap();
        assert_eq!(legacy.as_deref(), Some("مريم علي حسن الساعدي"));
        let family: serde_json::Value = serde_json::from_str(employee.family_members.as_deref().unwrap()).unwrap();
        assert_eq!(family[0]["name_parts"]["name"]["surname"], "كاظم الربيعي");
    }

    #[test]
    fn saving_without_parts_keeps_confirmed_parts_and_splits_changed_names() {
        let conn = conn();
        let created = services::create_employee(&conn, &data(json!({
            "full_name": "x",
            "name_parts": {"full_name": {"first": "عبد الأمير", "father": "علي", "grandfather": "حسن", "surname": "الربيعي"}},
        })), "editor").unwrap();
        // A save that sends only the combined name (same text) keeps the confirmed parts.
        services::update_employee(&conn, created.id, &data(json!({"full_name": "عبد الأمير علي حسن الربيعي"})), "editor").unwrap();
        assert_eq!(stored(&conn, created.id)["full_name"]["first"], "عبد الأمير");
        // A changed name is split again.
        let updated = services::update_employee(&conn, created.id, &data(json!({"full_name": "زينب علي حسن الموسوي"})), "editor").unwrap();
        assert_eq!(updated.full_name, "زينب علي حسن الموسوي");
        assert_eq!(stored(&conn, created.id)["full_name"]["first"], "زينب");
    }

    #[test]
    fn empty_parts_do_not_bypass_the_required_name() {
        let conn = conn();
        let result = services::create_employee(&conn, &data(json!({"full_name": "", "name_parts": {"full_name": {"first": " "}}})), "editor");
        assert!(result.is_err());
    }

    #[test]
    fn review_screen_lists_and_saves_unsure_names() {
        let conn = conn();
        let employee = services::create_employee(&conn, &data(json!({
            "full_name": "علي حسين كاظم جاسم",
            "spouses": r#"[{"name":"مريم علي"}]"#,
        })), "editor").unwrap();
        let items = services::list_name_review(&conn, "editor").unwrap();
        assert_eq!(items.len(), 2);
        assert!(services::list_name_review(&conn, "reader").is_err());
        let combined = services::save_name_review(&conn, employee.id, "employee", 0, "full_name",
            &json!({"first": "علي", "father": "حسين", "grandfather": "كاظم", "surname": "جاسم"}), "editor").unwrap();
        assert_eq!(combined, "علي حسين كاظم جاسم");
        assert_eq!(stored(&conn, employee.id)["full_name"]["review"], false);
        assert_eq!(stored(&conn, employee.id)["full_name"]["surname"], "جاسم");
        services::save_name_review(&conn, employee.id, "spouse", 0, "name",
            &json!({"first": "مريم", "father": "علي", "grandfather": "حسن", "surname": "الساعدي"}), "editor").unwrap();
        assert!(services::list_name_review(&conn, "editor").unwrap().is_empty());
        let legacy: String = conn.query_row("SELECT spouse_name FROM employees WHERE id=?1", [employee.id], |r| r.get(0)).unwrap();
        assert_eq!(legacy, "مريم علي حسن الساعدي");
        assert!(services::save_name_review(&conn, employee.id, "employee", 0, "notes", &json!({}), "editor").is_err());
        assert!(services::save_name_review(&conn, employee.id, "employee", 0, "full_name", &json!({"first": ""}), "editor").is_err());
        assert!(services::save_name_review(&conn, employee.id, "employee", 0, "full_name", &json!({"first": "x"}), "reader").is_err());
    }
}

/// Dry run on a COPY of a real database: upgrades the copy to the current schema and writes
/// every split to a CSV file so the splits can be checked before updating the real machine.
/// The source file is opened read-only and never changed.
///
/// ```text
/// set AUTOHR_VERIFY_DATABASE=D:\copy\database.db
/// set AUTOHR_NAME_REPORT=D:\copy\name-split-report.csv
/// cargo test --manifest-path src-tauri/Cargo.toml name_split_dry_run -- --ignored --nocapture
/// ```
#[cfg(test)]
mod dry_run {
    use rusqlite::Connection;

    #[test]
    #[ignore = "Opt-in dry run; always operates on an isolated copy"]
    fn name_split_dry_run() {
        let source_path = std::env::var("AUTOHR_VERIFY_DATABASE").expect("Set AUTOHR_VERIFY_DATABASE to a copy of the database");
        let report_path = std::env::var("AUTOHR_NAME_REPORT").unwrap_or_else(|_| "name-split-report.csv".into());
        let source = Connection::open_with_flags(&source_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let copy_path = dir.path().join("database.db");
        source.backup(rusqlite::MAIN_DB, &copy_path, None::<fn(rusqlite::backup::Progress)>).unwrap();
        drop(source);
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let db = data.join(crate::paths::DATABASE_FILE);
        std::fs::rename(&copy_path, &db).unwrap();
        crate::paths::set_current(Some(crate::paths::AppPaths { data_root: data, backup_root: dir.path().join("backups") }));
        let conn = crate::db::open_at(&db, false).unwrap();

        let mut csv = String::from("\u{feff}table,employee_id,field,needs_review,original,first/given,father,grandfather,surname,combined_unchanged\n");
        let mut total = 0;
        let mut flagged = 0;
        let mut stmt = conn.prepare(
            "SELECT o.table_name,o.row_id,o.employee_id,o.field,o.original_text,
                    CASE o.table_name WHEN 'employees' THEN (SELECT name_parts FROM employees WHERE id=o.row_id)
                                      WHEN 'employee_spouses' THEN (SELECT name_parts FROM employee_spouses WHERE id=o.row_id)
                                      ELSE (SELECT name_parts FROM employee_family_members WHERE id=o.row_id) END
             FROM name_split_originals o ORDER BY o.employee_id,o.table_name,o.row_id,o.id",
        ).unwrap();
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?,
        ))).unwrap();
        let quote = |v: &str| format!("\"{}\"", v.replace('"', "\"\""));
        for row in rows {
            let (table, row_id, employee_id, field, original, parts) = row.unwrap();
            let parts = super::parts_object(parts.as_deref());
            let part = parts.get(&field).cloned().unwrap_or_default();
            let text = |key: &str| part.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let review = part.get("review").and_then(|v| v.as_bool()).unwrap_or(true);
            let current: String = conn.query_row(&format!("SELECT COALESCE({field},'') FROM {table} WHERE id=?1"), [row_id], |r| r.get(0)).unwrap();
            total += 1;
            if review { flagged += 1; }
            let first = if field == "passport_name" { text("given") } else { text("first") };
            csv.push_str(&[
                quote(&table), employee_id.unwrap_or_default().to_string(), quote(&field), (if review { "yes" } else { "no" }).to_string(),
                quote(&original), quote(&first), quote(&text("father")), quote(&text("grandfather")),
                quote(&text("surname")), (if current == original { "yes" } else { "NO" }).to_string(),
            ].join(","));
            csv.push('\n');
            assert_eq!(current, original, "a combined name changed during the upgrade: {table}/{row_id}/{field}");
        }
        std::fs::write(&report_path, csv).unwrap();
        println!("Names split: {total}, needing review: {flagged}. Report: {report_path}");
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
    }
}
