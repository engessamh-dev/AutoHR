//! Fake test data for trying the screens («بيانات تجريبية»). Development builds only.
//!
//! `npm run test-data` starts the development build with `CNSARCH_TEST_DATA=1`. The program then
//! uses its own application folder, `%APPDATA%\CNSArch-TestData` (see `services::app_data_path`),
//! with its own config.json, integrity key, data folder and backup folder. Neither the installed
//! program's data (`%APPDATA%\CNSArch`, or wherever it was moved) nor the usual development data
//! (`%APPDATA%\CNSArch-Development`) is opened or changed.
//!
//! On the first start in that folder, the data and backup folders are created and filled with
//! invented employees through the program's own functions, so every row and attachment is sealed
//! exactly as if it had been entered on screen. Some employees are complete; others leave out
//! required fields, attachments or whole documents, and document expiry dates are spread around
//! today (expired, expiring soon, valid). All names and numbers are invented; the pictures are
//! plain coloured placeholders.
//!
//! This module is compiled only when `debug_assertions` is on, so it is never in a release build.

use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

use crate::services::{self, AppError, AppResult, EmployeeData, GeneralDocData};

/// The environment variable that selects the test-data application folder.
pub const ENV_VAR: &str = "CNSARCH_TEST_DATA";
/// The application folder used while the variable is set (under %APPDATA%).
pub const APP_FOLDER: &str = "CNSArch-TestData";
const ADMIN: &str = "sysadmin";

pub fn enabled() -> bool {
    std::env::var(ENV_VAR).map(|value| value.trim() == "1").unwrap_or(false)
}

/// Called once at start-up, before the normal start. In the test-data folder, a first start
/// creates the data and backup folders and fills them; later starts change nothing.
pub fn prepare() {
    if !enabled() {
        return;
    }
    let app = services::app_data_path();
    if crate::paths::config_path().is_file() {
        println!("[test-data] using the existing test data in {}", app.display());
        return;
    }
    let data = app.join("TestData");
    let backups = app.join("TestBackups");
    match crate::storage::complete_setup(&data, &backups, false).and_then(|conn| seed(&conn)) {
        Ok(summary) => println!("[test-data] created in {}: {summary}", data.display()),
        Err(error) => eprintln!("[test-data] could not create the test data: {error}"),
    }
}

// ── Placeholder pictures ────────────────────────────────────────────────────

/// A card-shaped JPEG: a coloured background, a darker band and a lighter photo box, so that
/// front and back sides and the different documents look different in the viewer.
fn card_jpeg(dir: &Path, name: &str, hue: [u8; 3], back: bool) -> AppResult<String> {
    let (w, h) = (856u32, 540u32);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let shade = |c: u8, k: f32| (c as f32 * k).min(255.0) as u8;
        let band = if back { y > h - 120 && y < h - 60 } else { y < 90 };
        let photo = !back && x > w - 260 && x < w - 60 && y > 140 && y < 420;
        let line = !photo && (y % 48 < 6) && x > 60 && x < if back { w - 60 } else { w - 300 } && y > 140 && y < 440;
        let k = if band { 0.55 } else if photo { 1.35 } else if line { 0.8 } else { 1.0 };
        image::Rgb([shade(hue[0], k), shade(hue[1], k), shade(hue[2], k)])
    });
    save_jpeg(dir, name, img)
}

/// A portrait JPEG: grey background with a simple head-and-shoulders silhouette.
fn portrait_jpeg(dir: &Path, name: &str, tone: u8) -> AppResult<String> {
    let (w, h) = (360u32, 450u32);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32, y as f32);
        let head = (fx - 180.0).powi(2) + (fy - 170.0).powi(2) < 75.0f32.powi(2);
        let body = (fx - 180.0).powi(2) / 150.0f32.powi(2) + (fy - 450.0).powi(2) / 170.0f32.powi(2) < 1.0;
        if head || body { image::Rgb([tone, tone, tone.saturating_add(10)]) } else { image::Rgb([222, 226, 232]) }
    });
    save_jpeg(dir, name, img)
}

