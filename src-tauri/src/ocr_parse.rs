//! Turns the text lines read from an Iraqi national card or passport into named fields.
//!
//! The machine-readable zone (MRZ) carries check digits, so numbers and dates read from it are
//! verified; values read from the printed Arabic text are not, and get the line's confidence.
//! Pure functions over text: unit-tested with synthetic data only.
use crate::ocr::Line;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub key: String,
    pub value: String,
    /// 0..1. MRZ values that pass their check digit get 0.99.
    pub confidence: f32,
    /// "mrz" or "text".
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ReadResult {
    /// national_front, national_back, national (both sides), passport or unknown.
    pub document: String,
    pub fields: Vec<Field>,
    pub warnings: Vec<String>,
}

impl ReadResult {
    fn get(&self, key: &str) -> Option<&Field> { self.fields.iter().find(|f| f.key == key) }

    fn set(&mut self, key: &str, value: impl Into<String>, confidence: f32, source: &'static str) {
        let value = value.into();
        if value.trim().is_empty() {
            return;
        }
        match self.fields.iter_mut().find(|f| f.key == key) {
            // An MRZ value that passed its check digit wins over printed text.
            Some(existing) if existing.source == "mrz" && existing.confidence >= confidence => {}
            Some(existing) => *existing = Field { key: key.into(), value, confidence, source },
            None => self.fields.push(Field { key: key.into(), value, confidence, source }),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/// Arabic normalisation for matching labels: hamza forms, ta marbuta, alef maqsura, Persian
/// letters the recogniser may pick, diacritics and tatweel.
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => Some('ا'),
            'ة' => Some('ه'),
            'ى' | 'ی' | 'ې' => Some('ي'),
            'ک' => Some('ك'),
            'ھ' | 'ە' => Some('ه'),
            'ـ' => None,
            '\u{064B}'..='\u{065F}' | '\u{0670}' => None,
            _ => Some(c),
        })
        .collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn is_arabic_letter(c: char) -> bool { ('\u{0621}'..='\u{064A}').contains(&c) || ('\u{0671}'..='\u{06D3}').contains(&c) }

fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '/' | ':' | '|' | '\\' | '،' | '؛'))
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Digits in any script to ASCII.
fn ascii_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '٠'..='٩' => char::from(b'0' + (c as u32 - '٠' as u32) as u8),
            '۰'..='۹' => char::from(b'0' + (c as u32 - '۰' as u32) as u8),
            _ => c,
        })
        .collect()
}

fn iso_date(y: u32, m: u32, d: u32) -> Option<String> {
    chrono::NaiveDate::from_ymd_opt(y as i32, m, d).map(|date| date.format("%Y-%m-%d").to_string())
}

/// First date written year/month/day (national card) or day.month.year (passport) in the text.
fn find_date(text: &str) -> Option<String> {
    let text = ascii_digits(text);
    let groups: Vec<&str> = text.split(|c: char| !c.is_ascii_digit()).filter(|g| !g.is_empty()).collect();
    for window in groups.windows(3) {
        let n: Vec<u32> = window.iter().filter_map(|g| g.parse().ok()).collect();
        if n.len() != 3 {
            continue;
        }
        if window[0].len() == 4 {
            if let Some(date) = iso_date(n[0], n[1], n[2]) {
                return Some(date);
            }
        }
        if window[2].len() == 4 {
            if let Some(date) = iso_date(n[2], n[1], n[0]) {
                return Some(date);
            }
        }
    }
    None
}

fn find_all_dates(text: &str) -> Vec<String> {
    let text = ascii_digits(text);
    let mut found = Vec::new();
    let groups: Vec<&str> = text.split(|c: char| !c.is_ascii_digit()).filter(|g| !g.is_empty()).collect();
    let mut i = 0;
    while i + 2 < groups.len() {
        if let Some(date) = find_date(&groups[i..i + 3].join("/")) {
            found.push(date);
            i += 3;
        } else {
            i += 1;
        }
    }
    found
}

// ---------------------------------------------------------------------------------------------
// MRZ

fn mrz_value(c: char) -> u32 {
    match c {
        '0'..='9' => c as u32 - '0' as u32,
        'A'..='Z' => c as u32 - 'A' as u32 + 10,
        _ => 0,
    }
}

pub fn check_digit(text: &str) -> char {
    let weights = [7, 3, 1];
    let sum: u32 = text.chars().enumerate().map(|(i, c)| mrz_value(c) * weights[i % 3]).sum();
    char::from(b'0' + (sum % 10) as u8)
}

fn to_digit(c: char) -> char {
    match c {
        'O' | 'Q' | 'D' | 'U' => '0',
        'I' | 'L' | 'T' => '1',
        'Z' => '2',
        'S' => '5',
        'G' => '6',
        'B' => '8',
        '<' => '<',
        _ => c,
    }
}

fn to_letter(c: char) -> char {
    match c {
        '0' => 'O',
        '1' => 'I',
        '2' => 'Z',
        '5' => 'S',
        '6' => 'G',
        '8' => 'B',
        _ => c,
    }
}

