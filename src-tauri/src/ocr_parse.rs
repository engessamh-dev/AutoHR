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
    /// 0..1. MRZ values that pass their check digit, and QR values, get 0.99.
    pub confidence: f32,
    /// "mrz", "qr" or "text".
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ReadResult {
    /// national_front, national_back, national (both sides), passport or unknown.
    pub document: String,
    pub fields: Vec<Field>,
    pub warnings: Vec<String>,
    /// Fields written by hand on this card: not read (handwriting is not reliable), to be typed
    /// from the image. Keys as in `fields`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub handwritten: Vec<String>,
    /// Where each handwritten field is on the image (its label's row), for `locate`.
    #[serde(skip)]
    pub marks: Vec<(String, [f32; 4])>,
}

/// Values the MRZ carries that are also printed: a disagreement between the two is reported.
const MRZ_CHECKED: &[(&str, &str)] = &[("birthdate", "تاريخ الولادة"), ("expiry_date", "تاريخ النفاذ"), ("gender", "الجنس"), ("national_no", "الرقم الوطني")];

impl ReadResult {
    fn get(&self, key: &str) -> Option<&Field> { self.fields.iter().find(|f| f.key == key) }

    fn set(&mut self, key: &str, value: impl Into<String>, confidence: f32, source: &'static str) {
        let value = value.into();
        if value.trim().is_empty() {
            return;
        }
        match self.fields.iter_mut().find(|f| f.key == key) {
            // An MRZ or QR value that passed its check wins over printed text; printed text that
            // says otherwise is named, so the card can be looked at.
            Some(existing) if existing.source != "text" && existing.confidence >= confidence => {
                if source == "text" && existing.source == "mrz" && existing.value != value {
                    if let Some(label) = MRZ_CHECKED.iter().find(|(k, _)| *k == key).map(|(_, l)| *l) {
                        let (printed, strip) = (value.clone(), existing.value.clone());
                        self.warnings.push(format!("{label} المطبوع «{printed}» يختلف عن الشريط السفلي «{strip}»: اعتمدنا الشريط السفلي، قارنه بالبطاقة."));
                    }
                }
            }
            Some(existing) => *existing = Field { key: key.into(), value, confidence, source },
            None => self.fields.push(Field { key: key.into(), value, confidence, source }),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/// Arabic normalisation for matching labels: hamza forms, ta marbuta, alef maqsura, Persian
/// letters the recogniser may pick, diacritics and tatweel.
/// Where on the image each printed value was read: (key, line box). Values from the MRZ or a QR
/// code are not located. A date or number is matched by its digits, a name by its words.
pub fn locate(result: &ReadResult, lines: &[Line]) -> Vec<(String, [f32; 4])> {
    let digits = |t: &str| ascii_digits(t).chars().filter(char::is_ascii_digit).collect::<String>();
    result
        .fields
        .iter()
        .filter(|f| f.source == "text")
        .filter_map(|f| {
            let wanted_digits = digits(&f.value);
            let line = if wanted_digits.len() >= 4 {
                lines.iter().find(|l| digits(&l.text).contains(&wanted_digits))
            } else {
                let words: Vec<String> = f.value.split(|c: char| c.is_whitespace() || c == '-').filter(|w| !w.is_empty()).map(normalize).collect();
                (!words.is_empty()).then(|| lines.iter().find(|l| { let t = normalize(&l.text); words.iter().all(|w| t.contains(w.as_str())) })).flatten()
            }?;
            Some((f.key.clone(), line.bbox))
        })
        .chain(result.marks.iter().cloned())
        .collect()
}

/// The reader's mark for a thin separator between letters (`ocr::SEPARATOR`).
const SEP: char = '\u{2010}';

/// Lines with the separator mark read as a word break: for everything but the place of birth.
/// A mark next to a lone letter (a misread slash, "ا‐نازناو") joins instead, as before the mark existed.
fn with_breaks(lines: &[Line]) -> Vec<Line> {
    lines.iter().map(|l| Line { text: break_at_marks(&l.text), ..l.clone() }).collect()
}

fn break_at_marks(text: &str) -> String {
    let mut out = String::new();
    for (i, piece) in text.split(SEP).enumerate() {
        let lone = |w: Option<&str>| w.is_some_and(|w| w.chars().count() == 1);
        if i > 0 && !lone(out.split_whitespace().last()) && !lone(piece.split_whitespace().next()) {
            out.push(' ');
        }
        out.push_str(piece);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

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
    text.split(|c: char| c.is_whitespace() || matches!(c, '/' | ':' | '|' | '\\' | '،' | '؛' | SEP))
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
            // Arabic rows read right to left; a row with no Arabic (zone codes, a Latin name) left to right.
            if group.iter().any(|l| l.text.chars().any(is_arabic_letter)) {
                group.sort_by(|a, b| b.bbox[2].total_cmp(&a.bbox[2]));
            } else {
                group.sort_by(|a, b| a.bbox[0].total_cmp(&b.bbox[0]));
            }
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
    // Where each name was read: (key, centre of the line holding the value).
    let mut name_at: Vec<(&'static str, f32)> = Vec::new();
    for (row, group) in rows(lines) {
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
                    let word = if g == "ذكر" { "كر" } else { "نث" };
                    result.set("gender", g, value_confidence(&group, word, row.confidence), "text");
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
                    let last = name.split_whitespace().last().unwrap_or_default().to_owned();
                    let source = group.iter().rev().find(|l| normalize(&l.text).contains(&normalize(&last)));
                    name_at.push((key, source.map_or(row.center_y(), Line::center_y)));
                    result.set(key, name, value_confidence(&group, &last, row.confidence), "text");
                    found = true;
                }
            }
        }
    }
    mother_by_position(lines, &name_at, result);
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

/// Confidence of a value: that of the box it was read from, not of the whole row, whose label
/// boxes (Kurdish words especially) are often read with less certainty than the value itself.
fn value_confidence(group: &[Line], word: &str, row_confidence: f32) -> f32 {
    let word = normalize(word);
    if word.is_empty() {
        return row_confidence;
    }
    group.iter().rev().find(|l| normalize(&l.text).contains(&word)).map_or(row_confidence, |l| l.confidence)
}

/// The mother's name when its label was not read: the row printed between the surname and the
/// mother's father. Offered at reduced confidence, for review.
fn mother_by_position(lines: &[Line], name_at: &[(&str, f32)], result: &mut ReadResult) {
    if result.get("mother_first").is_some() {
        return;
    }
    let at = |key: &str| name_at.iter().find(|(k, _)| *k == key).map(|(_, y)| *y);
    let (Some(above), Some(below)) = (at("surname"), at("mother_father")) else { return };
    let candidate = lines.iter().filter(|l| l.center_y() > above && l.center_y() < below).find_map(|l| {
        let words: Vec<String> = merge_single_letters(&arabic_only(&l.text))
            .into_iter()
            .filter(|w| w.chars().count() >= 3 && !is_kurdish_word(w) && front_label(w).is_none())
            .collect();
        words.last().map(|w| (w.clone(), l.confidence))
    });
    if let Some((name, confidence)) = candidate {
        result.set("mother_first", name, confidence.min(0.75), "text");
    }
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
        if !c.is_whitespace() && c != SEP {
            seen += 1;
        }
    }
    String::new()
}

fn back_label(text: &str) -> Option<(&'static str, usize)> {
    let compact: String = normalize(text).chars().filter(|c| !c.is_whitespace() && *c != SEP).collect();
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
            "birthplace" => {
                if let Some(value) = place_value(&rest) {
                    result.set(key, value, row.confidence, "text");
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
/// The place of birth, printed as parts joined by "-" ("حي-قضاء-محافظة"). The reader may give
/// the dash as a separator mark, a dash of any kind or a spaced dash; Kurdish label words go.
fn place_value(rest: &str) -> Option<String> {
    let text: String = rest.chars().map(|c| if c == SEP || matches!(c, '-' | '‑' | '–' | '—' | '−' | '_') { '-' } else { c }).collect();
    let parts: Vec<String> = text
        .split('-')
        .map(|part| {
            tokens(part)
                .into_iter()
                .filter(|w| !is_kurdish_word(w))
                .map(|w| strip_glued_kurdish(&w).chars().filter(|c| is_arabic_letter(*c) && *c != 'ـ').collect::<String>())
                .filter(|w| w.chars().count() >= 2)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|p| !p.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("-"))
}

/// The family number has a fixed shape (digits with a few Latin letters, e.g. "1234A5B67890123456"):
/// found by that shape on any line when its label was misread.
fn family_number_by_shape(lines: &[Line], result: &mut ReadResult) {
    if result.get("family_no").is_some() {
        return;
    }
    let found = lines.iter().filter(|l| !l.text.contains('<')).find_map(|l| {
        tokens(&ascii_digits(&l.text)).into_iter().map(|w| w.to_uppercase()).find(|w| {
            let digits = w.chars().filter(char::is_ascii_digit).count();
            let letters = w.chars().filter(char::is_ascii_uppercase).count();
            (14..=22).contains(&w.len()) && w.chars().all(|c| c.is_ascii_alphanumeric()) && digits >= 10 && (1..=4).contains(&letters)
        }).map(|w| (w, l.confidence))
    });
    if let Some((value, confidence)) = found {
        result.set("family_no", value, confidence * 0.9, "text");
    }
}

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

// ---------------------------------------------------------------------------------------------
// Electronic ration card

fn is_ration_card(lines: &[Line]) -> bool {
    lines.iter().any(|l| has_label(&l.text, "البطاقة التموينية") || has_label(&l.text, "رقم البطاقة التموينية"))
}

/// Card number (printed under its label, and in the QR code) and the head of household's name.
fn parse_ration(lines: &[Line], codes: &[String], result: &mut ReadResult) {
    let printed = lines
        .iter()
        .position(|l| has_label(&l.text, "رقم البطاقة"))
        .and_then(|i| lines[i + 1..].iter().take(3).find_map(|l| {
            let digits = ascii_digits(&l.text).replace(' ', "");
            (digits.len() >= 6 && digits.chars().all(|c| c.is_ascii_digit())).then(|| (digits, l.confidence))
        }));
    let qr = codes.iter().find(|c| c.len() >= 6 && c.chars().all(|ch| ch.is_ascii_digit()));
    match (printed, qr) {
        (Some((p, _)), Some(q)) if &p == q => result.set("ration_no", p, 0.99, "qr"),
        (_, Some(q)) => result.set("ration_no", q.clone(), 0.97, "qr"),
        (Some((p, c)), None) => result.set("ration_no", p, c, "text"),
        (None, None) => {}
    }
    if let Some(i) = lines.iter().position(|l| has_label(&l.text, "اسم رب الاسره")) {
        // Below the label: the Kurdish label line, then the printed name.
        let name = lines[i + 1..].iter().take(4).find(|l| {
            let words = tokens(&l.text);
            !words.is_empty() && words.iter().all(|w| w.chars().all(is_arabic_letter)) && !words.iter().any(|w| is_kurdish_word(w) || matches!(normalize(w).as_str(), "سه" | "روكي" | "مالبات" | "سهروكي" | "ناوي"))
        });
        if let Some(line) = name {
            result.set("head_name", merge_single_letters(&arabic_only(&line.text)).join(" "), line.confidence, "text");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Residence card (old style): the serial is printed; the head of household, the address, the
// form number and the date are written by hand, so they are pointed out for typing, not guessed.

/// `label` anywhere in the line, with one misread letter allowed per five.
fn mentions(text: &str, label: &str) -> bool {
    let compact: Vec<char> = compact_arabic(text).chars().collect();
    let label: String = normalize(label).chars().filter(|c| is_arabic_letter(*c)).collect();
    let n = label.chars().count();
    let allowed = n / 5;
    compact.len() >= n.saturating_sub(allowed)
        && (0..=compact.len().saturating_sub(n)).any(|start| {
            let end = (start + n).min(compact.len());
            levenshtein(&compact[start..end].iter().collect::<String>(), &label) <= allowed
        })
}

const RESIDENCE_BACK: &[&str] = &["تنظيم الاستماره", "منظم الاستماره", "التسلسل"];
const RESIDENCE_FRONT: &[&str] = &["مكتب معلومات", "مكتب المعلومات", "عنوان السكن"];

fn is_residence_card(lines: &[Line]) -> bool {
    lines.iter().any(|l| RESIDENCE_BACK.iter().chain(RESIDENCE_FRONT).any(|label| mentions(&l.text, label)) || has_label(&l.text, "رقم الاستماره"))
}

fn parse_residence(lines: &[Line], result: &mut ReadResult) {
    let all_rows: Vec<Line> = rows(lines).into_iter().map(|(row, _)| row).collect();
    let find = |labels: &[&str]| all_rows.iter().position(|r| labels.iter().any(|label| mentions(&r.text, label)));
    let hand = |result: &mut ReadResult, key: &str, row: &Line| {
        if !result.handwritten.iter().any(|k| k == key) {
            result.handwritten.push(key.into());
            result.marks.push((key.into(), row.bbox));
        }
    };

    // Back: the printed serial, a number on its own row near «التسلسل».
    let serial_label = find(&["التسلسل"]);
    let digit_rows = all_rows.iter().filter_map(|r| {
        let digits: String = ascii_digits(&r.text).chars().filter(|c| !c.is_whitespace()).collect();
        (digits.len() >= 5 && digits.len() <= 12 && digits.chars().all(|c| c.is_ascii_digit())).then_some((digits, r))
    });
    let serial = match serial_label.map(|i| &all_rows[i]) {
        Some(label) => digit_rows
            .filter(|(_, r)| r.center_y() >= label.bbox[1] && r.center_y() <= label.bbox[3] + label.height() * 4.)
            .min_by(|a, b| a.1.center_y().total_cmp(&b.1.center_y())),
        None if find(RESIDENCE_BACK).is_some() => digit_rows.max_by(|a, b| a.1.confidence.total_cmp(&b.1.confidence)),
        None => None,
    };
    if let Some((digits, row)) = serial {
        result.set("doc_number", digits, row.confidence, "text");
    }
    if let Some(i) = find(&["تنظيم الاستماره"]) {
        hand(result, "issue_date", &all_rows[i]);
    }

    // Front: three handwritten rows. The address label is often misread, so its row is also
    // found between the other two.
    // Row-leading labels: matched at the start, so «منظم الاستمارة» is not «رقم الاستمارة».
    let leading = |label: &str| all_rows.iter().position(|r| has_label(&r.text, label));
    if let Some(i) = all_rows.iter().position(|r| ["مكتب معلومات", "مكتب المعلومات"].iter().any(|l| has_label(&r.text, l)) && !mentions(&r.text, "المركزي")) {
        hand(result, "info_office", &all_rows[i]);
    }
    let head = leading("اسم رب الاسره");
    let form = leading("رقم الاستماره");
    if let Some(i) = head {
        hand(result, "head_name", &all_rows[i]);
    }
    let address = leading("عنوان السكن").or(match (head, form) {
        (Some(h), Some(f)) if f == h + 2 => Some(h + 1),
        _ => None,
    });
    if let Some(i) = address {
        hand(result, "address", &all_rows[i]);
    }
    if let Some(i) = form {
        hand(result, "form_no", &all_rows[i]);
    }
    if !result.handwritten.is_empty() {
        let names: Vec<&str> = result.handwritten.iter().map(|k| match k.as_str() {
            "info_office" => "مكتب المعلومات",
            "head_name" => "اسم رب الأسرة",
            "address" => "العنوان",
            "form_no" => "رقم الاستمارة",
            _ => "تاريخ تنظيم الاستمارة",
        }).collect();
        result.warnings.push(format!("مكتوب بخط اليد ولا يُقرأ آليًا: {}. انقلها من الصورة.", names.join("، ")));
    }
}

// ---------------------------------------------------------------------------------------------
// Ministry of Transport ID badge: an English side and an Arabic side with the same fields.

fn is_ministry_badge(lines: &[Line]) -> bool {
    lines.iter().any(|l| {
        let lower = l.text.to_lowercase();
        lower.contains("ministry of transport") || has_label(&l.text, "وزارة النقل")
    })
}

/// English side: "Label : value" lines (the colon is often read as "8").
fn english_badge_field(text: &str) -> Option<(&'static str, String)> {
    let letters: String = text.chars().take(14).filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    let key = if letters.starts_with("name") {
        "badge_name_latin"
    } else if letters.starts_with("off") || letters.starts_with("ofc") || letters.starts_with("ofi") {
        "department_latin"
    } else if letters.starts_with("job") {
        "job_title_latin"
    } else if letters.starts_with("idn") || letters.starts_with("id") && text.chars().any(|c| c.is_ascii_digit()) {
        "doc_number"
    } else if letters.starts_with("iss") || letters.starts_with("1ss") || letters.starts_with("lss") {
        "issue_date"
    } else if letters.starts_with("exp") {
        "expiry_date"
    } else {
        return None;
    };
    // The value starts after the separator; a misread colon is a lone "8" or ":"/";".
    let words: Vec<&str> = text.split_whitespace().collect();
    let start = words.iter().position(|w| matches!(*w, "8" | ":" | ";" | "%" | "&") || w.ends_with(':')).map(|i| i + 1).unwrap_or(1);
    Some((key, words.get(start..).unwrap_or_default().join(" ")))
}

const ARABIC_BADGE_LABELS: &[(&str, &str, usize)] = &[
    ("الاسم", "badge_name", 1),
    ("الدائره", "department", 1),
    ("العنوان الوظيفي", "job_title", 2),
    ("رقم الهويه", "doc_number", 2),
    ("تاريخ الاصدار", "issue_date", 2),
    ("تاريخ النفاذ", "expiry_date", 2),
];

fn parse_ministry_badge(lines: &[Line], result: &mut ReadResult) {
    for line in lines {
        if !line.text.chars().any(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        let Some((key, value)) = english_badge_field(&line.text) else { continue };
        match key {
            "issue_date" | "expiry_date" => {
                if let Some(date) = find_date(&value) {
                    result.set(key, date, line.confidence, "text");
                }
            }
            "doc_number" => {
                let digits: String = ascii_digits(&value).chars().filter(char::is_ascii_digit).collect();
                if digits.len() >= 5 {
                    result.set(key, digits, line.confidence, "text");
                }
            }
            _ => result.set(key, value.trim().to_owned(), line.confidence, "text"),
        }
    }
    for (row, _) in rows(lines) {
        let Some((_, key, label_words)) = ARABIC_BADGE_LABELS.iter().find(|(label, _, _)| has_label(&row.text, label)) else { continue };
        // The signature block at the bottom ("الدائرة الإدارية…") repeats a label: the first wins.
        if *key == "department" && result.get("department").is_some() {
            continue;
        }
        let rest: Vec<String> = tokens(&row.text).into_iter().skip(*label_words).collect();
        let rest = rest.join(" ");
        match *key {
            "issue_date" | "expiry_date" => {
                if let Some(date) = find_date(&rest) {
                    result.set(key, date, row.confidence, "text");
                }
            }
            "doc_number" => {
                let digits: String = ascii_digits(&rest).chars().filter(char::is_ascii_digit).collect();
                if digits.len() >= 5 {
                    result.set(key, digits, row.confidence, "text");
                }
            }
            "badge_name" => {
                let words = merge_single_letters(&arabic_only(&rest));
                for (part, word) in ["first", "father", "grandfather", "surname"].iter().zip(words.iter()) {
                    result.set(part, word.clone(), row.confidence * if words.len() <= 4 { 1. } else { 0.6 }, "text");
                }
            }
            _ => {
                let value = merge_single_letters(&arabic_only(&rest)).join(" ");
                result.set(key, value, row.confidence, "text");
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Baghdad International Airport badge. Front: names, company, expiry, zone codes. Back: ID number,
// issue date, job title, and a QR code whose content is encoded (not readable as text).

fn compact_arabic(text: &str) -> String { normalize(text).chars().filter(|c| is_arabic_letter(*c)).collect() }

fn is_airport_badge(lines: &[Line]) -> bool {
    let has = |f: &dyn Fn(&Line) -> bool| lines.iter().any(f);
    has(&|l| compact_arabic(&l.text).contains("مطاربغداد"))
        || has(&|l| { let t = l.text.to_lowercase(); t.contains("airport") || t.trim() == "bgw" })
        || (has(&|l| l.text.to_lowercase().replace(' ', "").starts_with("idno")) && has(&|l| compact_arabic(&l.text).contains("حاملالهويه")))
}

/// One access-zone code as printed at the bottom of the airport badge front ("S1", "T", "VIP", "C"),
/// with the usual OCR confusions repaired ("SI"/"Sl" → "S1").
fn zone_code(token: &str) -> Option<String> {
    let t: String = token.trim().to_uppercase();
    if t.is_empty() || t.len() > 4 || !t.chars().all(|c| c.is_ascii_alphanumeric()) { return None; }
    if !t.chars().next()?.is_ascii_alphabetic() { return None; }
    let mut chars: Vec<char> = t.chars().collect();
    // A letter followed by digits: I/L/O read for 1/1/0 after the first letter.
    if chars.len() == 2 { chars[1] = match chars[1] { 'I' | 'L' => '1', 'O' => '0', c => c }; }
    let t: String = chars.into_iter().collect();
    // Up to three letters, then up to two digits.
    let letters = t.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    if letters > 3 || t.len() - letters > 2 || !t[letters..].chars().all(|c| c.is_ascii_digit()) { return None; }
    if ["BGW", "ID", "NO"].contains(&t.as_str()) { return None; }
    Some(t)
}

fn known_zone(z: &str) -> bool {
    ["T", "VIP", "C"].contains(&z) || (z.len() == 2 && z.starts_with('S') && z.as_bytes()[1].is_ascii_digit())
}

/// Access zones: a row of short Latin codes below the company line (or in the bottom third
/// of the card when the company line was not read).
fn airport_zones(all_rows: &[Line], result: &mut ReadResult) {
    let start = all_rows.iter().position(|r| compact_arabic(&r.text).starts_with("شركه")).map(|i| i + 1);
    let top = all_rows.iter().map(|r| r.bbox[1]).fold(f32::MAX, f32::min);
    let bottom = all_rows.iter().map(|r| r.bbox[3]).fold(f32::MIN, f32::max);
    let candidates: Vec<&Line> = match start {
        Some(i) => all_rows[i..].iter().collect(),
        None => all_rows.iter().filter(|r| r.bbox[1] >= top + (bottom - top) * 0.66).collect(),
    };
    let mut zones: Vec<String> = Vec::new();
    let mut confidence = 1f32;
    for row in candidates {
        let lower = row.text.to_lowercase();
        if row.text.chars().any(is_arabic_letter) || lower.contains("expire") || find_date(&row.text).is_some() { continue; }
        let tokens: Vec<&str> = row.text.split(|c: char| c.is_whitespace() || ",|/-·•.".contains(c)).filter(|t| !t.is_empty()).collect();
        let codes: Vec<String> = tokens.iter().filter_map(|t| zone_code(t)).collect();
        // Every token must be a code and one of them a known one, so a Latin name or
        // company line ("ABC CO") is not taken for zones.
        if codes.is_empty() || codes.len() != tokens.len() || !codes.iter().any(|c| known_zone(c)) { continue; }
        for code in codes {
            if !zones.contains(&code) { zones.push(code); }
        }
        confidence = confidence.min(row.confidence);
    }
    if zones.is_empty() { return; }
    // Codes outside the known set are offered at low confidence for review.
    if !zones.iter().all(|z| known_zone(z)) { confidence = confidence.min(0.7); }
    result.set("zones", zones.join(","), confidence, "text");
}

/// A date whose digits may be misread as letters ("O8-O6-2O28", "0B-06-2028"): letters
/// inside mostly-digit tokens are mapped back before looking for the date.
fn loose_date(text: &str) -> Option<String> {
    find_date(text).or_else(|| {
        let fixed: Vec<String> = ascii_digits(text).split_whitespace().map(|token| {
            let digits = token.chars().filter(char::is_ascii_digit).count();
            if digits >= 4 && digits * 2 >= token.chars().filter(char::is_ascii_alphanumeric).count() {
                token.chars().map(|c| match c { 'O' | 'o' | 'D' | 'Q' => '0', 'B' => '8', 'I' | 'l' | '|' => '1', 'S' | 's' => '5', 'Z' | 'z' => '2', c => c }).collect()
            } else {
                token.to_owned()
            }
        }).collect();
        find_date(&fixed.join(" "))
    })
}

/// The expiry date when its row did not carry it: the value printed beside the
/// "Expire Date / تاريخ الانتهاء" labels can sit a little higher or lower than them, and on
/// large photos it then forms a row of its own.
fn airport_expiry_fallback(lines: &[Line], result: &mut ReadResult) {
    if result.get("expiry_date").is_some() { return; }
    let is_label = |l: &Line| l.text.to_lowercase().contains("expire") || compact_arabic(&l.text).contains("الانتهاء");
    let issue_label = |l: &Line| l.text.to_lowercase().contains("issue") || compact_arabic(&l.text).contains("الاصدار");
    let labels: Vec<&Line> = lines.iter().filter(|l| is_label(l)).collect();
    if labels.is_empty() { return; }
    let issue = result.get("issue_date").map(|f| f.value.clone());
    let near = lines.iter()
        .filter(|l| !issue_label(l))
        .filter_map(|l| {
            let distance = labels.iter().map(|label| (l.center_y() - label.center_y()).abs() / label.height().max(1.)).fold(f32::MAX, f32::min);
            (distance < 2.5).then_some((l, distance))
        })
        .filter_map(|(l, distance)| loose_date(&l.text).filter(|d| Some(d) != issue.as_ref()).map(|d| (d, l.confidence, distance)))
        .min_by(|a, b| a.2.total_cmp(&b.2));
    if let Some((date, confidence, _)) = near {
        result.set("expiry_date", date, confidence.min(0.8), "text");
    }
}

fn parse_airport_badge(lines: &[Line], result: &mut ReadResult) {
    let all_rows: Vec<Line> = rows(lines).into_iter().map(|(row, _)| row).collect();
    airport_zones(&all_rows, result);
    let arabic_row = |r: &Line| r.text.chars().any(is_arabic_letter) && !r.text.chars().any(|c| c.is_ascii_alphanumeric());
    for (i, row) in all_rows.iter().enumerate() {
        let lower = row.text.to_lowercase();
        let compact = compact_arabic(&row.text);
        if lower.contains("expire") || compact.contains("الانتهاء") {
            if let Some(date) = find_date(&row.text) {
                result.set("expiry_date", date, row.confidence, "text");
            }
        }
        if lower.contains("issue") || compact.contains("الاصدار") {
            if let Some(date) = find_date(&row.text) {
                result.set("issue_date", date, row.confidence, "text");
            }
            // The job title is printed under the issue date.
            if let Some(next) = all_rows[i + 1..].iter().take(2).find(|r| arabic_row(r) && !compact_arabic(&r.text).starts_with("يلتزم")) {
                result.set("job_title", merge_single_letters(&arabic_only(&next.text)).join(" "), next.confidence, "text");
            }
        }
        if lower.replace(' ', "").starts_with("idno") || lower.contains("id no") {
            let id = row.text.split(|c: char| !c.is_ascii_alphanumeric()).map(str::to_uppercase).filter(|t| t.chars().filter(char::is_ascii_digit).count() >= 6).max_by_key(String::len);
            if let Some(mut id) = id {
                // "ID No.A2026…" glued: drop the label letters.
                if id.starts_with("NO") { id = id[2..].to_owned(); }
                result.set("doc_number", id, row.confidence, "text");
            }
        }
        if compact.starts_with("شركه") {
            result.set("company", merge_single_letters(&arabic_only(&row.text)).join(" "), row.confidence, "text");
            // The Arabic name is the Arabic row above the company (the Latin name sits between).
            if let Some(name_row) = all_rows[..i].iter().rev().take(4).find(|r| arabic_row(r) && !compact_arabic(&r.text).contains("مطار")) {
                let words = merge_single_letters(&arabic_only(&name_row.text));
                let confidence = name_row.confidence * if (3..=4).contains(&words.len()) { 1. } else { 0.6 };
                for (part, word) in ["first", "father", "grandfather", "surname"].iter().zip(words.iter()) {
                    result.set(part, word.clone(), confidence, "text");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Car registration (السنوية: «إجازة تسجيل مركبة», Vehicle Registration Licence)
//
// Fields carry the EU-style codes printed beside them. Front: A. plate, B. first registration,
// I. issue, H. expiry, and a bottom line "V<" + licence number + fillers + check digit.
// Back: D.1 brand, D.3 type, R colour, 11 year of production, each in a table cell right of
// its code.

fn is_vehicle_registration(lines: &[Line]) -> bool {
    // The back is a table of field codes; its printed legend is often unreadable.
    let codes = lines.iter()
        .filter_map(|l| vehicle_code(&l.text))
        .filter(|c| ["D.1", "D.3", "E", "P.5", "R", "A.12", "A.13", "F.1", "F.2", "S.1./S.2", "P.2", "P.3"].contains(&c.as_str()))
        .collect::<std::collections::HashSet<_>>()
        .len();
    if codes >= 4 { return true; }
    lines.iter().any(|l| {
        let lower = l.text.to_lowercase();
        lower.contains("vehicle registration") || lower.contains("vehicle brand") || lower.contains("chassis number")
            || compact_arabic(&l.text).contains("اجازهتسجيلمركبه")
    })
}

/// "V<X1234567<<<…<N": the licence number, and whether the check digit (over everything
/// before it) holds.
fn vehicle_licence_line(text: &str) -> Option<(String, bool)> {
    let line: String = ascii_digits(text).to_uppercase().chars().filter(|c| !c.is_whitespace()).collect();
    if !line.starts_with("V<") || line.len() < 20 { return None; }
    let (body, check) = line.split_at(line.len() - 1);
    let number: String = body[2..].chars().take_while(|c| *c != '<').collect();
    if number.len() < 6 || !number.chars().all(|c| c.is_ascii_alphanumeric()) { return None; }
    let check = check.chars().next()?;
    if check_digit(body) == check { return Some((number, true)); }
    // Repair digit confusions after the leading letter, as on MRZ lines.
    let mut fixed: String = number.chars().take(1).collect();
    fixed.extend(number.chars().skip(1).map(to_digit));
    let repaired = format!("V<{}{}", fixed, &body[2 + number.len()..]);
    Some(if check_digit(&repaired) == check { (fixed, true) } else { (number, false) })
}

/// Plate categories printed after the plate («خصوصي», «أجرة», …), compared after `normalize`.
const PLATE_CATEGORIES: &[&str] = &["خصوصي", "اجره", "تكسي", "حمل", "حكومي", "نقل", "دراجه", "زراعي", "انشائي", "مؤقت", "تصدير", "فحص"];

/// Governorate codes on the newer Latin-letter plates.
const GOVERNORATE_CODES: &[(&str, &str)] = &[
    ("11", "بغداد"), ("12", "نينوى"), ("13", "ميسان"), ("14", "البصرة"), ("15", "الأنبار"),
    ("16", "القادسية"), ("17", "المثنى"), ("18", "بابل"), ("19", "كربلاء"), ("20", "ديالى"),
    ("21", "ذي قار"), ("22", "كركوك"), ("23", "واسط"), ("24", "صلاح الدين"), ("25", "النجف"),
];

/// Governorate names as written on the older plates, compared after `normalize`.
const GOVERNORATE_NAMES: &[&str] = &[
    "بغداد", "نينوى", "ميسان", "البصرة", "الأنبار", "القادسية", "المثنى", "بابل", "كربلاء", "ديالى",
    "ذي قار", "كركوك", "واسط", "صلاح الدين", "النجف", "أربيل", "دهوك", "السليمانية", "حلبجة",
];

struct Plate { number: String, governorate: Option<String>, governorate_from_code: bool, category: Option<String> }

/// The plate line, in either format:
/// * Latin letter: governorate code, letter with number, category ("12 A34567 خصوصي");
/// * Arabic letter: number with a letter, governorate name, category ("12345 أ بغداد خصوصي",
///   in Arabic-Indic digits on the card).
fn vehicle_plate(text: &str) -> Option<Plate> {
    let text = ascii_digits(text);
    let mut tokens: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
    // "12345ب": digits glued to the plate letter.
    tokens = tokens.into_iter().flat_map(|t| {
        let split = t.find(|c: char| is_arabic_letter(c));
        match split {
            Some(i) if i > 0 && t[..i].chars().all(|c| c.is_ascii_digit()) => vec![t[..i].to_owned(), t[i..].to_owned()],
            _ => vec![t],
        }
    }).collect();
    let category = tokens.iter().find(|t| PLATE_CATEGORIES.iter().any(|c| normalize(t) == normalize(c))).cloned();
    let joined = normalize(&tokens.join(" "));
    let governorate_name = GOVERNORATE_NAMES.iter().find(|g| joined.contains(&normalize(g))).map(|g| g.to_string());
    // Latin format.
    if let Some(pos) = tokens.iter().position(|t| {
        let letters = t.chars().filter(|c| c.is_ascii_uppercase()).count();
        (1..=2).contains(&letters) && t.chars().filter(char::is_ascii_digit).count() >= 4 && t.chars().all(|c| c.is_ascii_alphanumeric())
    }) {
        let token = &tokens[pos];
        let split = token.find(|c: char| c.is_ascii_uppercase()).unwrap_or(0);
        let (glued, number) = token.split_at(split);
        // The code is printed before the letter, but the reader may glue it on, or put it
        // after the number when it reorders the line.
        let short_digits = |t: &&String| (1..=2).contains(&t.len()) && t.chars().all(|c| c.is_ascii_digit());
        let code = if !glued.is_empty() { Some(glued.to_owned()) } else {
            tokens[..pos].iter().rev().find(short_digits).or_else(|| tokens[pos + 1..].iter().find(short_digits)).cloned()
        };
        let from_code = code.as_deref().and_then(|c| GOVERNORATE_CODES.iter().find(|(k, _)| *k == c)).map(|(_, name)| name.to_string());
        let number = match &code { Some(c) => format!("{c} {number}"), None => number.to_owned() };
        return Some(Plate { number, governorate: governorate_name.clone().or(from_code.clone()), governorate_from_code: governorate_name.is_none() && from_code.is_some(), category });
    }
    // Arabic format: the number (4 digits or more) and the letter after it.
    let pos = tokens.iter().position(|t| t.len() >= 4 && t.chars().all(|c| c.is_ascii_digit()))?;
    if category.is_none() && governorate_name.is_none() { return None; }
    let letter = tokens.get(pos + 1).filter(|t| t.chars().count() <= 2 && t.chars().all(is_arabic_letter));
    let number = match letter { Some(l) => format!("{} {}", tokens[pos], l), None => tokens[pos].clone() };
    Some(Plate { number, governorate: governorate_name, governorate_from_code: false, category })
}

/// A table code such as "D.1." or "R." on its own (a label cell, not a value).
fn vehicle_code(text: &str) -> Option<String> {
    let t: String = text.trim().to_uppercase().chars().filter(|c| !c.is_whitespace()).collect();
    let t = t.trim_end_matches('.');
    let ok = !t.is_empty() && t.len() <= 9
        && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '/')
        && t.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && !t.chars().all(|c| c.is_ascii_digit() && t.len() > 2);
    ok.then(|| t.to_owned())
}

/// The value cell right of a label cell on the same table row.
fn cell_right_of<'a>(lines: &'a [Line], label: &Line) -> Option<&'a Line> {
    lines.iter()
        .filter(|l| !std::ptr::eq(*l, label))
        .filter(|l| (l.center_y() - label.center_y()).abs() < label.height().max(l.height()) * 0.7)
        .filter(|l| l.bbox[0] >= label.bbox[2] - 2.)
        .min_by(|a, b| a.bbox[0].total_cmp(&b.bbox[0]))
}

fn parse_vehicle_registration(lines: &[Line], result: &mut ReadResult) {
    // Front.
    let mut dates: Vec<(String, f32)> = Vec::new();
    let mut governorate_from_code: Option<String> = None;
    let mut plate_line: Option<&Line> = None;
    for line in lines {
        if let Some((number, verified)) = vehicle_licence_line(&line.text) {
            if verified {
                result.set("annual_no", number, 0.99, "mrz");
            } else {
                result.set("annual_no", number, line.confidence.min(0.6), "text");
            }
            continue;
        }
        if line.text.contains('<') { continue; }
        if let Some(date) = find_date(&line.text) {
            // B. is the first registration, not this licence.
            if !line.text.trim_start().to_uppercase().starts_with('B') {
                dates.push((date, line.confidence));
            }
            continue;
        }
        // The owner's address (C.1.3) also has a governorate and numbers.
        if line.text.chars().any(is_arabic_letter) && result.get("plate").is_none() && !line.text.to_uppercase().contains("C.1") {
            if let Some(mut plate) = vehicle_plate(&line.text) {
                // The code may be detected as a line of its own beside the plate.
                let latin = plate.number.chars().next().is_some_and(|c| c.is_ascii_uppercase());
                if latin && plate.governorate.is_none() {
                    let code = lines.iter()
                        .filter(|l| !std::ptr::eq(*l, line))
                        .filter(|l| (l.center_y() - line.center_y()).abs() < line.height().max(l.height()) * 0.7)
                        .map(|l| ascii_digits(&l.text).trim().trim_end_matches('.').to_owned())
                        .find(|t| t.len() == 2 && t.chars().all(|c| c.is_ascii_digit()));
                    if let Some(code) = code {
                        plate.governorate = GOVERNORATE_CODES.iter().find(|(k, _)| *k == code).map(|(_, name)| name.to_string());
                        plate.governorate_from_code = plate.governorate.is_some();
                        plate.number = format!("{code} {}", plate.number);
                    }
                }
                plate_line = Some(line);
                // Plate digits and letters are easily misread: always reviewed.
                result.set("plate", plate.number, line.confidence.min(0.7), "text");
                if let Some(governorate) = plate.governorate {
                    // A name written on the plate is used as read; one from the code table is
                    // set after the loop, for review.
                    if plate.governorate_from_code {
                        governorate_from_code = Some(governorate);
                    } else {
                        result.set("governorate", governorate, line.confidence.min(0.9), "text");
                    }
                }
                if let Some(category) = plate.category {
                    result.set("plate_category", category, line.confidence.min(0.9), "text");
                }
            }
        }
    }
    dates.sort_by(|a, b| a.0.cmp(&b.0));
    dates.dedup_by(|a, b| a.0 == b.0);
    // From the plate code (unconfirmed table), then the owner's address (C.1.3): both reviewed.
    if result.get("governorate").is_none() {
        if let Some(name) = governorate_from_code {
            result.set("governorate", name, 0.6, "text");
        }
    }
    if result.get("plate").is_some() && result.get("governorate").is_none() {
        // The address line, labelled C.1.3; its label is often detected apart from it, so
        // otherwise any other line naming a governorate (the card's titles name none).
        let governorate_in = |l: &Line| {
            let text = normalize(&l.text);
            GOVERNORATE_NAMES.iter().find(|g| text.contains(&normalize(g))).map(|g| (g.to_string(), l.confidence))
        };
        let others = || lines.iter().filter(|l| !plate_line.is_some_and(|p| std::ptr::eq(p, *l)));
        let address = others().filter(|l| l.text.to_uppercase().contains("C.1.3")).find_map(governorate_in)
            .or_else(|| others().find_map(governorate_in));
        if let Some((name, confidence)) = address {
            // Where the owner lives need not be where the car is registered: reviewed.
            result.set("governorate", name, confidence.min(0.5), "text");
        }
    }
    if dates.len() >= 2 {
        let (issue, expiry) = (&dates[0], &dates[dates.len() - 1]);
        result.set("issue_date", issue.0.clone(), issue.1.min(0.9), "text");
        result.set("expiry_date", expiry.0.clone(), expiry.1.min(0.9), "text");
    } else if let Some((date, confidence)) = dates.first() {
        result.set("expiry_date", date.clone(), confidence.min(0.6), "text");
    }
    // Back.
    for label in lines {
        let Some(code) = vehicle_code(&label.text) else { continue };
        let key = match code.as_str() { "D.1" => "brand", "D.3" => "vehicle_type", "R" => "color", "11" => "year", "E" => "chassis_no", _ => continue };
        let Some(cell) = cell_right_of(lines, label) else { continue };
        if vehicle_code(&cell.text).is_some() && key != "year" { continue; }
        let value = cell.text.trim().to_owned();
        let valid = match key {
            "year" => value.len() == 4 && value.chars().all(|c| c.is_ascii_digit()),
            "chassis_no" => (11..=17).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric()),
            _ => value.chars().any(is_arabic_letter) || value.chars().any(|c| c.is_ascii_alphabetic()),
        };
        if valid {
            result.set(key, value, cell.confidence, "text");
        }
    }
    // The chassis number is often printed again under P.5: agreeing copies are verified,
    // differing ones are reviewed.
    let cabinet = lines.iter()
        .filter(|l| vehicle_code(&l.text).as_deref() == Some("P.5"))
        .find_map(|label| cell_right_of(lines, label))
        .map(|cell| cell.text.trim().to_owned());
    let valid_vin = |v: &str| (11..=17).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphanumeric());
    // E. misread (for example a "$" for a 5): the P.5 copy stands in, for review.
    if result.get("chassis_no").is_none() {
        if let Some(cabinet) = cabinet.as_deref().filter(|c| valid_vin(c)) {
            result.set("chassis_no", cabinet.to_owned(), 0.7, "text");
        }
        return;
    }
    if let (Some(chassis), Some(cabinet)) = (result.get("chassis_no").map(|f| f.value.clone()), cabinet) {
        if cabinet.len() == chassis.len() {
            if cabinet == chassis {
                result.set("chassis_no", chassis, 0.99, "both");
            } else if let Some(field) = result.fields.iter_mut().find(|f| f.key == "chassis_no") {
                field.confidence = field.confidence.min(0.6);
            }
        }
    }
}

#[cfg(test)]
pub fn parse(lines: &[Line]) -> ReadResult {
    parse_with_codes(lines, &[])
}

/// `codes` are the contents of QR codes found on the image.
pub fn parse_with_codes(raw_lines: &[Line], codes: &[String]) -> ReadResult {
    let spaced = with_breaks(raw_lines);
    let lines = spaced.as_slice();
    let mut result = ReadResult::default();
    if is_ration_card(lines) {
        parse_ration(lines, codes, &mut result);
        result.document = "ration".into();
        if result.fields.is_empty() {
            result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
        }
        return result;
    }
    if is_airport_badge(lines) {
        parse_airport_badge(lines, &mut result);
        airport_expiry_fallback(lines, &mut result);
        result.document = "airport_badge".into();
        if result.fields.is_empty() {
            result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
        }
        return result;
    }
    if is_ministry_badge(lines) {
        parse_ministry_badge(lines, &mut result);
        result.document = "ministry_badge".into();
        if result.fields.is_empty() {
            result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
        }
        return result;
    }
    if is_vehicle_registration(lines) {
        parse_vehicle_registration(lines, &mut result);
        result.document = "vehicle_registration".into();
        if result.fields.is_empty() {
            result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
        }
        return result;
    }
    let mrz = parse_mrz(lines, &mut result);
    if mrz.is_none() && is_residence_card(lines) {
        parse_residence(lines, &mut result);
        result.document = "residence".into();
        if result.fields.is_empty() && result.handwritten.is_empty() {
            result.warnings.push("لم يُعثر على بيانات مقروءة في الصورة".into());
        }
        return result;
    }
    if mrz == Some("td3") {
        parse_passport_text(lines, &mut result);
        result.document = "passport".into();
    } else {
        let back = parse_back(raw_lines, &mut result) || mrz == Some("td1");
        if back {
            family_number_by_shape(lines, &mut result);
        }
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
    fn ration_card_number_and_head_of_household() {
        let lines = vec![
            line("البطاقة التموينية الالكترونية", 0.),
            line("رقم البطاقة التموينية ازمارهى كارتي خوراك", 20.),
            line("0100000001", 40.),
            line("اسم رب الأسرة", 60.),
            line("ناوى سه روكى مالبات", 80.),
            line("أحمد علي حسين كاظم", 100.),
            line("1000000000001", 140.),
        ];
        let r = parse_with_codes(&lines, &["0100000001".to_string()]);
        assert_eq!(r.document, "ration");
        assert_eq!(r.get("ration_no").unwrap().value, "0100000001");
        assert_eq!(r.get("ration_no").unwrap().source, "qr");
        assert_eq!(r.get("head_name").unwrap().value, "أحمد علي حسين كاظم");
        // The long number under the QR code is not taken for the card number.
        assert!(r.fields.iter().all(|f| f.value != "1000000000001"));
        // Without the QR code the printed number is used.
        let r = parse(&lines);
        assert_eq!(r.get("ration_no").unwrap().source, "text");
    }

    fn boxed_at(text: &str, x: f32, y: f32) -> Line { Line { text: text.into(), confidence: 0.95, bbox: [x, y, x + 40., y + 10.] } }

    #[test]
    fn rows_read_arabic_right_to_left_and_latin_left_to_right() {
        let latin = vec![boxed_at("VIP", 200., 0.), boxed_at("S1", 0., 0.), boxed_at("T", 100., 0.)];
        assert_eq!(rows(&latin)[0].0.text, "S1 T VIP");
        let arabic = vec![boxed_at("حسن", 100., 0.), boxed_at("علي", 200., 0.)];
        assert_eq!(rows(&arabic)[0].0.text, "علي حسن");
        // Zone codes, C included, as printed.
        let mut r = ReadResult::default();
        airport_zones(&[line("Airport", 0.), line("S1 T VIP C", 100.)], &mut r);
        assert_eq!(r.get("zones").unwrap().value, "S1,T,VIP,C");
    }

    #[test]
    fn residence_card_back_reads_the_printed_serial_only() {
        let lines = vec![
            line("نموذج ٣", 0.),
            line("التسلسل", 40.),
            line("١٢٣٤٥٦٧", 55.),
            line("تاريخ تنظيم الاستمارة ٢٠ و", 130.),
            line("اسم ورتبة منظم الاستمارة", 160.),
        ];
        let r = parse(&lines);
        assert_eq!(r.document, "residence");
        assert_eq!(r.get("doc_number").unwrap().value, "1234567");
        // The handwritten date is pointed out, not guessed.
        assert!(r.get("issue_date").is_none());
        assert_eq!(r.handwritten, vec!["issue_date"]);
        assert!(!r.handwritten.iter().any(|k| k == "form_no"));
    }

    #[test]
    fn residence_card_front_points_out_handwritten_fields() {
        let lines = vec![
            line("وزارة الداخلية", -20.),
            line("مديرية مكتب المعلومات المركزي", 0.),
            line("مكتب معلومات", 20.),
            line("اسم رب الاسرة عصاتم ص ه اشم", 40.),
            line("عنون السكن م ٩ ز د", 60.),
            line("رقم الاستمارة ٥٦١", 80.),
        ];
        let r = parse(&lines);
        assert_eq!(r.document, "residence");
        assert!(r.fields.is_empty());
        assert_eq!(r.handwritten, vec!["info_office", "head_name", "address", "form_no"]);
        assert!(r.warnings.iter().any(|w| w.contains("بخط اليد")));
        // Each is located at its label's row, for zooming the card.
        let at: std::collections::HashMap<_, _> = locate(&r, &lines).into_iter().collect();
        assert_eq!(at["address"][1], 60.);
        assert_eq!(at["info_office"][1], 20.);
        // A misread address label is found between the other two rows.
        let mut misread = lines.clone();
        misread[4].text = "وان الكن ٩ ح ز".into();
        assert_eq!(parse(&misread).handwritten, vec!["info_office", "head_name", "address", "form_no"]);
    }

    #[test]
    fn ministry_badge_both_sides() {
        let english = vec![
            line("Ministry of Transport", 0.),
            line("Name 8 Ahmed Ali Hussein", 20.),
            line("Ofce 8 Test Dep.", 40.),
            line("Job Title 8 Engineer", 60.),
            line("IDN0 8 100000001", 80.),
            line("1SS Date 8 01/02/2022", 100.),
            line("ExP. Date 8 01/02/2027", 120.),
        ];
        let r = parse(&english);
        assert_eq!(r.document, "ministry_badge");
        let v = |r: &ReadResult, k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        assert_eq!(v(&r, "doc_number"), "100000001");
        assert_eq!(v(&r, "issue_date"), "2022-02-01");
        assert_eq!(v(&r, "expiry_date"), "2027-02-01");
        assert_eq!(v(&r, "badge_name_latin"), "Ahmed Ali Hussein");
        let arabic = vec![
            line("وزارة النقل", 0.),
            line("الأسم أحمد علي حسين", 20.),
            line("الدائرة قسم الاختبار", 40.),
            line("العنوان الوظيفي مهندس أقدم", 60.),
            line("الدائرة الإدارية", 140.),
            line("رقم الهوية 100000001", 80.),
            line("تاريخ الأصدارة 2022/02/01", 100.),
            line("تاريخ النفاذة 2027/02/01", 120.),
        ];
        let r = parse(&arabic);
        assert_eq!(r.document, "ministry_badge");
        assert_eq!(v(&r, "first"), "أحمد");
        assert_eq!(v(&r, "grandfather"), "حسين");
        assert_eq!(v(&r, "department"), "قسم الاختبار");
        assert_eq!(v(&r, "job_title"), "مهندس أقدم");
        assert_eq!(v(&r, "doc_number"), "100000001");
        assert_eq!(v(&r, "issue_date"), "2022-02-01");
        assert_eq!(v(&r, "expiry_date"), "2027-02-01");
    }

    #[test]
    fn airport_badge_front_and_back() {
        let v = |r: &ReadResult, k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        let front = vec![
            line("BGW", 0.),
            line("مطار بغداد الدولي", 20.),
            line("أحمد علي حسين", 40.),
            line("AHMED ALI HUSSEIN", 60.),
            line("شركة الاختبار", 80.),
            line("Expire Date 01-02-2028 تاريخ الانتهاء", 100.),
        ];
        let r = parse(&front);
        assert_eq!(r.document, "airport_badge");
        assert_eq!(v(&r, "expiry_date"), "2028-02-01");
        assert_eq!(v(&r, "first"), "أحمد");
        assert_eq!(v(&r, "grandfather"), "حسين");
        assert_eq!(v(&r, "zones"), "", "no zone row on this front");
        let mut with_zones = front.clone();
        with_zones.push(line("SI  T  VIP  C", 120.));
        with_zones.push(line("ABC CO", 130.));
        let r = parse(&with_zones);
        assert_eq!(v(&r, "zones"), "S1,T,VIP,C");
        // Large photo: the date is a little below its labels and forms a row of its own,
        // with a digit read as a letter.
        let mut split = front.clone();
        split.retain(|l| !l.text.starts_with("Expire"));
        split.push(line("Expire Date تاريخ الانتهاء", 100.));
        split.push(line("O1-02-2028", 112.));
        let rs = parse(&split);
        assert_eq!(v(&rs, "expiry_date"), "2028-02-01");
        assert!(rs.get("expiry_date").unwrap().confidence < 0.85);
        assert!(r.get("zones").unwrap().confidence >= 0.85);
        // An unfamiliar code next to known ones is kept, but marked for review.
        let mut odd = front.clone();
        odd.push(line("S2 VIP R", 120.));
        let r = parse(&odd);
        assert_eq!(v(&r, "zones"), "S2,VIP,R");
        assert!(r.get("zones").unwrap().confidence < 0.85);
        let back = vec![
            line("ID No. X100000001", 0.),
            line("تاريخ الاصدار : 2026-02-01 Date Issue", 20.),
            line("مهندس أقدم", 40.),
            line("يلتزم حامل الهوية بمعايير", 80.),
        ];
        let r = parse(&back);
        assert_eq!(r.document, "airport_badge");
        assert_eq!(v(&r, "doc_number"), "X100000001");
        assert_eq!(v(&r, "issue_date"), "2026-02-01");
        assert_eq!(v(&r, "job_title"), "مهندس أقدم");
    }

    #[test]
    fn vehicle_registration_front_and_back() {
        let v = |r: &ReadResult, k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        let at = |text: &str, x: f32, y: f32| Line { text: text.into(), confidence: 0.95, bbox: [x, y, x + 60., y + 20.] };
        // Synthetic licence number; the check digit is computed here.
        let body = format!("V<X12345678{}", "<".repeat(18));
        let check = check_digit(&body);
        let front = vec![
            at("Vehicle Registration Licence", 0., 0.),
            at("خصوصي 12A34567", 300., 100.),
            at("B. 01.02.2020", 600., 140.),
            at("1. 03.02.2025", 600., 300.),
            at("02.02.2030", 300., 340.),
            at(&format!("{body}{check}"), 0., 420.),
        ];
        let r = parse(&front);
        assert_eq!(r.document, "vehicle_registration");
        assert_eq!(v(&r, "annual_no"), "X12345678");
        assert_eq!(r.get("annual_no").unwrap().source, "mrz");
        assert_eq!(v(&r, "plate"), "12 A34567");
        assert_eq!(v(&r, "plate_category"), "خصوصي");
        assert_eq!(v(&r, "governorate"), "نينوى");
        assert!(r.get("governorate").unwrap().confidence < 0.85, "from the code table: reviewed");
        // Code lost by the reader: the owner's address names the governorate, for review.
        let mut lost = front.clone();
        lost[1] = at("خصوصي A34567", 300., 100.);
        lost.push(at("كربلاء المركز 3 C.1.3.", 300., 200.));
        let rl = parse(&lost);
        assert_eq!(v(&rl, "governorate"), "كربلاء");
        assert!(rl.get("governorate").unwrap().confidence < 0.85);
        // The address apart from its C.1.3 label.
        let mut apart = front.clone();
        apart[1] = at("خصوصي A34567", 300., 100.);
        apart.push(at("C.1.3.", 200., 200.));
        apart.push(at("كربلاء المركز 3", 300., 200.));
        assert_eq!(v(&parse(&apart), "governorate"), "كربلاء");
        // The code after the number (reordered), or detected as a line of its own.
        let mut after = front.clone();
        after[1] = at("خصوصي A34567 12", 300., 100.);
        let r2 = parse(&after);
        assert_eq!((v(&r2, "plate"), v(&r2, "governorate")), ("12 A34567".into(), "نينوى".into()));
        let mut own = front.clone();
        own[1] = at("خصوصي A34567", 300., 100.);
        own.push(at("12", 240., 102.));
        let r3 = parse(&own);
        assert_eq!((v(&r3, "plate"), v(&r3, "governorate")), ("12 A34567".into(), "نينوى".into()));
        // The plate code wins over the address (the owner may live elsewhere).
        let mut both = front.clone();
        both.push(at("كربلاء المركز 3 C.1.3.", 300., 200.));
        assert_eq!(v(&parse(&both), "governorate"), "نينوى");
        // Older plates: Arabic-Indic number glued to an Arabic letter, then the governorate.
        let mut arabic = front.clone();
        arabic[1] = at("٤٥٦٧٨ب كربلاء أجرة", 300., 100.);
        arabic.push(at("C.1.3. 1 2 بغداد الكرخ", 300., 200.));
        let ra = parse(&arabic);
        assert_eq!(v(&ra, "plate"), "45678 ب");
        assert_eq!(v(&ra, "governorate"), "كربلاء");
        assert_eq!(v(&ra, "plate_category"), "أجرة");
        assert!(r.get("plate").unwrap().confidence < 0.85);
        assert_eq!(v(&r, "issue_date"), "2025-02-03");
        assert_eq!(v(&r, "expiry_date"), "2030-02-02");
        // A wrong check digit is offered for review only.
        let wrong = char::from_digit((check.to_digit(10).unwrap() + 1) % 10, 10).unwrap();
        let mut bad = front.clone();
        bad.pop();
        bad.push(at(&format!("{body}{wrong}"), 0., 420.));
        assert!(parse(&bad).get("annual_no").unwrap().confidence < 0.85);

        let back = vec![
            at("D.1.", 0., 0.), at("تويوتا", 100., 2.), at("E.", 500., 0.), at("ABCDE1234567890XY", 600., 0.),
            at("P.5.", 0., 160.), at("ABCDE1234567890XY", 100., 160.),
            at("D.3.", 0., 40.), at("كامري", 100., 41.), at("11.", 500., 40.), at("2022", 600., 40.),
            at("R.", 0., 80.), at("أبيض", 100., 80.), at("13.", 500., 80.),
            at("18.", 0., 120.), at("19.", 300., 120.),
            at("D.1.Vehicle brand name E.Chassis number", 0., 200.),
        ];
        let r = parse(&back);
        assert_eq!(r.document, "vehicle_registration");
        assert_eq!(v(&r, "brand"), "تويوتا");
        assert_eq!(v(&r, "vehicle_type"), "كامري");
        assert_eq!(v(&r, "color"), "أبيض");
        assert_eq!(v(&r, "year"), "2022");
        assert_eq!(v(&r, "chassis_no"), "ABCDE1234567890XY");
        assert_eq!(r.get("chassis_no").unwrap().source, "both");
        // No readable legend, and the E. copy misread: still a registration, chassis from P.5.
        let mut bare = back.clone();
        bare.retain(|l| !l.text.contains("Vehicle"));
        bare[3] = at("ABCDE1234567890X$", 600., 0.);
        let rb = parse(&bare);
        assert_eq!(rb.document, "vehicle_registration");
        assert_eq!(v(&rb, "brand"), "تويوتا");
        assert_eq!(v(&rb, "chassis_no"), "ABCDE1234567890XY");
        assert!(rb.get("chassis_no").unwrap().confidence < 0.85);
    }

    #[test]
    fn blood_types() {
        assert_eq!(blood_type("AB+").as_deref(), Some("AB+"));
        assert_eq!(blood_type("+A").as_deref(), Some("A+"));
        assert_eq!(blood_type("0-").as_deref(), Some("O-"));
    }

    // Layout problems seen on real cards, reproduced with made-up values (no real person's data).

    fn boxed(text: &str, confidence: f32, bbox: [f32; 4]) -> Line { Line { text: text.into(), confidence, bbox } }

    #[test]
    fn place_of_birth_keeps_its_parts_however_the_dash_was_read() {
        let mark = SEP;
        for (text, expected) in [
            (format!("محل الولادة شوێنی لەدایک بوون الاعظمية{mark}رصافة{mark}بغداد"), "الاعظمية-رصافة-بغداد"),
            ("محل الولادة شوێنی لەدایک بوون الزبير – البصرة".to_owned(), "الزبير-البصرة"),
            ("محل الولادة شوێنی لەدایک بوون الحلة-بابل".to_owned(), "الحلة-بابل"),
            (format!("محل الولادة شوێنی لەدایک بوون{mark}الموصل{mark}نينوى"), "الموصل-نينوى"),
            ("محل الولادة شوێنی لەدایک بوون النجف".to_owned(), "النجف"),
        ] {
            let r = parse(&[line(&text, 0.)]);
            assert_eq!(r.get("birthplace").map(|f| f.value.as_str()), Some(expected), "{text}");
        }
    }

    #[test]
    fn family_number_is_found_by_its_shape_when_the_label_is_misread() {
        let (l1, l2) = td1();
        for (text, expected) in [
            ("الرقم ١ا لعانئلي ازمم اردى خبزانى :2003K1N13570022602", "2003K1N13570022602"),
            ("ژمارەی خێزانی 1500B2C9876543210", "1500B2C9876543210"),
        ] {
            let lines = vec![line("تاريخ النفاذ رۆژی بەسەرچوون 2030/12/31", 0.), line(text, 20.), line(&l1, 200.), line(&l2, 215.)];
            let r = parse(&lines);
            assert_eq!(r.get("family_no").map(|f| f.value.as_str()), Some(expected), "{text}");
            // The national number (12 digits) and the MRZ are never taken for it.
            assert_ne!(r.get("family_no").unwrap().value, "100000000001");
        }
    }

    #[test]
    fn a_separator_mark_breaks_words_but_not_after_a_lone_letter() {
        assert_eq!(break_at_marks(&format!("ناو{SEP}كريم")), "ناو كريم");
        assert_eq!(break_at_marks(&format!("ا{SEP}نازناو")), "انازناو");
        let r = parse(&[line(&format!("الاسم ناو{SEP}كريم"), 0.), line("الاب باوك سالم", 20.)]);
        assert_eq!(r.get("first").unwrap().value, "كريم");
    }

    #[test]
    fn a_clear_name_is_not_marked_unsure_because_of_its_kurdish_label() {
        // Label, Kurdish word and value are separate boxes on one row; the Kurdish box reads poorly.
        let lines = vec![
            boxed("الاسم", 0.98, [200., 0., 240., 10.]),
            boxed("ناو", 0.40, [150., 0., 190., 10.]),
            boxed("كريم", 0.97, [60., 0., 140., 10.]),
            boxed("اللقب", 0.98, [200., 40., 240., 50.]),
            boxed("نازناو", 0.45, [150., 40., 190., 50.]),
            boxed("الساعدي", 0.96, [60., 40., 140., 50.]),
        ];
        let r = parse(&lines);
        assert_eq!(r.get("first").unwrap().value, "كريم");
        assert!(r.get("first").unwrap().confidence >= 0.95);
        assert_eq!(r.get("surname").unwrap().value, "الساعدي");
        assert!(r.get("surname").unwrap().confidence >= 0.95);
    }

    #[test]
    fn mother_name_is_read_by_position_when_its_label_is_not() {
        let lines = vec![
            line("الاسم ناو كريم", 0.),
            line("الاب باوك سالم", 20.),
            line("الجد باپير جواد", 40.),
            line("اللقب نازناو الساعدي", 60.),
            // Label and Kurdish word misread; the value is still there.
            line("فب دايع سعاد", 80.),
            line("الجد بابير ناصر", 100.),
            line("الجنس رەگەز أنثى", 120.),
        ];
        let r = parse(&lines);
        let mother = r.get("mother_first").unwrap();
        assert_eq!(mother.value, "سعاد");
        assert!(mother.confidence < 0.8, "guessed by position: offered for review");
        assert_eq!(r.get("mother_father").unwrap().value, "ناصر");
        assert_eq!(r.get("surname").unwrap().value, "الساعدي");
    }

    #[test]
    fn printed_birth_date_that_disagrees_with_the_mrz_is_reported() {
        let (l1, l2) = td1();
        let lines = vec![line("تاريخ الولادة رۆژی لەدایک بوون 1990/01/07", 0.), line(&l1, 200.), line(&l2, 215.)];
        let r = parse(&lines);
        assert_eq!(r.get("birthdate").unwrap().value, "1990-01-01");
        assert_eq!(r.get("birthdate").unwrap().source, "mrz");
        assert!(r.warnings.iter().any(|w| w.contains("تاريخ الولادة") && w.contains("1990-01-07")), "{:?}", r.warnings);
        // Agreeing values give no warning.
        let lines = vec![line("تاريخ الولادة رۆژی لەدایک بوون 1990/01/01", 0.), line(&l1, 200.), line(&l2, 215.)];
        assert!(parse(&lines).warnings.is_empty());
    }

    #[test]
    fn printed_values_are_located_on_their_lines() {
        let lines = vec![line("الاسم ناو كريم", 0.), line("الاب باوك سالم", 20.), line("100000000001", 40.)];
        let r = parse(&lines);
        let at: std::collections::HashMap<_, _> = locate(&r, &lines).into_iter().collect();
        assert_eq!(at["first"][1], 0.);
        assert_eq!(at["father"][1], 20.);
        assert_eq!(at["national_no"][1], 40.);
    }

    #[test]
    fn ministry_id_arabic_side_with_split_boxes() {
        // Made-up values; label and value parts in separate boxes on each row, as the reader gives them.
        let b = |t: &str, x0: f32, y: f32, x1: f32| Line { text: t.into(), confidence: 0.95, bbox: [x0, y, x1, y + 70.] };
        let lines = vec![
            b("جمهورية العراق", 900., 10., 1250.), b("وزارة النقل", 170., 10., 400.),
            b("الشركة العامة لخدمات", 600., 250., 1050.),
            b("سالم", 700., 330., 830.), b("كريم جواد", 830., 330., 1110.), b("الأسم", 1115., 330., 1300.),
            b("الصيانة", 600., 410., 800.), b("قسم هندسة", 790., 410., 1110.), b("الدائرة", 1100., 410., 1300.),
            b("العنوان الوظيفي مهندس أقدم", 300., 495., 1310.),
            b("200300400", 650., 575., 1010.), b("رقم الهوية", 1015., 575., 1300.),
            b("2023/01/15", 580., 660., 930.), b("تاريخ الأصدارة", 945., 660., 1300.),
            b("2028/01/14", 590., 740., 940.), b("تاريخ النفاذة", 990., 740., 1300.),
            b("الدائرة الإدارية", 190., 785., 500.),
        ];
        let r = parse(&lines);
        assert_eq!(r.document, "ministry_badge");
        let v = |k: &str| r.get(k).map(|f| f.value.clone()).unwrap_or_default();
        assert_eq!((v("first"), v("father"), v("grandfather")), ("كريم".into(), "جواد".into(), "سالم".into()));
        assert_eq!(v("department"), "قسم هندسة الصيانة");
        assert_eq!(v("job_title"), "مهندس أقدم");
        assert_eq!(v("doc_number"), "200300400");
        assert_eq!(v("issue_date"), "2023-01-15");
        assert_eq!(v("expiry_date"), "2028-01-14");
    }
}