/// A page-shaped JPEG for archive documents: white page, a header block and text lines.
fn page_jpeg(dir: &Path, name: &str, accent: [u8; 3]) -> AppResult<String> {
    let (w, h) = (1240u32, 1754u32);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        if y > 120 && y < 260 && x > 120 && x < w - 120 { return image::Rgb(accent); }
        let line = y > 380 && y < h - 300 && (y - 380) % 70 < 14 && x > 140 && x < w - 140 - (y % 3) * 120;
        if line { image::Rgb([170, 174, 180]) } else { image::Rgb([252, 252, 250]) }
    });
    save_jpeg(dir, name, img)
}

fn save_jpeg(dir: &Path, name: &str, img: image::RgbImage) -> AppResult<String> {
    let path = dir.join(format!("{name}.jpg"));
    image::DynamicImage::ImageRgb8(img)
        .save_with_format(&path, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::Other(format!("placeholder picture: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

// ── Dates relative to today ─────────────────────────────────────────────────

fn day(offset: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(offset)).format("%Y-%m-%d").to_string()
}

fn years_ago(years: i64, extra_days: i64) -> String { day(-years * 365 - extra_days) }

// ── The invented employees ──────────────────────────────────────────────────

/// What each employee has besides the basic fields, so the screens show every status.
#[derive(Default, Clone, Copy)]
struct Docs {
    photo: bool,
    national: Option<i64>,     // expiry offset in days; None = no national card data
    national_sides: u8,        // pictures attached: 0, 1 or 2
    passport: Option<i64>,
    passport_page: bool,
    residence: bool,
    residence_sides: u8,
    ration: bool,
    airport: Option<i64>,
    airport_sides: u8,
    ministry: Option<i64>,
    ministry_sides: u8,
    vehicle: Option<i64>,
}

const COMPLETE: Docs = Docs {
    photo: true, national: Some(2400), national_sides: 2, passport: Some(1500), passport_page: true,
    residence: true, residence_sides: 2, ration: true, airport: Some(300), airport_sides: 2,
    ministry: Some(500), ministry_sides: 2, vehicle: None,
};

struct Person {
    number: Option<&'static str>,
    name: &'static str,
    latin: &'static str,
    mother: Option<&'static str>,
    gender: Option<&'static str>,
    marital: Option<&'static str>,
    birth_years: Option<i64>,
    birthplace: Option<&'static str>,
    blood: Option<&'static str>,
    phone: Option<&'static str>,
    job: Option<&'static str>,
    grade: Option<&'static str>,
    appointed_years: Option<i64>,
    contract: Option<&'static str>,
    education: Option<&'static str>,
    active: bool,
    spouse: Option<(&'static str, &'static str)>,
    family: &'static [(&'static str, &'static str, &'static str, i64)], // name, relation, gender, age
    docs: Docs,
    note: &'static str,
}

const FULL: Person = Person {
    number: None, name: "", latin: "", mother: None, gender: Some("ذكر"), marital: Some("متزوج"),
    birth_years: Some(38), birthplace: Some("بغداد"), blood: Some("O+"), phone: None,
    job: Some("مهندس"), grade: Some("الدرجة السادسة"), appointed_years: Some(10),
    contract: Some("ملاك"), education: Some("بكالوريوس"), active: true, spouse: None, family: &[],
    docs: COMPLETE, note: "",
};

fn people() -> Vec<Person> {
    vec![
        Person { number: Some("T-1001"), name: "سيف ناظم كريم الجبوري", latin: "SAIF NADHIM KAREEM ALJUBOURI",
            mother: Some("هدى سلمان جاسم"), phone: Some("07700000101"), job: Some("مهندس اتصالات"),
            spouse: Some(("زينب علي حسن", "أمل كاظم جواد")),
            family: &[("حسين سيف ناظم", "ابن", "ذكر", 8), ("رقية سيف ناظم", "ابنة", "أنثى", 5)],
            docs: Docs { vehicle: Some(200), ..COMPLETE }, note: "مكتمل: كل البيانات والمستمسكات سارية ومرفقة", ..FULL },
        Person { number: Some("T-1002"), name: "مريم فاضل حسن العبيدي", latin: "MARYAM FADHIL HASAN ALUBAIDI",
            mother: Some("إيمان كريم عباس"), gender: Some("أنثى"), marital: Some("أعزب"),
            birthplace: Some("البصرة"), blood: Some("A+"), phone: Some("07800000102"), job: Some("محاسب أول"),
            grade: Some("الدرجة الخامسة"), docs: Docs { national: Some(-12), passport: Some(20), ..COMPLETE },
            note: "البطاقة الوطنية منتهية، والجواز ينتهي خلال 20 يوماً", ..FULL },
        Person { number: Some("T-1003"), name: "حيدر سامي جبار التميمي", latin: "HAIDER SAMI JABBAR ALTAMIMI",
            mother: Some("ابتسام نوري كاظم"), birthplace: Some("كربلاء"), blood: Some("B+"), phone: Some("07500000103"),
            job: Some("مراقب حركة جوية"), grade: Some("الدرجة الرابعة"), appointed_years: Some(15),
            family: &[("علي حيدر سامي", "ابن", "ذكر", 12)],
            spouse: Some(("نور هادي صالح", "سميرة جاسم محمد")),
            docs: Docs { national_sides: 1, airport: Some(5), ..COMPLETE },
            note: "باج المطار ينتهي خلال 5 أيام، والوجه الخلفي للبطاقة الوطنية غير مرفق", ..FULL },
        Person { number: Some("T-1004"), name: "زهراء كاظم عادل الموسوي", latin: "ZAHRAA KADHIM ADIL ALMUSAWI",
            mother: Some("سعاد حميد لطيف"), gender: Some("أنثى"), marital: Some("أعزب"), birthplace: Some("النجف"),
            blood: None, phone: None, job: Some("مسؤول موارد بشرية"), grade: Some("الدرجة السابعة"),
            appointed_years: Some(4), docs: COMPLETE, note: "ناقص: فصيلة الدم ورقم الهاتف", ..FULL },
        Person { number: Some("T-1005"), name: "ليث مازن صالح الربيعي", latin: "",
            mother: None, marital: None, birthplace: None, phone: Some("07700000105"), job: Some("فني صيانة"),
            grade: Some("الدرجة الثامنة"), appointed_years: Some(2), contract: Some("عقد"), education: None,
            docs: Docs::default(), note: "ناقص 4 حقول، ولا توجد أي مستمسكات", ..FULL },
        Person { number: Some("T-1006"), name: "علي حسين عبد الساعدي", latin: "",
            mother: None, gender: None, marital: None, birth_years: None, birthplace: None, blood: None,
            phone: None, job: None, grade: None, appointed_years: None, contract: None, education: None,
            docs: Docs::default(), note: "موظف جديد: الاسم والرقم الوظيفي فقط", ..FULL },
        Person { number: Some("T-1007"), name: "نور علي جاسم الكعبي", latin: "NOOR ALI JASIM ALKAABI",
            mother: Some("وفاء عبد الرضا مهدي"), gender: Some("أنثى"), marital: Some("متزوج"), birthplace: Some("واسط"),
            blood: Some("AB+"), phone: Some("07900000107"), job: Some("مدقق حسابات"), grade: None,
            appointed_years: None, contract: None,
            spouse: Some(("أحمد كريم جاسم", "خيرية عباس علي")),
            docs: Docs { passport: Some(-40), ministry: None, ministry_sides: 0, ..COMPLETE },
            note: "ناقص: الدرجة وتاريخ التعيين ونوع التوظيف، والجواز منتهٍ منذ 40 يوماً", ..FULL },
        Person { number: Some("T-1008"), name: "رسل أحمد ياسين الشمري", latin: "RUSUL AHMED YASEEN ALSHAMMARI",
            mother: Some("سهام كامل حمزة"), gender: Some("أنثى"), birthplace: Some("الموصل"), blood: Some("O-"),
            phone: Some("07700000108"), job: Some("باحث قانوني"), grade: Some("الدرجة السادسة"), education: Some("ماجستير"),
            spouse: Some(("مصطفى رياض خليل", "رنا طالب كاظم")),
            family: &[("محمد مصطفى رياض", "ابن", "ذكر", 9), ("فاطمة مصطفى رياض", "ابنة", "أنثى", 6), ("زينب مصطفى رياض", "ابنة", "أنثى", 2)],
            docs: Docs { vehicle: Some(10), ..COMPLETE }, note: "مكتملة، وسنوية المركبة تنتهي خلال 10 أيام", ..FULL },
        Person { number: None, name: "كرار فلاح مهدي الزيدي", latin: "KARRAR FALAH MAHDI ALZAIDI",
            mother: Some("منى صباح حسن"), birthplace: Some("ذي قار"), blood: Some("A-"), phone: None,
            job: Some("سائق إداري"), grade: Some("الدرجة التاسعة"), education: Some("متوسطة"),
            docs: Docs { vehicle: Some(-25), airport: None, airport_sides: 0, ..COMPLETE },
            note: "ناقص: الرقم الوظيفي ورقم الهاتف، وسنوية المركبة منتهية", ..FULL },
        Person { number: Some("T-1010"), name: "مرتضى قاسم هادي البديري", latin: "MURTADHA QASIM HADI ALBADEERI",
            mother: Some("خلود ناصر علي"), birthplace: Some("ديالى"), blood: Some("B-"), phone: Some("07800000110"),
            job: Some("فني اتصالات"), grade: Some("الدرجة السابعة"), education: Some("دبلوم"),
            docs: Docs { ministry: Some(-3), residence_sides: 0, ..COMPLETE },
            note: "هوية الوزارة منتهية، وبطاقة السكن بلا مرفقات", ..FULL },
        Person { number: Some("T-1011"), name: "سارة عادل مهدي الحسيني", latin: "SARA ADIL MAHDI ALHUSSAINI",
            mother: Some("نادية رزاق شنان"), gender: Some("أنثى"), marital: Some("أرمل"), blood: Some("O+"),
            phone: Some("07700000111"), job: Some("موظف وارد"), grade: Some("الدرجة الثامنة"), active: false,
            family: &[("حسن جعفر عادل", "ابن", "ذكر", 14)],
            docs: COMPLETE, note: "مكتملة، لكنها غير فعالة (تركت الخدمة)", ..FULL },
        Person { number: Some("T-1012"), name: "أحمد جبار سالم العزاوي", latin: "AHMED JABBAR SALIM ALAZZAWI",
            mother: Some("مها نوري عبد"), gender: None, birth_years: None, blood: Some("A+"), phone: Some("07500000112"),
            job: Some("مسؤول مخازن"), grade: Some("الدرجة الثامنة"), education: Some("إعدادية"),
            docs: Docs { national: Some(12), passport: None, passport_page: false, ..COMPLETE },
            note: "ناقص: الجنس وتاريخ الولادة، والبطاقة الوطنية تنتهي خلال 12 يوماً", ..FULL },
        Person { number: Some("T-1013"), name: "بتول نعيم كاظم الخفاجي", latin: "BATOOL NAEEM KADHIM ALKHAFAJI",
            mother: Some("شذى قاسم حسين"), gender: Some("أنثى"), marital: Some("أعزب"), birthplace: Some("بابل"),
            blood: Some("AB-"), phone: Some("07900000113"), job: Some("محلل بيانات"), grade: Some("الدرجة السابعة"),
            appointed_years: Some(3), docs: COMPLETE, note: "مكتملة: عزباء بلا عائلة مسجلة", ..FULL },
        Person { number: Some("T-1014"), name: "حسن واثق جاسم اللامي", latin: "HASAN WATHIQ JASIM ALLAMI",
            mother: Some("سميرة غازي عودة"), marital: Some("أعزب"), birthplace: Some("ميسان"), blood: Some("O+"),
            phone: Some("07700000114"), job: None, grade: Some("الدرجة العاشرة"), appointed_years: Some(1), education: Some("إعدادية"),
            family: &[("واثق جاسم عودة", "أب", "ذكر", 62), ("سميرة غازي عودة", "أم", "أنثى", 58)],
            docs: Docs { ration: false, airport: None, airport_sides: 0, ministry: None, ministry_sides: 0, ..COMPLETE },
            note: "ناقص: العنوان الوظيفي فقط", ..FULL },
    ]
}

fn opt(value: Option<&str>) -> Value { value.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null) }