/// A numeric MRZ field and its check digit. Returns the digits and whether the check passed.
fn numeric_field(field: &str, check: char) -> (String, bool) {
    let digits: String = field.chars().map(to_digit).collect();
    let ok = to_digit(check) == check_digit(&digits);
    (digits, ok)
}

/// A document number: Iraqi numbers start with one or two letters, then digits. Tries the usual
/// letter/digit confusions until the check digit passes.
fn document_number(field: &str, check: char) -> (String, bool) {
    let check = to_digit(check);
    let raw: Vec<char> = field.chars().collect();
    let mut candidates = Vec::new();
    for letters in 0..=2usize {
        let candidate: String = raw.iter().enumerate().map(|(i, c)| if i < letters { to_letter(*c) } else if *c == '<' { '<' } else { to_digit(*c) }).collect();
        candidates.push(candidate);
    }
    candidates.insert(0, field.to_owned());
    for candidate in &candidates {
        if check_digit(candidate) == check {
            return (candidate.trim_end_matches('<').to_owned(), true);
        }
    }
    (field.trim_end_matches('<').to_owned(), false)
}

fn mrz_date(yymmdd: &str, birth: bool) -> Option<String> {
    let n: u32 = yymmdd.parse().ok()?;
    let (yy, mm, dd) = (n / 10000, n / 100 % 100, n % 100);
    let this_year = (chrono::Local::now().format("%y").to_string().parse::<u32>().unwrap_or(26)) as u32;
    let year = if birth { if yy > this_year { 1900 + yy } else { 2000 + yy } } else { 2000 + yy };
    iso_date(year, mm, dd)
}

/// Cleans a recognised line into MRZ characters, or None when it does not look like one.
fn mrz_line(text: &str) -> Option<String> {
    let cleaned: String = text
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            // The Arabic-script recogniser often reads the filler as an Arabic-Indic digit, and
            // sometimes a digit as its Arabic-Indic look-alike.
            '«' | '‹' | '(' | '{' | '[' | '>' | '٢' | '٨' | '٧' | '۲' | '۸' | '۷' => '<',
            '١' | '۱' => '1',
            '٥' | '٠' | '۵' | '۰' => '0',
            '٣' | '۳' => '3',
            '٤' | '۴' => '4',
            '٦' | '۶' => '6',
            '٩' | '۹' => '9',
            _ => c,
        })
        .collect();
    if cleaned.chars().count() < 20 {
        return None;
    }
    let valid = cleaned.chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '<').count();
    if valid * 10 < cleaned.chars().count() * 9 || !(cleaned.contains("<<") || cleaned.starts_with("ID") || cleaned.starts_with('P')) {
        return None;
    }
    Some(cleaned.chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '<').collect())
}

fn fit(line: &str, len: usize) -> String {
    let mut s: String = line.chars().take(len).collect();
    while s.chars().count() < len {
        s.push('<');
    }
    s
}

fn gender_from_mrz(c: char) -> Option<&'static str> {
    match c {
        'M' => Some("ذكر"),
        'F' => Some("أنثى"),
        _ => None,
    }
}

fn confidence(ok: bool) -> f32 { if ok { 0.99 } else { 0.5 } }

/// TD1 (national card back, 3 × 30).
pub fn parse_td1(l1: &str, l2: &str, result: &mut ReadResult) {
    let (l1, l2) = (fit(l1, 30), fit(l2, 30));
    let c1: Vec<char> = l1.chars().collect();
    let c2: Vec<char> = l2.chars().collect();
    let (card, card_ok) = document_number(&l1[5..14], c1[14]);
    let (birth, birth_ok) = numeric_field(&l2[0..6], c2[6]);
    let (expiry, expiry_ok) = numeric_field(&l2[8..14], c2[14]);
    let optional: String = l1[15..30].chars().map(to_digit).collect();
    let national: String = optional.chars().take_while(char::is_ascii_digit).collect();
    let composite = format!("{card_field}{check}{optional}{birth}{bc}{expiry}{ec}{opt2}", card_field = fit(&card, 9), check = c1[14], optional = optional, birth = birth, bc = to_digit(c2[6]), expiry = expiry, ec = to_digit(c2[14]), opt2 = &l2[18..29]);
    // The second optional field is empty on Iraqi cards; a misread filler there should not void
    // the national number.
    let empty_opt2 = format!("{}{}", &composite[..composite.len() - 11], "<".repeat(11));
    let composite_ok = check_digit(&composite) == to_digit(c2[29]) || check_digit(&empty_opt2) == to_digit(c2[29]);
    result.set("card_no", card, confidence(card_ok), "mrz");
    if national.len() == 12 {
        result.set("national_no", national, confidence(composite_ok && card_ok), "mrz");
    }
    if let Some(date) = mrz_date(&birth, true) {
        result.set("birthdate", date, confidence(birth_ok), "mrz");
    }
    if let Some(date) = mrz_date(&expiry, false) {
        result.set("expiry_date", date, confidence(expiry_ok), "mrz");
    }
    if let Some(gender) = gender_from_mrz(c2[7]) {
        result.set("gender", gender, confidence(birth_ok && expiry_ok), "mrz");
    }
    if !(card_ok && birth_ok && expiry_ok) {
        result.warnings.push("بعض أرقام الشريط السفلي لم تتطابق مع أرقام التحقق".into());
    }
}

/// TD3 (passport, 2 × 44).
pub fn parse_td3(l1: &str, l2: &str, result: &mut ReadResult) {
    let (l1, l2) = (fit(l1, 44), fit(l2, 44));
    let c2: Vec<char> = l2.chars().collect();
    let (number, number_ok) = document_number(&l2[0..9], c2[9]);
    let (birth, birth_ok) = numeric_field(&l2[13..19], c2[19]);
    let (expiry, expiry_ok) = numeric_field(&l2[21..27], c2[27]);
    let (personal, personal_ok) = numeric_field(&l2[28..42], c2[42]);
    result.set("passport_no", number, confidence(number_ok), "mrz");
    result.set("passport_type", l1.chars().next().filter(char::is_ascii_uppercase).map(String::from).unwrap_or_default(), 0.95, "mrz");
    if let Some(date) = mrz_date(&birth, true) {
        result.set("birthdate", date, confidence(birth_ok), "mrz");
    }
    if let Some(date) = mrz_date(&expiry, false) {
        result.set("expiry_date", date, confidence(expiry_ok), "mrz");
    }
    if let Some(gender) = gender_from_mrz(c2[20]) {
        result.set("gender", gender, confidence(birth_ok && expiry_ok), "mrz");
    }
    let national: String = personal.trim_end_matches('<').to_owned();
    if national.len() == 12 && national.chars().all(|c| c.is_ascii_digit()) {
        result.set("national_no", national, confidence(personal_ok), "mrz");
    }
    let names = &l1[5..];
    let mut parts = names.splitn(2, "<<");
    let surname = parts.next().unwrap_or("").replace('<', " ").trim().to_owned();
    let given = parts.next().unwrap_or("").replace('<', " ").split_whitespace().collect::<Vec<_>>().join(" ");
    let letters_only = |s: &str| s.chars().all(|c| c.is_ascii_uppercase() || c == ' ');
    result.set("latin_surname", surname.clone(), if letters_only(&surname) { 0.9 } else { 0.5 }, "mrz");
    result.set("latin_given", given.clone(), if letters_only(&given) { 0.9 } else { 0.5 }, "mrz");
    if !(number_ok && birth_ok && expiry_ok) {
        result.warnings.push("بعض أرقام الشريط السفلي لم تتطابق مع أرقام التحقق".into());
    }
}