fn employee_json(index: usize, p: &Person) -> Value {
    let n = index + 1;
    let d = p.docs;
    let city = p.birthplace.unwrap_or("بغداد");
    let mut v = json!({
        "employee_number": opt(p.number),
        "full_name": p.name,
        "mother_name": opt(p.mother),
        "gender": opt(p.gender),
        "marital_status": opt(p.marital),
        "birthdate": p.birth_years.map(|y| years_ago(y, (n as i64) * 23)),
        "birthplace": opt(p.birthplace),
        "blood_type": opt(p.blood),
        "phone": opt(p.phone),
        "email": format!("test.employee{n:02}@example.test"),
        "job_title": opt(p.job),
        "job_grade": opt(p.grade),
        "appointment_date": p.appointed_years.map(|y| years_ago(y, (n as i64) * 11)),
        "hire_date": p.appointed_years.map(|y| years_ago(y, (n as i64) * 11)),
        "contract_type": opt(p.contract),
        "education_level": opt(p.education),
        "specialization": if p.education.is_some() { Value::from("تخصص تجريبي") } else { Value::Null },
        "workplace": if n % 3 == 0 { "مطار بغداد الدولي" } else { "المقر العام" },
        "work_schedule": if n % 3 == 0 { "مناوب" } else { "صباحي" },
        "notes": format!("بيانات وهمية للتجربة. {}", p.note),
        "is_active": if p.active { 1 } else { 0 },
    });
    let set = |v: &mut Value, key: &str, value: Value| { v[key] = value; };
    if let Some(offset) = d.national {
        set(&mut v, "civil_id", json!(format!("19900000{n:04}")));
        set(&mut v, "civil_id_family_number", json!(format!("2100{n:04}T")));
        set(&mut v, "civil_id_issuer", json!(format!("مديرية الجنسية العامة - {city}")));
        set(&mut v, "civil_id_issue_date", json!(day(offset - 3650)));
        set(&mut v, "civil_id_expiry_date", json!(day(offset)));
    }
    if let Some(offset) = d.passport {
        set(&mut v, "passport_no", json!(format!("T{n:07}")));
        set(&mut v, "passport_type", json!("P"));
        set(&mut v, "passport_name", json!(p.latin));
        set(&mut v, "passport_issue_date", json!(day(offset - 2920)));
        set(&mut v, "passport_expiry_date", json!(day(offset)));
    }
    if d.residence {
        set(&mut v, "residence_card_no", json!(format!("55{n:05}")));
        set(&mut v, "residence_card_issuer", json!(format!("مكتب معلومات {city} التجريبي")));
        set(&mut v, "residence_card_issue_date", json!(day(-900 - n as i64)));
        set(&mut v, "residence_form_no", json!(format!("{}", 300 + n)));
        set(&mut v, "residence_head_name", json!(p.name));
        set(&mut v, "residence_address", json!(format!("{city} - محلة {} - زقاق {} - دار {}", 100 + n, n, 10 + n)));
    }
    if d.ration {
        set(&mut v, "ration_card_no", json!(format!("88{n:05}")));
        // The field holds the ration card's «اسم رب الأسرة» (as the screens label it).
        set(&mut v, "ration_center_name", json!(p.name));
        set(&mut v, "ration_center_no", json!(format!("{}", 40 + n)));
        set(&mut v, "ration_card_date", json!(day(-700)));
    }
    if let Some(offset) = d.airport {
        set(&mut v, "airport_badge_no", json!(format!("BGW-T{n:04}")));
        set(&mut v, "airport_badge_issue_date", json!(day(offset - 365)));
        set(&mut v, "airport_badge_expiry", json!(day(offset)));
        set(&mut v, "airport_badge_zones", json!(if n % 2 == 0 { "S1,T" } else { "S1,T,VIP" }));
    }
    if let Some(offset) = d.ministry {
        set(&mut v, "ministry_badge_no", json!(format!("MOT-T{n:04}")));
        set(&mut v, "ministry_badge_issue_date", json!(day(offset - 730)));
        set(&mut v, "ministry_badge_expiry", json!(day(offset)));
    }
    if let Some(offset) = d.vehicle {
        let plate = format!("{} أ بغداد", 10000 + n * 137);
        set(&mut v, "vehicle_plate", json!(plate));
        set(&mut v, "vehicle_annual_no", json!(format!("A{n:06}")));
        set(&mut v, "vehicle_annual_issue_date", json!(day(offset - 365)));
        set(&mut v, "vehicle_annual_expiry_date", json!(day(offset)));
        set(&mut v, "vehicles", json!(json!([{
            "plate": plate, "brand": if n % 2 == 0 { "تويوتا" } else { "كيا" }, "type": "صالون",
            "color": "أبيض", "annual_no": format!("A{n:06}"), "issue_date": day(offset - 365), "expiry_date": day(offset),
            "governorate": "بغداد", "plate_category": "خصوصي", "chassis_no": format!("TESTCHASSIS{n:06}"), "model_year": "2019",
        }]).to_string()));
    }
    if let Some((name, mother)) = p.spouse {
        let spouse_gender = if p.gender == Some("أنثى") { "ذكر" } else { "أنثى" };
        set(&mut v, "spouses", json!(json!([{
            "name": name, "mother_name": mother, "gender": spouse_gender, "birthplace": city,
            "birthdate": years_ago(34, n as i64), "civil_id": format!("19910000{n:04}"),
            "issue_date": day(-1000), "expiry_date": day(2600), "issuer": format!("مديرية الجنسية العامة - {city}"),
            "blood_type": "A+", "marriage_date": years_ago(9, n as i64),
        }]).to_string()));
    }
    let family: Vec<Value> = p.family.iter().enumerate().map(|(i, (name, relation, gender, age))| json!({
        "name": name, "relation": relation, "gender": gender, "birthplace": city,
        "birthdate": years_ago(*age, (i as i64) * 40 + 15),
        "civil_id": if *age >= 4 { Value::from(format!("2020{n:03}{i:03}")) } else { Value::Null },
        "issuer": format!("مديرية الجنسية العامة - {city}"),
    })).collect();
    set(&mut v, "family_members", json!(Value::Array(family).to_string()));
    v
}