/// Finds and parses the MRZ among the lines. Returns "td1", "td3" or None.
fn parse_mrz(lines: &[Line], result: &mut ReadResult) -> Option<&'static str> {
    // Lines of the zone can be split into pieces on the same row: join them left to right.
    let mut candidates: Vec<(f32, f32, f32, String)> = Vec::new();
    for line in lines {
        if let Some(text) = mrz_line(&line.text) {
            candidates.push((line.center_y(), line.height(), line.bbox[0], text));
        }
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut rows: Vec<(f32, f32, Vec<(f32, String)>)> = Vec::new();
    for (y, h, x, text) in candidates {
        match rows.last_mut() {
            Some(row) if (row.0 - y).abs() < row.1.min(h) * 0.5 => row.2.push((x, text)),
            _ => rows.push((y, h, vec![(x, text)])),
        }
    }
    let rows: Vec<String> = rows
        .into_iter()
        .map(|(_, _, mut parts)| {
            parts.sort_by(|a, b| a.0.total_cmp(&b.0));
            parts.into_iter().map(|p| p.1).collect()
        })
        .collect();
    for (i, row) in rows.iter().enumerate() {
        if row.starts_with('P') && row.len() >= 30 && rows.get(i + 1).is_some_and(|next| next.len() >= 30) {
            parse_td3(row, &rows[i + 1], result);
            return Some("td3");
        }
        if (row.starts_with("ID") || row.starts_with("I<") || row.get(2..5) == Some("IRQ")) && rows.get(i + 1).is_some_and(|next| next.len() >= 20) {
            parse_td1(row, &rows[i + 1], result);
            return Some("td1");
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Rows of printed text

/// Joins boxes on the same row, right to left (reading order of the Arabic card).
fn rows(lines: &[Line]) -> Vec<(Line, Vec<Line>)> {
    let mut sorted: Vec<&Line> = lines.iter().collect();
    sorted.sort_by(|a, b| a.center_y().total_cmp(&b.center_y()));
    let mut groups: Vec<Vec<Line>> = Vec::new();
    for line in sorted {
        match groups.last_mut() {
            Some(group) if {
                let last = &group[0];
                let overlap = last.bbox[3].min(line.bbox[3]) - last.bbox[1].max(line.bbox[1]);
                overlap > 0.5 * last.height().min(line.height())
            } => group.push(line.clone()),
            _ => groups.push(vec![line.clone()]),
        }
    }
    groups
        .into_iter()
        .map(|mut group| {
            group.sort_by(|a, b| b.bbox[2].total_cmp(&a.bbox[2]));
            let text = group.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
            let confidence = group.iter().map(|l| l.confidence).fold(1f32, f32::min);
            let bbox = group.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, l| {
                [b[0].min(l.bbox[0]), b[1].min(l.bbox[1]), b[2].max(l.bbox[2]), b[3].max(l.bbox[3])]
            });
            (Line { text, confidence, bbox }, group)
        })
        .collect()
}

/// Kurdish words of the bilingual labels (normalised), removed from values.
const KURDISH: &[&str] = &[
    "ناو", "باوك", "باپير", "بابير", "نازناو", "دايك", "رهگهز", "رگهز", "رهگز", "گروپي", "گروپى", "گروبي", "خوين", "خوێن",
    "لايهني", "لاينى", "لايهنى", "دهرچوون", "دهرجوون", "درچوون", "روژي", "رۆژي", "روزي", "بهسهرچوون", "بهسهرجوون",
    "شويني", "شوێني", "لهدايك", "لهدايكبوون", "بوون", "ژمارهي", "ژمارهى", "خيزاني", "خێزاني", "كارتي", "نيشتماني",
];

fn is_kurdish_word(token: &str) -> bool {
    // A slash between the labels is often read as a leading alef.
    is_kurdish_word_exact(token) || token.chars().count() > 3 && token.starts_with('ا') && is_kurdish_word_exact(&token.chars().skip(1).collect::<String>())
}

fn is_kurdish_word_exact(token: &str) -> bool {
    let t = normalize(token);
    if t.chars().any(|c| matches!(c, 'ێ' | 'ۆ' | 'ڕ' | 'ڵ' | 'ڤ' | 'ژ' | 'گ' | 'پ' | 'چ')) {
        return true;
    }
    KURDISH.iter().any(|k| {
        let k = normalize(k);
        let n = k.chars().count();
        t == k || (n >= 4 && levenshtein(&t, &k) <= 1) || (n >= 6 && levenshtein(&t, &k) <= 2)
    })
}

/// Removes a Kurdish label word glued to the front of a value ("ناوأحمد" → "أحمد").
fn strip_glued_kurdish(token: &str) -> String {
    let stripped = strip_glued_kurdish_exact(token);
    if stripped != token {
        return stripped;
    }
    // One junk letter (the slash, misread) before the Kurdish word.
    let tail: String = token.chars().skip(1).collect();
    let stripped = strip_glued_kurdish_exact(&tail);
    if stripped != tail { stripped } else { token.to_owned() }
}

fn strip_glued_kurdish_exact(token: &str) -> String {
    let t: Vec<char> = token.chars().collect();
    for k in KURDISH {
        let k: Vec<char> = normalize(k).chars().collect();
        for cut in [k.len(), k.len().saturating_sub(1), k.len() + 1] {
            if cut < 3 || cut + 2 > t.len() {
                continue;
            }
            let head: String = normalize(&t[..cut].iter().collect::<String>());
            let allowed = if k.len() >= 4 { 1 } else { 0 };
            if levenshtein(&head, &k.iter().collect::<String>()) <= allowed {
                return t[cut..].iter().collect();
            }
        }
    }
    token.to_owned()
}

fn arabic_only(text: &str) -> String {
    text.split_whitespace()
        .map(|w| w.chars().filter(|c| is_arabic_letter(*c)).collect::<String>())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The value of a labelled row: what is left after the Arabic label and the Kurdish words.
fn row_value(text: &str, label_words: usize) -> String {
    let words = tokens(text);
    let rest: Vec<String> = words
        .into_iter()
        .skip(label_words)
        .filter(|w| !is_kurdish_word(w))
        .map(|w| strip_glued_kurdish(&w))
        .collect();
    rest.join(" ")
}

/// Joins letters split off a word ("ز ينب" → "زينب"): no Arabic name is a single letter.
fn merge_single_letters(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut pending = String::new();
    for word in text.split_whitespace() {
        if word.chars().count() == 1 {
            pending.push_str(word);
        } else {
            words.push(format!("{pending}{word}"));
            pending.clear();
        }
    }
    if !pending.is_empty() {
        match words.last_mut() {
            Some(last) => last.push_str(&pending),
            None => words.push(pending),
        }
    }
    words
}

/// Words that start a two-word name ("عبد الله", "نور الهدى").
const COMPOUND_START: &[&str] = &["عبد", "ابو", "ام", "نور", "سيف", "صلاح", "جمال", "عز", "شمس", "بهاء", "ضياء", "علاء", "نصر", "محي", "زين", "سعد", "عماد", "حسام", "فخر", "ال"];

/// One name on the card: the last word after the label, with the first word of a compound name.
fn name_value(text: &str) -> String {
    let words = merge_single_letters(&arabic_only(text));
    let Some(last) = words.last() else { return String::new() };
    if words.len() >= 2 {
        let before = normalize(&words[words.len() - 2]);
        if COMPOUND_START.contains(&before.as_str()) {
            return format!("{} {}", words[words.len() - 2], last);
        }
    }
    last.clone()
}

/// Labels of the front of the card, in their printed order.
const FRONT_LABELS: &[(&str, &str)] = &[
    ("الاسم", "first"),
    ("الاب", "father"),
    ("الجد", "grandfather"),
    ("اللقب", "surname"),
    ("الام", "mother_first"),
    ("الجد", "mother_father"),
    ("الجنس", "gender"),
    ("فصيله", "blood_type"),
];

fn front_label(first_word: &str) -> Option<&'static str> {
    let w = normalize(first_word);
    let w = w.trim_start_matches(|c: char| !is_arabic_letter(c));
    FRONT_LABELS.iter().find(|(label, _)| w == *label || (label.chars().count() >= 5 && levenshtein(w, label) <= 1 && w != "الام")).map(|(label, _)| *label)
}

fn blood_type(text: &str) -> Option<String> {
    let groups = ["AB", "A", "B", "O"];
    for token in text.to_uppercase().split(|c: char| c.is_whitespace() || matches!(c, ':' | '/' | '|')) {
        let token = token.replace('0', "O").replace('٠', "O");
        for g in groups {
            for sign in ['+', '-'] {
                // Arabic reading order may put the sign first: "+A".
                if token == format!("{g}{sign}") || token == format!("{sign}{g}") {
                    return Some(format!("{g}{sign}"));
                }
            }
        }
    }
    None
}

fn parse_front(lines: &[Line], result: &mut ReadResult) -> bool {
    let mut found = false;
    let mut seen_mother = false;
    let mut seen_grandfather = false;
    for (row, _) in rows(lines) {
        let words = tokens(&row.text);
        // A label may also be glued to the Kurdish word; look at the first two words.
        let Some((label_index, label)) = words.iter().take(2).enumerate().find_map(|(i, w)| front_label(w).map(|l| (i, l))) else { continue };
        let key = match label {
            "الجد" if seen_mother || seen_grandfather => { seen_mother = true; "mother_father" }
            "الجد" => { seen_grandfather = true; "grandfather" }
            "الام" => { seen_mother = true; "mother_first" }
            other => FRONT_LABELS.iter().find(|(l, _)| *l == other).map(|(_, k)| *k).unwrap_or(""),
        };
        let skip = label_index + if label == "فصيله" { 2 } else { 1 };
        let value = row_value(&row.text, skip);
        match key {
            "gender" => {
                let v = normalize(&value);
                let gender = if v.contains("انثي") || v.contains("انث") { Some("أنثى") } else if v.contains("ذكر") || v.contains("دكر") { Some("ذكر") } else { None };
                if let Some(g) = gender {
                    result.set("gender", g, row.confidence, "text");
                    found = true;
                }
            }
            "blood_type" => {
                if let Some(b) = blood_type(&row.text) {
                    result.set("blood_type", b, row.confidence, "text");
                    found = true;
                }
            }
            "" => {}
            _ => {
                let name = name_value(&value);
                if !name.is_empty() {
                    result.set(key, name, row.confidence, "text");
                    found = true;
                }
            }
        }
    }
    if result.get("blood_type").is_none() {
        // The group is printed far from its label; any line may carry it.
        if let Some(line) = lines.iter().find(|l| blood_type(&l.text).is_some() && l.text.chars().count() <= 12) {
            result.set("blood_type", blood_type(&line.text).unwrap(), line.confidence, "text");
        }
    }
    for line in lines {
        let digits = ascii_digits(&line.text).replace(' ', "");
        if digits.len() == 12 && digits.chars().all(|c| c.is_ascii_digit()) {
            result.set("national_no", digits, line.confidence, "text");
        } else if (9..=10).contains(&digits.len()) && digits.chars().take(1).all(|c| c.is_ascii_uppercase()) && digits.chars().skip(2).all(|c| c.is_ascii_digit()) {
            result.set("card_no", digits, line.confidence * 0.95, "text");
        }
    }
    found
}

/// Labels of the back of the card (normalised, without spaces).
const BACK_LABELS: &[(&str, &str)] = &[
    ("جههالاصدار", "issuer"),
    ("تاريخالاصدار", "issue_date"),
    ("تاريخالنفاذ", "expiry_date"),
    ("محلالولاده", "birthplace"),
    ("تاريخالولاده", "birthdate"),
    ("الرقمالعائلي", "family_no"),
];

/// The text after the first `count` letters (spaces not counted).
fn skip_letters(text: &str, count: usize) -> String {
    let mut seen = 0;
    for (i, c) in text.char_indices() {
        if seen == count {
            return text[i..].to_owned();
        }
        if !c.is_whitespace() {
            seen += 1;
        }
    }
    String::new()
}

fn back_label(text: &str) -> Option<(&'static str, usize)> {
    let compact: String = normalize(text).chars().filter(|c| !c.is_whitespace()).collect();
    BACK_LABELS
        .iter()
        .filter_map(|(label, key)| {
            let n = label.chars().count();
            // Allow one letter more or less in the label itself.
            (n - 1..=n + 1)
                .map(|len| (levenshtein(&compact.chars().take(len).collect::<String>(), label), len))
                .min()
                .filter(|(d, _)| *d <= 2)
                .map(|(d, len)| (d, *key, len))
        })
        .min_by_key(|(d, _, _)| *d)
        .map(|(_, key, len)| (key, len))
}

fn parse_back(lines: &[Line], result: &mut ReadResult) -> bool {
    let mut found = false;
    for (row, _) in rows(lines) {
        let Some((key, label_len)) = back_label(&row.text) else { continue };
        let rest = skip_letters(&normalize_keep_len(&row.text), label_len);
        match key {
            "issue_date" | "expiry_date" | "birthdate" => {
                if let Some(date) = find_date(&rest) {
                    result.set(key, date, row.confidence, "text");
                    found = true;
                }
            }
            "family_no" => {
                let value = tokens(&ascii_digits(&rest)).into_iter().find(|w| w.len() >= 12 && w.chars().all(|c| c.is_ascii_alphanumeric()) && w.chars().filter(char::is_ascii_digit).count() >= 8);
                if let Some(v) = value {
                    result.set("family_no", v.to_uppercase(), row.confidence, "text");
                    found = true;
                }
            }
            _ => {
                let value = row_value(&rest, 0);
                let mut value = value.split_whitespace().map(|w| w.chars().filter(|c| is_arabic_letter(*c) || *c == '-').collect::<String>()).filter(|w| w.chars().filter(|c| is_arabic_letter(*c)).count() >= 2).collect::<Vec<_>>().join(" ");
                // The issuing office is a directorate; cut what is left of the label before it.
                if let Some(i) = value.find("ديري") {
                    value = format!("م{}", &value[i..]);
                }
                if !value.is_empty() {
                    result.set(key, value, row.confidence, "text");
                    found = true;
                }
            }
        }
    }
    found
}

/// Removes only what `normalize` drops (diacritics, tatweel) so letter counts line up.
fn normalize_keep_len(text: &str) -> String {
    text.chars().filter(|c| !matches!(c, 'ـ' | '\u{064B}'..='\u{065F}' | '\u{0670}')).collect()
}

// ---------------------------------------------------------------------------------------------
// Passport visual zone

/// Whether the line starts (within its first letters) with the label, allowing misreads.
fn has_label(text: &str, label: &str) -> bool {
    let compact: Vec<char> = normalize(text).chars().filter(|c| is_arabic_letter(*c)).collect();
    let label: String = normalize(label).chars().filter(|c| !c.is_whitespace()).collect();
    let n = label.chars().count();
    let allowed = if n >= 9 { 2 } else { 1 };
    (0..=2usize).any(|offset| {
        offset + n <= compact.len() && levenshtein(&compact[offset..offset + n].iter().collect::<String>(), &label) <= allowed
    })
}

/// The Arabic value printed under a label on the passport data page.
fn value_below(lines: &[Line], label: &str) -> Option<Line> {
    let anchor = lines.iter().find(|l| has_label(&l.text, label))?;
    lines
        .iter()
        .filter(|l| l.center_y() > anchor.center_y() + anchor.height() * 0.5 && l.center_y() < anchor.center_y() + anchor.height() * 3.)
        .filter(|l| l.bbox[0] < anchor.bbox[2] && l.bbox[2] > anchor.bbox[0])
        // Values are Arabic only; label lines also carry English.
        .filter(|l| l.text.chars().any(is_arabic_letter) && !l.text.chars().any(|c| c.is_ascii_alphabetic()))
        .min_by(|a, b| a.center_y().total_cmp(&b.center_y()))
        .cloned()
}

fn parse_passport_text(lines: &[Line], result: &mut ReadResult) {
    let birth = result.get("birthdate").map(|f| f.value.clone());
    let expiry = result.get("expiry_date").map(|f| f.value.clone());
    for line in lines {
        for date in find_all_dates(&line.text) {
            if Some(&date) != birth.as_ref() && Some(&date) != expiry.as_ref() && result.get("issue_date").is_none() {
                result.set("issue_date", date, line.confidence, "text");
            }
        }
    }
    if let Some(line) = value_below(lines, "الاسم الثلاثي") {
        let names = merge_single_letters(&arabic_only(&line.text));
        let confidence = if names.len() == 3 { line.confidence } else { line.confidence * 0.6 };
        for (key, value) in ["first", "father", "grandfather"].iter().zip(names.iter()) {
            result.set(key, value.clone(), confidence, "text");
        }
    }
    if let Some(line) = value_below(lines, "اللقب") {
        result.set("surname", merge_single_letters(&arabic_only(&line.text)).join(" "), line.confidence, "text");
    }
    if let Some(line) = value_below(lines, "اسم الام") {
        let names = merge_single_letters(&arabic_only(&line.text));
        if let Some(first) = names.first() {
            result.set("mother_first", first.clone(), line.confidence, "text");
        }
        if names.len() >= 2 {
            result.set("mother_father", names[1..].join(" "), line.confidence * if names.len() == 2 { 1. } else { 0.6 }, "text");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Other cards (badges): no known layout, so only what can be told apart without one.

/// Dates and the document number of a card whose layout is not known. The earliest date is taken
/// as the issue date and the latest as the expiry; the number is the longest run of digits that is
/// not part of a date. These are guesses and get a lower confidence.
fn parse_generic(lines: &[Line], result: &mut ReadResult) {
    let mut dates: Vec<(String, f32)> = Vec::new();
    let mut number: Option<(String, f32)> = None;
    for line in lines {
        let text = ascii_digits(&line.text);
        let found = find_all_dates(&text);
        dates.extend(found.iter().map(|d| (d.clone(), line.confidence)));
        let mut rest = text.clone();
        // Remove the date strings so their digits are not taken for the number.
        for token in text.split_whitespace() {
            if find_date(token).is_some() {
                rest = rest.replace(token, " ");
            }
        }
        for token in rest.split(|c: char| !c.is_ascii_alphanumeric()) {
            let digits = token.chars().filter(char::is_ascii_digit).count();
            if digits >= 4 && digits * 2 >= token.len() && number.as_ref().is_none_or(|(n, _)| token.len() > n.len()) {
                number = Some((token.to_uppercase(), line.confidence));
            }
        }
    }
    dates.sort_by(|a, b| a.0.cmp(&b.0));
    dates.dedup_by(|a, b| a.0 == b.0);
    if let Some((first, c)) = dates.first() {
        if dates.len() >= 2 {
            result.set("issue_date", first.clone(), c * 0.7, "text");
        }
    }
    if let Some((last, c)) = dates.last() {
        result.set("expiry_date", last.clone(), c * 0.7, "text");
    }
    if let Some((n, c)) = number {
        result.set("doc_number", n, c * 0.7, "text");
    }
    if !result.fields.is_empty() {
        result.document = "other".into();
        result.warnings.push("تصميم هذه الوثيقة غير معروف للبرنامج: الأرقام والتواريخ مقروءة لكن تحديد أيها للإصدار وأيها للنفاذ تخمين، فراجعها.".into());
    }
}

// ---------------------------------------------------------------------------------------------

pub fn parse(lines: &[Line]) -> ReadResult {
    let mut result = ReadResult::default();
    let mrz = parse_mrz(lines, &mut result);
    if mrz == Some("td3") {
        parse_passport_text(lines, &mut result);
        result.document = "passport".into();
    } else {
        let back = parse_back(lines, &mut result) || mrz == Some("td1");
        let front = parse_front(lines, &mut result);
        result.document = match (front, back) {
            (true, true) => "national",
            (true, false) => "national_front",
            (false, true) => "national_back",
            _ => "unknown",
        }
        .into();
    }
    if result.document == "unknown" {
        parse_generic(lines, &mut result);
    }
    if result.fields.is_empty() {
        result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, y: f32) -> Line { Line { text: text.into(), confidence: 0.95, bbox: [0., y, 100., y + 10.] } }

    /// Synthetic MRZ built with valid check digits (no real person's data).
    fn td1() -> (String, String) {
        let card = "XY1234567";
        let national = "100000000001";
        let birth = "900101";
        let expiry = "301231";
        let l1 = format!("IDIRQ{card}{}{national}<<<", check_digit(card));
        let opt2 = "<<<<<<<<<<<";
        let partial = format!("{birth}{}M{expiry}{}IRQ{opt2}", check_digit(birth), check_digit(expiry));
        let composite = format!("{}{}{}{}{}", &l1[5..30], &partial[0..7], &partial[8..15], &partial[18..29], "");
        let l2 = format!("{partial}{}", check_digit(&composite));
        (l1, l2)
    }

    #[test]
    fn check_digits_follow_icao() {
        // ICAO 9303 specimen values.
        assert_eq!(check_digit("L898902C3"), '6');
        assert_eq!(check_digit("740812"), '2');
        assert_eq!(check_digit("120415"), '9');
    }

    #[test]
    fn reads_td1_with_ocr_confusions() {
        let (l1, l2) = td1();
        let mut r = ReadResult::default();
        parse_td1(&l1.replace("1234", "I234"), &l2.replace("900101", "9OO1O1"), &mut r);
        assert_eq!(r.get("card_no").unwrap().value, "XY1234567");
        assert_eq!(r.get("national_no").unwrap().value, "100000000001");
        assert_eq!(r.get("national_no").unwrap().confidence, 0.99);
        assert_eq!(r.get("birthdate").unwrap().value, "1990-01-01");
        assert_eq!(r.get("expiry_date").unwrap().value, "2030-12-31");
        assert_eq!(r.get("gender").unwrap().value, "ذكر");
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn reads_td3_icao_specimen() {
        let l1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
        let l2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
        let mut r = ReadResult::default();
        parse_td3(l1, l2, &mut r);
        assert_eq!(r.get("passport_no").unwrap().value, "L898902C3");
        assert_eq!(r.get("passport_no").unwrap().confidence, 0.99);
        assert_eq!(r.get("latin_surname").unwrap().value, "ERIKSSON");
        assert_eq!(r.get("latin_given").unwrap().value, "ANNA MARIA");
        assert_eq!(r.get("birthdate").unwrap().value, "1974-08-12");
        assert_eq!(r.get("expiry_date").unwrap().value, "2012-04-15");
        assert_eq!(r.get("gender").unwrap().value, "أنثى");
    }

    #[test]
    fn reads_front_labels() {
        let lines = vec![
            line("الاسم ناو أحمد", 0.),
            line("الاب باوك محمد", 20.),
            line("الجد باپير علي", 40.),
            line("اللقب نازناو الكاظمي", 60.),
            line("الأم دايك زينب", 80.),
            line("الجد بابير حسين", 100.),
            line("الجنس رەگەز ذكر", 120.),
            line("فصيلة الدم گروپی خوین O+", 140.),
            line("100000000001", 160.),
        ];
        let r = parse(&lines);
        assert_eq!(r.document, "national_front");
        let v = |k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        assert_eq!(v("first"), "أحمد");
        assert_eq!(v("father"), "محمد");
        assert_eq!(v("grandfather"), "علي");
        assert_eq!(v("surname"), "الكاظمي");
        assert_eq!(v("mother_first"), "زينب");
        assert_eq!(v("mother_father"), "حسين");
        assert_eq!(v("gender"), "ذكر");
        assert_eq!(v("blood_type"), "O+");
        assert_eq!(v("national_no"), "100000000001");
    }

    #[test]
    fn strips_glued_kurdish_label() {
        assert_eq!(row_value("الاسم ناوأحمد", 1), "أحمد");
        assert_eq!(row_value("الاب باوكمحمد", 1), "محمد");
    }

    #[test]
    fn reads_back_labels() {
        let (l1, l2) = td1();
        let lines = vec![
            line("جهة الاصدار لايەنی دەرچوون مديرية الجنسية", 0.),
            line("تاريخ الاصدار رۆژی دەرچوون 2020/01/02", 20.),
            line("تاريخ النفاذ رۆژی بەسەرچوون 2030/12/31", 40.),
            line("محل الولادة شوێنی لەدایک بوون الكرخ-بغداد", 60.),
            line("تاريخ الولادة رۆژی لەدایک بوون 1990/01/01", 80.),
            line("الرقم العائلي ژمارەی خێزانی 1000A0B00000000001", 100.),
            line(&l1, 200.),
            line(&l2, 215.),
        ];
        let r = parse(&lines);
        assert_eq!(r.document, "national_back");
        let v = |k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        assert_eq!(v("issuer"), "مديرية الجنسية");
        assert_eq!(v("issue_date"), "2020-01-02");
        assert_eq!(v("expiry_date"), "2030-12-31");
        assert_eq!(r.get("expiry_date").unwrap().source, "mrz");
        assert_eq!(v("birthplace"), "الكرخ-بغداد");
        assert_eq!(v("birthdate"), "1990-01-01");
        assert_eq!(v("family_no"), "1000A0B00000000001");
    }

    #[test]
    fn dates_in_both_orders() {
        assert_eq!(find_date("x 2020/02/06 y").as_deref(), Some("2020-02-06"));
        assert_eq!(find_date("13.12.2023").as_deref(), Some("2023-12-13"));
        assert_eq!(find_date("٢٠٢٠/٠٢/٠٦").as_deref(), Some("2020-02-06"));
        assert_eq!(find_date("2020/13/40"), None);
    }

    #[test]
    fn names_keep_the_value_only() {
        assert_eq!(name_value("ز ينب"), "زينب");
        assert_eq!(name_value("اداك عبد الله"), "عبد الله");
        assert_eq!(name_value("اداك زينب"), "زينب");
    }

    #[test]
    fn blood_type_ignores_neighbouring_numbers() {
        assert_eq!(blood_type(":O+ XY0000000").as_deref(), Some("O+"));
        assert_eq!(blood_type("XY0000000"), None);
    }

    #[test]
    fn other_cards_dates_and_number() {
        let lines = vec![line("هوية دخول", 0.), line("رقم الهوية 004512", 20.), line("2024/01/10 الاصدار", 40.), line("النفاذ 2026/01/09", 60.)];
        let r = parse(&lines);
        assert_eq!(r.document, "other");
        let v = |k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        assert_eq!(v("issue_date"), "2024-01-10");
        assert_eq!(v("expiry_date"), "2026-01-09");
        assert_eq!(v("doc_number"), "004512");
        assert!(r.get("doc_number").unwrap().confidence < 0.85);
    }

    #[test]
    fn blood_types() {
        assert_eq!(blood_type("AB+").as_deref(), Some("AB+"));
        assert_eq!(blood_type("+A").as_deref(), Some("A+"));
        assert_eq!(blood_type("0-").as_deref(), Some("O-"));
    }
}