// ── Seeding ─────────────────────────────────────────────────────────────────

/// Fills an empty, freshly created database. Returns a one-line summary.
pub fn seed(conn: &Connection) -> AppResult<String> {
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM employees", [], |r| r.get(0))?;
    if existing > 0 {
        return Err(AppError::Validation("the test database already has employees; nothing was added".into()));
    }
    // Test folder only: sign in as sysadmin / password without the forced change.
    conn.execute("UPDATE users SET must_change_password=0 WHERE username=?1", [ADMIN])?;
    conn.execute("UPDATE company_config SET company_name='شركة تجريبية للاختبار' WHERE id=1", [])?;

    let scratch = tempfile::tempdir().map_err(|e| AppError::Other(e.to_string()))?;
    let pics = scratch.path();
    let mut ids = Vec::new();
    let people = people();
    for (index, person) in people.iter().enumerate() {
        let data: EmployeeData = serde_json::from_value(employee_json(index, person))
            .map_err(|e| AppError::Other(format!("test employee {}: {e}", index + 1)))?;
        let employee = services::create_employee(conn, &data, ADMIN)?;
        attach_pictures(conn, pics, employee.id, index, person)?;
        ids.push(employee.id);
    }
    let documents = seed_archive(conn, pics, &ids)?;
    Ok(format!("{} employees, {documents} archive documents", ids.len()))
}

fn attach_pictures(conn: &Connection, pics: &Path, id: i64, index: usize, p: &Person) -> AppResult<()> {
    let d = p.docs;
    let tag = |what: &str| format!("e{id}-{what}");
    let sides = |count: u8| ["front", "back"].into_iter().take(count as usize);
    if d.photo {
        crate::services::upload_employee_photo(conn, id, &portrait_jpeg(pics, &tag("photo"), 90 + (index as u8 * 9) % 80)?)?;
    }
    for side in sides(d.national_sides) {
        let file = card_jpeg(pics, &tag(&format!("national-{side}")), [120, 170, 210], side == "back")?;
        crate::files::upload_national_card_attachment(conn, id, side, &file)?;
    }
    if d.passport_page {
        crate::files::upload_passport_attachment(conn, id, &card_jpeg(pics, &tag("passport"), [60, 90, 150], false)?)?;
    }
    for side in sides(d.residence_sides) {
        let file = card_jpeg(pics, &tag(&format!("residence-{side}")), [200, 190, 150], side == "back")?;
        crate::files::upload_residence_card_attachment(conn, id, side, &file)?;
    }
    if d.ration {
        crate::files::upload_ration_card_attachment(conn, id, &card_jpeg(pics, &tag("ration"), [150, 200, 150], false)?)?;
    }
    for side in sides(d.airport_sides) {
        let file = card_jpeg(pics, &tag(&format!("airport-{side}")), [230, 160, 90], side == "back")?;
        crate::files::upload_airport_badge_attachment(conn, id, side, &file)?;
    }
    for side in sides(d.ministry_sides) {
        let file = card_jpeg(pics, &tag(&format!("ministry-{side}")), [180, 140, 200], side == "back")?;
        crate::files::upload_ministry_badge_attachment(conn, id, side, &file)?;
    }
    if d.vehicle.is_some() {
        for side in ["front", "back"] {
            let file = card_jpeg(pics, &tag(&format!("vehicle-{side}")), [210, 210, 120], side == "back")?;
            crate::files::upload_vehicle_annual_attachment(conn, id, 0, side, &file)?;
        }
    }
    if p.spouse.is_some() {
        for side in ["front", "back"] {
            let file = card_jpeg(pics, &tag(&format!("spouse-{side}")), [120, 170, 210], side == "back")?;
            crate::files::upload_spouse_national_card_attachment(conn, id, 0, side, &file)?;
        }
    }
    // Only the first family member's card is attached, so the others show what is missing.
    if !p.family.is_empty() {
        let file = card_jpeg(pics, &tag("family-front"), [120, 170, 210], false)?;
        crate::files::upload_family_national_card_attachment(conn, id, 0, "front", &file)?;
    }
    Ok(())
}

fn seed_archive(conn: &Connection, pics: &Path, ids: &[i64]) -> AppResult<usize> {
    let emp = |i: usize| ids.get(i).copied().into_iter().collect::<Vec<_>>();
    // The archive form's columns (documents.js): title = الجهة المصدرة, doc_number = إلى,
    // issuer = الموضوع, doc_count = العدد.
    // subject, number, days ago, from (incoming) or to (outgoing), linked employees, pages, outgoing
    let docs: Vec<(&str, &str, i64, &str, Vec<i64>, usize, bool)> = vec![
        ("أمر إداري بتعيين موظف جديد", "ت/101", 5, "قسم الموارد البشرية", emp(5), 1, false),
        ("شكر وتقدير", "ش/214", 20, "مكتب المدير العام", [emp(0), emp(2)].concat(), 2, false),
        ("منح إجازة اعتيادية", "ج/77", 9, "شعبة الذاتية", emp(3), 1, false),
        ("تحديث البيانات الشخصية للموظفين", "ع/12", 33, "الدائرة الإدارية", vec![], 3, false),
        ("نقل موظف إلى قسم آخر", "ن/58", 60, "قسم الموارد البشرية", emp(9), 0, false),
        ("استفسار عن باج دخول المطار", "م/301", 2, "سلطة الطيران المدني", emp(2), 1, false),
        ("محضر اجتماع لجنة المشتريات", "ل/9", 90, "لجنة المشتريات", vec![], 0, false),
        ("تجديد هوية وزارة النقل", "ص/45", 3, "وزارة النقل", emp(9), 1, true),
        ("إشعار مباشرة بالعمل", "ص/46", 7, "الدائرة الإدارية", emp(5), 1, true),
        ("تأييد صحة صدور جواز سفر", "ص/52", 15, "مديرية الجوازات", emp(6), 2, true),
        ("جواب على استفسار", "ص/60", 40, "سلطة الطيران المدني", vec![], 0, true),
    ];
    let accents = [[40, 90, 160], [150, 60, 60], [50, 130, 90], [120, 90, 40]];
    for (index, (subject, number, ago, party, employee_ids, pages, outgoing)) in docs.iter().enumerate() {
        let (from, to) = if *outgoing { ("قسم الموارد البشرية", Some(party.to_string())) } else { (*party, None) };
        let data = GeneralDocData {
            title: from.to_string(), doc_type: None, doc_number: to,
            issue_date: Some(day(-ago)), issuer: Some(subject.to_string()), doc_count: Some(number.to_string()),
            margin: if index % 3 == 0 { Some("للاطلاع والحفظ".into()) } else { None },
            is_internal_memo: index % 4 == 3, hr_effect_type: None, hr_affects_promotion: false,
            hr_affects_allowance: false, hr_effect_months: 0, hr_effect_days: 0,
            notes: Some("وثيقة وهمية للتجربة".into()), employee_ids: employee_ids.clone(),
        };
        let doc = if *outgoing { services::create_outgoing_doc(conn, &data, ADMIN)? } else { services::create_general_doc(conn, &data, ADMIN)? };
        for page in 0..*pages {
            let file = page_jpeg(pics, &format!("doc{index}-p{page}"), accents[(index + page) % accents.len()])?;
            if *outgoing { services::upload_outgoing_doc_file(conn, doc.id, &file)?; } else { services::upload_general_doc_file(conn, doc.id, &file)?; }
        }
    }
    Ok(docs.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_a_fresh_database_and_everything_stays_sealed() {
        let dir = tempfile::tempdir().unwrap();
        services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = Some(dir.path().to_path_buf()));
        crate::integrity::test_use_new_key(true);
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_tests(&conn);
        crate::integrity::attach(&conn, true);
        conn.execute("INSERT INTO users(username,password,role,must_change_password) VALUES('sysadmin','x','system_admin',1)", []).unwrap();

        let summary = seed(&conn).unwrap();
        assert_eq!(summary, "14 employees, 11 archive documents");
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM employees WHERE is_active=0"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM employees WHERE employee_number IS NULL"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM employees WHERE blood_type IS NULL"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM employee_family_members"), 9);
        assert_eq!(count("SELECT COUNT(*) FROM employee_spouses"), 4);
        assert_eq!(count("SELECT COUNT(*) FROM employee_vehicles WHERE annual_front_path IS NOT NULL"), 3);
        assert_eq!(count("SELECT COUNT(*) FROM general_docs"), 7);
        assert_eq!(count("SELECT COUNT(*) FROM outgoing_docs"), 4);
        assert_eq!(count("SELECT COUNT(*) FROM outgoing_docs WHERE doc_number='مديرية الجوازات' AND doc_count='ص/52'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM general_docs WHERE title='سلطة الطيران المدني' AND issuer='استفسار عن باج دخول المطار'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM general_doc_attachments"), 8);
        assert_eq!(count("SELECT COUNT(*) FROM employees WHERE civil_id_front_path IS NOT NULL AND civil_id_back_path IS NULL"), 1);
        assert_eq!(count("SELECT must_change_password FROM users WHERE username='sysadmin'"), 0);
        assert!(seed(&conn).is_err(), "a second run adds nothing");
        let report = crate::integrity::report(&conn, true);
        assert_eq!(report.status, "ok", "{:?}", report.details);
        services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = None);
    }
}
