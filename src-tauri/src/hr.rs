use chrono::{Datelike, Duration, Months, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::services::{assert_permission, log_activity, AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrEmployeeProfile {
    pub employee_id: i64,
    pub employee_number: Option<String>,
    pub full_name: String,
    pub department: Option<String>,
    pub division: Option<String>,
    pub job_title: Option<String>,
    pub certificate: Option<String>,
    pub employment_date: Option<String>,
    pub current_salary_grade: Option<String>,
    pub current_salary_step: Option<i64>,
    pub current_base_salary: Option<f64>,
    pub last_promotion_date: Option<String>,
    pub last_allowance_date: Option<String>,
    pub service_status: Option<String>,
    pub linked_document_refs: Option<String>,
    pub system_promotion_due_date: Option<String>,
    pub manual_promotion_due_date: Option<String>,
    pub promotion_override_reason: Option<String>,
    pub promotion_approval_note: Option<String>,
    pub promotion_override_attachment: Option<String>,
    pub system_allowance_due_date: Option<String>,
    pub manual_allowance_due_date: Option<String>,
    pub allowance_override_reason: Option<String>,
    pub allowance_approval_note: Option<String>,
    pub allowance_override_attachment: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrEmployeeProfileData {
    pub employee_id: i64,
    pub certificate: Option<String>,
    pub current_salary_grade: Option<String>,
    pub current_salary_step: Option<i64>,
    pub current_base_salary: Option<f64>,
    pub last_promotion_date: Option<String>,
    pub last_allowance_date: Option<String>,
    pub service_status: Option<String>,
    pub linked_document_refs: Option<String>,
    pub manual_promotion_due_date: Option<String>,
    pub promotion_override_reason: Option<String>,
    pub promotion_approval_note: Option<String>,
    pub promotion_override_attachment: Option<String>,
    pub manual_allowance_due_date: Option<String>,
    pub allowance_override_reason: Option<String>,
    pub allowance_approval_note: Option<String>,
    pub allowance_override_attachment: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrSalaryScale {
    pub id: i64,
    pub rule_name: String,
    pub grade: String,
    pub step: i64,
    pub base_salary: Option<f64>,
    pub annual_allowance_amount: Option<f64>,
    pub steps_per_grade: Option<i64>,
    pub required_promotion_months: Option<i64>,
    pub allowance_period_months: i64,
    pub promotion_target_grade: Option<String>,
    pub promotion_target_step: Option<i64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: String,
    pub active: bool,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrSalaryScaleData {
    pub rule_name: Option<String>,
    pub grade: String,
    pub step: i64,
    pub base_salary: Option<f64>,
    pub annual_allowance_amount: Option<f64>,
    pub steps_per_grade: Option<i64>,
    pub required_promotion_months: Option<i64>,
    pub allowance_period_months: Option<i64>,
    pub promotion_target_grade: Option<String>,
    pub promotion_target_step: Option<i64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: Option<String>,
    pub active: Option<bool>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrAppreciationRule {
    pub id: i64,
    pub source_name: String,
    pub appreciation_type: Option<String>,
    pub credit_months: i64,
    pub credit_days: i64,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub max_accumulation_days: Option<i64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: String,
    pub active: bool,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrAppreciationRuleData {
    pub source_name: String,
    pub appreciation_type: Option<String>,
    pub credit_months: Option<i64>,
    pub credit_days: Option<i64>,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub max_accumulation_days: Option<i64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: Option<String>,
    pub active: Option<bool>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrPenaltyRule {
    pub id: i64,
    pub penalty_type: String,
    pub delay_months: i64,
    pub delay_days: i64,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub multiple_rule: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: String,
    pub active: bool,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrPenaltyRuleData {
    pub penalty_type: String,
    pub delay_months: Option<i64>,
    pub delay_days: Option<i64>,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub multiple_rule: Option<String>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: Option<String>,
    pub active: Option<bool>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrInterruptionRule {
    pub id: i64,
    pub interruption_type: String,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub counted_or_excluded: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: String,
    pub active: bool,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrInterruptionRuleData {
    pub interruption_type: String,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub counted_or_excluded: Option<String>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub rule_version: Option<String>,
    pub active: Option<bool>,
    pub change_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrAppreciationLetter {
    pub id: i64,
    pub employee_id: i64,
    pub employee_name: Option<String>,
    pub letter_number: String,
    pub letter_date: String,
    pub issuing_authority: Option<String>,
    pub appreciation_type: Option<String>,
    pub credit_months: i64,
    pub credit_days: i64,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub used_in_calculation: bool,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrAppreciationLetterData {
    pub employee_id: i64,
    pub letter_number: String,
    pub letter_date: String,
    pub issuing_authority: Option<String>,
    pub appreciation_type: Option<String>,
    pub credit_months: Option<i64>,
    pub credit_days: Option<i64>,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub used_in_calculation: Option<bool>,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrPenalty {
    pub id: i64,
    pub employee_id: i64,
    pub employee_name: Option<String>,
    pub penalty_order_number: String,
    pub penalty_date: String,
    pub penalty_type: String,
    pub delay_months: i64,
    pub delay_days: i64,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub cancelled: bool,
    pub cancellation_order: Option<String>,
    pub cancellation_date: Option<String>,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrPenaltyData {
    pub employee_id: i64,
    pub penalty_order_number: String,
    pub penalty_date: String,
    pub penalty_type: String,
    pub delay_months: Option<i64>,
    pub delay_days: Option<i64>,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub cancelled: Option<bool>,
    pub cancellation_order: Option<String>,
    pub cancellation_date: Option<String>,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrServiceInterruption {
    pub id: i64,
    pub employee_id: i64,
    pub employee_name: Option<String>,
    pub interruption_type: String,
    pub start_date: String,
    pub end_date: String,
    pub affects_promotion: bool,
    pub affects_allowance: bool,
    pub counted_or_excluded: String,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HrServiceInterruptionData {
    pub employee_id: i64,
    pub interruption_type: String,
    pub start_date: String,
    pub end_date: String,
    pub affects_promotion: Option<bool>,
    pub affects_allowance: Option<bool>,
    pub counted_or_excluded: Option<String>,
    pub attachment_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrCalculationComponent {
    pub label: String,
    pub date: Option<String>,
    pub months: i64,
    pub days: i64,
    pub counted: bool,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrEligibilityResult {
    pub employee_id: i64,
    pub employee_number: Option<String>,
    pub full_name: String,
    pub department: Option<String>,
    pub current_grade: Option<String>,
    pub current_step: Option<i64>,
    pub calculation_type: String,
    pub original_due_date: Option<String>,
    pub appreciation_credit_days: i64,
    pub penalty_delay_days: i64,
    pub excluded_service_days: i64,
    pub final_due_date: Option<String>,
    pub manual_due_date: Option<String>,
    pub alert_date: Option<String>,
    pub status: String,
    pub notes: Vec<String>,
    pub components: Vec<HrCalculationComponent>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HrDashboardSummary {
    pub promotion_due_6_months: i64,
    pub promotion_due_3_months: i64,
    pub promotion_due_this_month: i64,
    pub overdue_promotions: i64,
    pub allowance_due: i64,
    pub missing_hr_data: i64,
    pub unprocessed_appreciations: i64,
    pub active_penalties: i64,
    pub promotions: Vec<HrEligibilityResult>,
    pub allowances: Vec<HrEligibilityResult>,
}

fn bool_i(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

fn parse_date(value: &str, label: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{label} must use YYYY-MM-DD")))
}

fn date_opt(value: Option<String>) -> AppResult<Option<NaiveDate>> {
    value.map(|v| parse_date(&v, "date")).transpose()
}

fn fmt_date(value: NaiveDate) -> String {
    value.format("%Y-%m-%d").to_string()
}

fn add_months(date: NaiveDate, months: i64) -> NaiveDate {
    if months == 0 {
        date
    } else if months > 0 {
        date.checked_add_months(Months::new(months as u32)).unwrap_or(date)
    } else {
        date.checked_sub_months(Months::new((-months) as u32)).unwrap_or(date)
    }
}

fn duration_days(start: NaiveDate, end: NaiveDate) -> i64 {
    (end - start).num_days().max(0) + 1
}

fn validate_rule_dates(from: &str, to: &Option<String>) -> AppResult<()> {
    let start = parse_date(from, "effective_from")?;
    if let Some(to) = to {
        let end = parse_date(to, "effective_to")?;
        if end < start {
            return Err(AppError::Validation("effective_to must be after effective_from".into()));
        }
    }
    Ok(())
}

fn validate_nonnegative(values: &[i64]) -> AppResult<()> {
    if values.iter().any(|value| *value < 0) {
        return Err(AppError::Validation("Durations and numeric configuration values must be non-negative".into()));
    }
    Ok(())
}

pub fn list_hr_profiles(conn: &Connection) -> AppResult<Vec<HrEmployeeProfile>> {
    let mut stmt = conn.prepare(
        "SELECT e.id,e.employee_number,e.full_name,e.department,e.division,e.job_title,e.education_level,e.hire_date,
                p.certificate,p.current_salary_grade,p.current_salary_step,p.current_base_salary,
                p.last_promotion_date,p.last_allowance_date,p.service_status,p.linked_document_refs,
                p.system_promotion_due_date,p.manual_promotion_due_date,p.promotion_override_reason,p.promotion_approval_note,p.promotion_override_attachment,
                p.system_allowance_due_date,p.manual_allowance_due_date,p.allowance_override_reason,p.allowance_approval_note,p.allowance_override_attachment,p.notes
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employee_id=e.id
         ORDER BY e.full_name"
    )?;
    let rows = stmt.query_map([], map_profile)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_hr_profile(conn: &Connection, employee_id: i64) -> AppResult<HrEmployeeProfile> {
    conn.query_row(
        "SELECT e.id,e.employee_number,e.full_name,e.department,e.division,e.job_title,e.education_level,e.hire_date,
                p.certificate,p.current_salary_grade,p.current_salary_step,p.current_base_salary,
                p.last_promotion_date,p.last_allowance_date,p.service_status,p.linked_document_refs,
                p.system_promotion_due_date,p.manual_promotion_due_date,p.promotion_override_reason,p.promotion_approval_note,p.promotion_override_attachment,
                p.system_allowance_due_date,p.manual_allowance_due_date,p.allowance_override_reason,p.allowance_approval_note,p.allowance_override_attachment,p.notes
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employee_id=e.id
         WHERE e.id=?1",
        params![employee_id],
        map_profile,
    ).map_err(|_| AppError::NotFound)
}

fn map_profile(row: &rusqlite::Row) -> rusqlite::Result<HrEmployeeProfile> {
    Ok(HrEmployeeProfile {
        employee_id: row.get(0)?,
        employee_number: row.get(1)?,
        full_name: row.get(2)?,
        department: row.get(3)?,
        division: row.get(4)?,
        job_title: row.get(5)?,
        certificate: row.get::<_, Option<String>>(8)?.or(row.get(6)?),
        employment_date: row.get(7)?,
        current_salary_grade: row.get(9)?,
        current_salary_step: row.get(10)?,
        current_base_salary: row.get(11)?,
        last_promotion_date: row.get(12)?,
        last_allowance_date: row.get(13)?,
        service_status: row.get(14)?,
        linked_document_refs: row.get(15)?,
        system_promotion_due_date: row.get(16)?,
        manual_promotion_due_date: row.get(17)?,
        promotion_override_reason: row.get(18)?,
        promotion_approval_note: row.get(19)?,
        promotion_override_attachment: row.get(20)?,
        system_allowance_due_date: row.get(21)?,
        manual_allowance_due_date: row.get(22)?,
        allowance_override_reason: row.get(23)?,
        allowance_approval_note: row.get(24)?,
        allowance_override_attachment: row.get(25)?,
        notes: row.get(26)?,
    })
}

pub fn save_hr_profile(conn: &Connection, user: &str, data: &HrEmployeeProfileData) -> AppResult<HrEmployeeProfile> {
    assert_permission(conn, user, "hr.employees.manage")?;
    if data.employee_id <= 0 {
        return Err(AppError::Validation("employee_id is required".into()));
    }
    conn.query_row("SELECT id FROM employees WHERE id=?1", params![data.employee_id], |r| r.get::<_, i64>(0))
        .map_err(|_| AppError::NotFound)?;
    for (label, value) in [
        ("last_promotion_date", &data.last_promotion_date),
        ("last_allowance_date", &data.last_allowance_date),
        ("manual_promotion_due_date", &data.manual_promotion_due_date),
        ("manual_allowance_due_date", &data.manual_allowance_due_date),
    ] {
        if let Some(value) = value {
            parse_date(value, label)?;
        }
    }
    if data.manual_promotion_due_date.is_some() && data.promotion_override_reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::Validation("Promotion override reason is required".into()));
    }
    if data.manual_allowance_due_date.is_some() && data.allowance_override_reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::Validation("Allowance override reason is required".into()));
    }
    let has_override = data.manual_promotion_due_date.is_some()
        || data.promotion_override_reason.is_some()
        || data.promotion_approval_note.is_some()
        || data.promotion_override_attachment.is_some()
        || data.manual_allowance_due_date.is_some()
        || data.allowance_override_reason.is_some()
        || data.allowance_approval_note.is_some()
        || data.allowance_override_attachment.is_some();
    if has_override {
        assert_permission(conn, user, "hr.override.manage")?;
    }
    let previous = get_hr_profile(conn, data.employee_id).ok();
    conn.execute(
        "INSERT INTO hr_employee_profiles(
            employee_id,certificate,current_salary_grade,current_salary_step,current_base_salary,last_promotion_date,last_allowance_date,
            service_status,linked_document_refs,manual_promotion_due_date,promotion_override_reason,promotion_approval_note,promotion_override_attachment,
            manual_allowance_due_date,allowance_override_reason,allowance_approval_note,allowance_override_attachment,notes,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,COALESCE(?9,'[]'),?10,?11,?12,?13,?14,?15,?16,?17,?18,datetime('now'))
         ON CONFLICT(employee_id) DO UPDATE SET
            certificate=excluded.certificate,current_salary_grade=excluded.current_salary_grade,current_salary_step=excluded.current_salary_step,
            current_base_salary=excluded.current_base_salary,last_promotion_date=excluded.last_promotion_date,last_allowance_date=excluded.last_allowance_date,
            service_status=excluded.service_status,linked_document_refs=excluded.linked_document_refs,
            manual_promotion_due_date=excluded.manual_promotion_due_date,promotion_override_reason=excluded.promotion_override_reason,
            promotion_approval_note=excluded.promotion_approval_note,promotion_override_attachment=excluded.promotion_override_attachment,
            manual_allowance_due_date=excluded.manual_allowance_due_date,allowance_override_reason=excluded.allowance_override_reason,
            allowance_approval_note=excluded.allowance_approval_note,allowance_override_attachment=excluded.allowance_override_attachment,
            notes=excluded.notes,updated_at=datetime('now')",
        params![
            data.employee_id,data.certificate,data.current_salary_grade,data.current_salary_step,data.current_base_salary,
            data.last_promotion_date,data.last_allowance_date,data.service_status,data.linked_document_refs,
            data.manual_promotion_due_date,data.promotion_override_reason,data.promotion_approval_note,data.promotion_override_attachment,
            data.manual_allowance_due_date,data.allowance_override_reason,data.allowance_approval_note,data.allowance_override_attachment,data.notes
        ],
    )?;
    let next = get_hr_profile(conn, data.employee_id)?;
    let details = serde_json::json!({ "old": previous, "new": next }).to_string();
    log_activity(conn, user, "UPDATE_HR_PROFILE", Some("hr_employee_profile"), Some(data.employee_id), Some(&next.full_name), Some(&details));
    Ok(next)
}

pub fn list_salary_scales(conn: &Connection) -> AppResult<Vec<HrSalaryScale>> {
    let mut stmt = conn.prepare(
        "SELECT id,rule_name,grade,step,base_salary,annual_allowance_amount,steps_per_grade,required_promotion_months,
                allowance_period_months,promotion_target_grade,promotion_target_step,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason
         FROM hr_salary_scales ORDER BY active DESC, grade, step, effective_from DESC"
    )?;
    let rows = stmt.query_map([], map_salary_scale)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn map_salary_scale(row: &rusqlite::Row) -> rusqlite::Result<HrSalaryScale> {
    Ok(HrSalaryScale {
        id: row.get(0)?, rule_name: row.get(1)?, grade: row.get(2)?, step: row.get(3)?,
        base_salary: row.get(4)?, annual_allowance_amount: row.get(5)?, steps_per_grade: row.get(6)?,
        required_promotion_months: row.get(7)?, allowance_period_months: row.get(8)?,
        promotion_target_grade: row.get(9)?, promotion_target_step: row.get(10)?,
        effective_from: row.get(11)?, effective_to: row.get(12)?, rule_version: row.get(13)?,
        active: row.get::<_, i64>(14)? == 1, created_by: row.get(15)?, updated_by: row.get(16)?, change_reason: row.get(17)?,
    })
}

pub fn save_salary_scale(conn: &Connection, user: &str, id: Option<i64>, data: &HrSalaryScaleData) -> AppResult<HrSalaryScale> {
    assert_permission(conn, user, "hr.rules.manage")?;
    validate_rule_dates(&data.effective_from, &data.effective_to)?;
    validate_nonnegative(&[data.step, data.steps_per_grade.unwrap_or(0), data.required_promotion_months.unwrap_or(0), data.allowance_period_months.unwrap_or(12), data.promotion_target_step.unwrap_or(0)])?;
    if data.grade.trim().is_empty() {
        return Err(AppError::Validation("Salary grade is required".into()));
    }
    let rule_name = data.rule_name.as_deref().unwrap_or("salary_scale").trim();
    let version = data.rule_version.as_deref().unwrap_or("1").trim();
    let allowance_months = data.allowance_period_months.unwrap_or(12);
    let active = bool_i(data.active.unwrap_or(true));
    if let Some(id) = id {
        conn.execute(
            "UPDATE hr_salary_scales SET rule_name=?1,grade=?2,step=?3,base_salary=?4,annual_allowance_amount=?5,steps_per_grade=?6,
             required_promotion_months=?7,allowance_period_months=?8,promotion_target_grade=?9,promotion_target_step=?10,
             effective_from=?11,effective_to=?12,rule_version=?13,active=?14,updated_by=?15,change_reason=?16,updated_at=datetime('now') WHERE id=?17",
            params![rule_name,data.grade.trim(),data.step,data.base_salary,data.annual_allowance_amount,data.steps_per_grade,data.required_promotion_months,
                allowance_months,data.promotion_target_grade,data.promotion_target_step,data.effective_from,data.effective_to,version,active,user,data.change_reason,id],
        )?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute(
            "INSERT INTO hr_salary_scales(rule_name,grade,step,base_salary,annual_allowance_amount,steps_per_grade,required_promotion_months,
             allowance_period_months,promotion_target_grade,promotion_target_step,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16)",
            params![rule_name,data.grade.trim(),data.step,data.base_salary,data.annual_allowance_amount,data.steps_per_grade,data.required_promotion_months,
                allowance_months,data.promotion_target_grade,data.promotion_target_step,data.effective_from,data.effective_to,version,active,user,data.change_reason],
        )?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_SALARY_SCALE" } else { "CREATE_HR_SALARY_SCALE" }, Some("hr_salary_scale"), Some(new_id), Some(data.grade.trim()), data.change_reason.as_deref());
    conn.query_row(
        "SELECT id,rule_name,grade,step,base_salary,annual_allowance_amount,steps_per_grade,required_promotion_months,
         allowance_period_months,promotion_target_grade,promotion_target_step,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason
         FROM hr_salary_scales WHERE id=?1",
        params![new_id],
        map_salary_scale,
    ).map_err(Into::into)
}

pub fn delete_salary_scale(conn: &Connection, user: &str, id: i64) -> AppResult<()> {
    assert_permission(conn, user, "hr.rules.manage")?;
    conn.execute("DELETE FROM hr_salary_scales WHERE id=?1", params![id])?;
    if conn.changes() == 0 { return Err(AppError::NotFound); }
    log_activity(conn, user, "DELETE_HR_SALARY_SCALE", Some("hr_salary_scale"), Some(id), None, None);
    Ok(())
}

macro_rules! query_bool {
    ($row:expr, $idx:expr) => {
        $row.get::<_, i64>($idx)? == 1
    };
}

pub fn list_appreciation_rules(conn: &Connection) -> AppResult<Vec<HrAppreciationRule>> {
    let mut stmt = conn.prepare("SELECT id,source_name,appreciation_type,credit_months,credit_days,affects_promotion,affects_allowance,max_accumulation_days,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason FROM hr_appreciation_rules ORDER BY active DESC, source_name")?;
    let rows = stmt.query_map([], |r| Ok(HrAppreciationRule {
        id:r.get(0)?, source_name:r.get(1)?, appreciation_type:r.get(2)?, credit_months:r.get(3)?, credit_days:r.get(4)?,
        affects_promotion:query_bool!(r,5), affects_allowance:query_bool!(r,6), max_accumulation_days:r.get(7)?,
        effective_from:r.get(8)?, effective_to:r.get(9)?, rule_version:r.get(10)?, active:query_bool!(r,11),
        created_by:r.get(12)?, updated_by:r.get(13)?, change_reason:r.get(14)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn save_appreciation_rule(conn: &Connection, user: &str, id: Option<i64>, data: &HrAppreciationRuleData) -> AppResult<HrAppreciationRule> {
    assert_permission(conn, user, "hr.rules.manage")?;
    validate_rule_dates(&data.effective_from, &data.effective_to)?;
    validate_nonnegative(&[data.credit_months.unwrap_or(0), data.credit_days.unwrap_or(0), data.max_accumulation_days.unwrap_or(0)])?;
    if data.source_name.trim().is_empty() { return Err(AppError::Validation("Source name is required".into())); }
    if let Some(id) = id {
        conn.execute("UPDATE hr_appreciation_rules SET source_name=?1,appreciation_type=?2,credit_months=?3,credit_days=?4,affects_promotion=?5,affects_allowance=?6,max_accumulation_days=?7,effective_from=?8,effective_to=?9,rule_version=?10,active=?11,updated_by=?12,change_reason=?13,updated_at=datetime('now') WHERE id=?14",
            params![data.source_name.trim(),data.appreciation_type,data.credit_months.unwrap_or(0),data.credit_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(false)),data.max_accumulation_days,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_appreciation_rules(source_name,appreciation_type,credit_months,credit_days,affects_promotion,affects_allowance,max_accumulation_days,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)",
            params![data.source_name.trim(),data.appreciation_type,data.credit_months.unwrap_or(0),data.credit_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(false)),data.max_accumulation_days,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_APPRECIATION_RULE" } else { "CREATE_HR_APPRECIATION_RULE" }, Some("hr_appreciation_rule"), Some(new_id), Some(data.source_name.trim()), data.change_reason.as_deref());
    list_appreciation_rules(conn)?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn list_penalty_rules(conn: &Connection) -> AppResult<Vec<HrPenaltyRule>> {
    let mut stmt = conn.prepare("SELECT id,penalty_type,delay_months,delay_days,affects_promotion,affects_allowance,multiple_rule,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason FROM hr_penalty_rules ORDER BY active DESC, penalty_type")?;
    let rows = stmt.query_map([], |r| Ok(HrPenaltyRule {
        id:r.get(0)?, penalty_type:r.get(1)?, delay_months:r.get(2)?, delay_days:r.get(3)?,
        affects_promotion:query_bool!(r,4), affects_allowance:query_bool!(r,5), multiple_rule:r.get(6)?,
        effective_from:r.get(7)?, effective_to:r.get(8)?, rule_version:r.get(9)?, active:query_bool!(r,10),
        created_by:r.get(11)?, updated_by:r.get(12)?, change_reason:r.get(13)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn save_penalty_rule(conn: &Connection, user: &str, id: Option<i64>, data: &HrPenaltyRuleData) -> AppResult<HrPenaltyRule> {
    assert_permission(conn, user, "hr.rules.manage")?;
    validate_rule_dates(&data.effective_from, &data.effective_to)?;
    validate_nonnegative(&[data.delay_months.unwrap_or(0), data.delay_days.unwrap_or(0)])?;
    if data.penalty_type.trim().is_empty() { return Err(AppError::Validation("Penalty type is required".into())); }
    let multiple_rule = data.multiple_rule.as_deref().unwrap_or("accumulate");
    if !["accumulate", "strongest_only"].contains(&multiple_rule) {
        return Err(AppError::Validation("multiple_rule must be accumulate or strongest_only".into()));
    }
    if let Some(id) = id {
        conn.execute("UPDATE hr_penalty_rules SET penalty_type=?1,delay_months=?2,delay_days=?3,affects_promotion=?4,affects_allowance=?5,multiple_rule=?6,effective_from=?7,effective_to=?8,rule_version=?9,active=?10,updated_by=?11,change_reason=?12,updated_at=datetime('now') WHERE id=?13",
            params![data.penalty_type.trim(),data.delay_months.unwrap_or(0),data.delay_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),multiple_rule,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_penalty_rules(penalty_type,delay_months,delay_days,affects_promotion,affects_allowance,multiple_rule,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12)",
            params![data.penalty_type.trim(),data.delay_months.unwrap_or(0),data.delay_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),multiple_rule,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_PENALTY_RULE" } else { "CREATE_HR_PENALTY_RULE" }, Some("hr_penalty_rule"), Some(new_id), Some(data.penalty_type.trim()), data.change_reason.as_deref());
    list_penalty_rules(conn)?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn list_interruption_rules(conn: &Connection) -> AppResult<Vec<HrInterruptionRule>> {
    let mut stmt = conn.prepare("SELECT id,interruption_type,affects_promotion,affects_allowance,counted_or_excluded,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason FROM hr_interruption_rules ORDER BY active DESC, interruption_type")?;
    let rows = stmt.query_map([], |r| Ok(HrInterruptionRule {
        id:r.get(0)?, interruption_type:r.get(1)?, affects_promotion:query_bool!(r,2), affects_allowance:query_bool!(r,3),
        counted_or_excluded:r.get(4)?, effective_from:r.get(5)?, effective_to:r.get(6)?, rule_version:r.get(7)?,
        active:query_bool!(r,8), created_by:r.get(9)?, updated_by:r.get(10)?, change_reason:r.get(11)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn save_interruption_rule(conn: &Connection, user: &str, id: Option<i64>, data: &HrInterruptionRuleData) -> AppResult<HrInterruptionRule> {
    assert_permission(conn, user, "hr.rules.manage")?;
    validate_rule_dates(&data.effective_from, &data.effective_to)?;
    if data.interruption_type.trim().is_empty() { return Err(AppError::Validation("Interruption type is required".into())); }
    let counted = data.counted_or_excluded.as_deref().unwrap_or("excluded");
    if !["counted", "excluded"].contains(&counted) {
        return Err(AppError::Validation("counted_or_excluded must be counted or excluded".into()));
    }
    if let Some(id) = id {
        conn.execute("UPDATE hr_interruption_rules SET interruption_type=?1,affects_promotion=?2,affects_allowance=?3,counted_or_excluded=?4,effective_from=?5,effective_to=?6,rule_version=?7,active=?8,updated_by=?9,change_reason=?10,updated_at=datetime('now') WHERE id=?11",
            params![data.interruption_type.trim(),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),counted,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_interruption_rules(interruption_type,affects_promotion,affects_allowance,counted_or_excluded,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)",
            params![data.interruption_type.trim(),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),counted,data.effective_from,data.effective_to,data.rule_version.as_deref().unwrap_or("1"),bool_i(data.active.unwrap_or(true)),user,data.change_reason])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_INTERRUPTION_RULE" } else { "CREATE_HR_INTERRUPTION_RULE" }, Some("hr_interruption_rule"), Some(new_id), Some(data.interruption_type.trim()), data.change_reason.as_deref());
    list_interruption_rules(conn)?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn delete_hr_rule(conn: &Connection, user: &str, table: &str, id: i64) -> AppResult<()> {
    assert_permission(conn, user, "hr.rules.manage")?;
    let (sql, target) = match table {
        "appreciation" => ("DELETE FROM hr_appreciation_rules WHERE id=?1", "hr_appreciation_rule"),
        "penalty" => ("DELETE FROM hr_penalty_rules WHERE id=?1", "hr_penalty_rule"),
        "interruption" => ("DELETE FROM hr_interruption_rules WHERE id=?1", "hr_interruption_rule"),
        _ => return Err(AppError::Validation("Unsupported HR rule table".into())),
    };
    conn.execute(sql, params![id])?;
    if conn.changes() == 0 { return Err(AppError::NotFound); }
    log_activity(conn, user, "DELETE_HR_RULE", Some(target), Some(id), None, None);
    Ok(())
}

pub fn list_appreciation_letters(conn: &Connection, employee_id: Option<i64>) -> AppResult<Vec<HrAppreciationLetter>> {
    let filter = employee_id.map(|_| "WHERE l.employee_id=?1").unwrap_or("");
    let sql = format!("SELECT l.id,l.employee_id,e.full_name,l.letter_number,l.letter_date,l.issuing_authority,l.appreciation_type,l.credit_months,l.credit_days,l.affects_promotion,l.affects_allowance,l.used_in_calculation,l.attachment_path,l.notes FROM hr_appreciation_letters l JOIN employees e ON e.id=l.employee_id {filter} ORDER BY l.letter_date DESC,l.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| Ok(HrAppreciationLetter {
        id:r.get(0)?, employee_id:r.get(1)?, employee_name:r.get(2)?, letter_number:r.get(3)?, letter_date:r.get(4)?,
        issuing_authority:r.get(5)?, appreciation_type:r.get(6)?, credit_months:r.get(7)?, credit_days:r.get(8)?,
        affects_promotion:query_bool!(r,9), affects_allowance:query_bool!(r,10), used_in_calculation:query_bool!(r,11),
        attachment_path:r.get(12)?, notes:r.get(13)?,
    });
    Ok(match employee_id {
        Some(id) => stmt.query_map(params![id], mapper)?.collect::<rusqlite::Result<_>>()?,
        None => stmt.query_map([], mapper)?.collect::<rusqlite::Result<_>>()?,
    })
}

pub fn save_appreciation_letter(conn: &Connection, user: &str, id: Option<i64>, data: &HrAppreciationLetterData) -> AppResult<HrAppreciationLetter> {
    assert_permission(conn, user, "hr.appreciations.manage")?;
    parse_date(&data.letter_date, "letter_date")?;
    validate_nonnegative(&[data.credit_months.unwrap_or(0), data.credit_days.unwrap_or(0)])?;
    if data.letter_number.trim().is_empty() { return Err(AppError::Validation("Letter number is required".into())); }
    if let Some(id) = id {
        conn.execute("UPDATE hr_appreciation_letters SET employee_id=?1,letter_number=?2,letter_date=?3,issuing_authority=?4,appreciation_type=?5,credit_months=?6,credit_days=?7,affects_promotion=?8,affects_allowance=?9,used_in_calculation=?10,attachment_path=?11,notes=?12,updated_at=datetime('now') WHERE id=?13",
            params![data.employee_id,data.letter_number.trim(),data.letter_date,data.issuing_authority,data.appreciation_type,data.credit_months.unwrap_or(0),data.credit_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(false)),bool_i(data.used_in_calculation.unwrap_or(true)),data.attachment_path,data.notes,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_appreciation_letters(employee_id,letter_number,letter_date,issuing_authority,appreciation_type,credit_months,credit_days,affects_promotion,affects_allowance,used_in_calculation,attachment_path,notes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![data.employee_id,data.letter_number.trim(),data.letter_date,data.issuing_authority,data.appreciation_type,data.credit_months.unwrap_or(0),data.credit_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(false)),bool_i(data.used_in_calculation.unwrap_or(true)),data.attachment_path,data.notes])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_APPRECIATION" } else { "CREATE_HR_APPRECIATION" }, Some("hr_appreciation_letter"), Some(new_id), Some(data.letter_number.trim()), None);
    list_appreciation_letters(conn, Some(data.employee_id))?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn list_penalties(conn: &Connection, employee_id: Option<i64>) -> AppResult<Vec<HrPenalty>> {
    let filter = employee_id.map(|_| "WHERE p.employee_id=?1").unwrap_or("");
    let sql = format!("SELECT p.id,p.employee_id,e.full_name,p.penalty_order_number,p.penalty_date,p.penalty_type,p.delay_months,p.delay_days,p.affects_promotion,p.affects_allowance,p.cancelled,p.cancellation_order,p.cancellation_date,p.attachment_path,p.notes FROM hr_penalties p JOIN employees e ON e.id=p.employee_id {filter} ORDER BY p.penalty_date DESC,p.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| Ok(HrPenalty {
        id:r.get(0)?, employee_id:r.get(1)?, employee_name:r.get(2)?, penalty_order_number:r.get(3)?, penalty_date:r.get(4)?, penalty_type:r.get(5)?,
        delay_months:r.get(6)?, delay_days:r.get(7)?, affects_promotion:query_bool!(r,8), affects_allowance:query_bool!(r,9), cancelled:query_bool!(r,10),
        cancellation_order:r.get(11)?, cancellation_date:r.get(12)?, attachment_path:r.get(13)?, notes:r.get(14)?,
    });
    Ok(match employee_id {
        Some(id) => stmt.query_map(params![id], mapper)?.collect::<rusqlite::Result<_>>()?,
        None => stmt.query_map([], mapper)?.collect::<rusqlite::Result<_>>()?,
    })
}

pub fn save_penalty(conn: &Connection, user: &str, id: Option<i64>, data: &HrPenaltyData) -> AppResult<HrPenalty> {
    assert_permission(conn, user, "hr.penalties.manage")?;
    parse_date(&data.penalty_date, "penalty_date")?;
    if let Some(date) = &data.cancellation_date { parse_date(date, "cancellation_date")?; }
    validate_nonnegative(&[data.delay_months.unwrap_or(0), data.delay_days.unwrap_or(0)])?;
    if data.penalty_order_number.trim().is_empty() || data.penalty_type.trim().is_empty() {
        return Err(AppError::Validation("Penalty order number and type are required".into()));
    }
    if let Some(id) = id {
        conn.execute("UPDATE hr_penalties SET employee_id=?1,penalty_order_number=?2,penalty_date=?3,penalty_type=?4,delay_months=?5,delay_days=?6,affects_promotion=?7,affects_allowance=?8,cancelled=?9,cancellation_order=?10,cancellation_date=?11,attachment_path=?12,notes=?13,updated_at=datetime('now') WHERE id=?14",
            params![data.employee_id,data.penalty_order_number.trim(),data.penalty_date,data.penalty_type.trim(),data.delay_months.unwrap_or(0),data.delay_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),bool_i(data.cancelled.unwrap_or(false)),data.cancellation_order,data.cancellation_date,data.attachment_path,data.notes,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_penalties(employee_id,penalty_order_number,penalty_date,penalty_type,delay_months,delay_days,affects_promotion,affects_allowance,cancelled,cancellation_order,cancellation_date,attachment_path,notes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![data.employee_id,data.penalty_order_number.trim(),data.penalty_date,data.penalty_type.trim(),data.delay_months.unwrap_or(0),data.delay_days.unwrap_or(0),bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),bool_i(data.cancelled.unwrap_or(false)),data.cancellation_order,data.cancellation_date,data.attachment_path,data.notes])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_PENALTY" } else { "CREATE_HR_PENALTY" }, Some("hr_penalty"), Some(new_id), Some(data.penalty_order_number.trim()), None);
    list_penalties(conn, Some(data.employee_id))?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn list_service_interruptions(conn: &Connection, employee_id: Option<i64>) -> AppResult<Vec<HrServiceInterruption>> {
    let filter = employee_id.map(|_| "WHERE s.employee_id=?1").unwrap_or("");
    let sql = format!("SELECT s.id,s.employee_id,e.full_name,s.interruption_type,s.start_date,s.end_date,s.affects_promotion,s.affects_allowance,s.counted_or_excluded,s.attachment_path,s.notes FROM hr_service_interruptions s JOIN employees e ON e.id=s.employee_id {filter} ORDER BY s.start_date DESC,s.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| Ok(HrServiceInterruption {
        id:r.get(0)?, employee_id:r.get(1)?, employee_name:r.get(2)?, interruption_type:r.get(3)?, start_date:r.get(4)?, end_date:r.get(5)?,
        affects_promotion:query_bool!(r,6), affects_allowance:query_bool!(r,7), counted_or_excluded:r.get(8)?, attachment_path:r.get(9)?, notes:r.get(10)?,
    });
    Ok(match employee_id {
        Some(id) => stmt.query_map(params![id], mapper)?.collect::<rusqlite::Result<_>>()?,
        None => stmt.query_map([], mapper)?.collect::<rusqlite::Result<_>>()?,
    })
}

pub fn save_service_interruption(conn: &Connection, user: &str, id: Option<i64>, data: &HrServiceInterruptionData) -> AppResult<HrServiceInterruption> {
    assert_permission(conn, user, "hr.employees.manage")?;
    let start = parse_date(&data.start_date, "start_date")?;
    let end = parse_date(&data.end_date, "end_date")?;
    if end < start { return Err(AppError::Validation("end_date must be after start_date".into())); }
    if data.interruption_type.trim().is_empty() { return Err(AppError::Validation("Interruption type is required".into())); }
    let counted = data.counted_or_excluded.as_deref().unwrap_or("excluded");
    if !["counted", "excluded"].contains(&counted) {
        return Err(AppError::Validation("counted_or_excluded must be counted or excluded".into()));
    }
    if let Some(id) = id {
        conn.execute("UPDATE hr_service_interruptions SET employee_id=?1,interruption_type=?2,start_date=?3,end_date=?4,affects_promotion=?5,affects_allowance=?6,counted_or_excluded=?7,attachment_path=?8,notes=?9,updated_at=datetime('now') WHERE id=?10",
            params![data.employee_id,data.interruption_type.trim(),data.start_date,data.end_date,bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),counted,data.attachment_path,data.notes,id])?;
        if conn.changes() == 0 { return Err(AppError::NotFound); }
    } else {
        conn.execute("INSERT INTO hr_service_interruptions(employee_id,interruption_type,start_date,end_date,affects_promotion,affects_allowance,counted_or_excluded,attachment_path,notes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![data.employee_id,data.interruption_type.trim(),data.start_date,data.end_date,bool_i(data.affects_promotion.unwrap_or(true)),bool_i(data.affects_allowance.unwrap_or(true)),counted,data.attachment_path,data.notes])?;
    }
    let new_id = id.unwrap_or_else(|| conn.last_insert_rowid());
    log_activity(conn, user, if id.is_some() { "UPDATE_HR_INTERRUPTION" } else { "CREATE_HR_INTERRUPTION" }, Some("hr_service_interruption"), Some(new_id), Some(data.interruption_type.trim()), None);
    list_service_interruptions(conn, Some(data.employee_id))?.into_iter().find(|item| item.id == new_id).ok_or(AppError::NotFound)
}

pub fn delete_hr_record(conn: &Connection, user: &str, table: &str, id: i64) -> AppResult<()> {
    let (permission, sql, target) = match table {
        "appreciation" => ("hr.appreciations.manage", "DELETE FROM hr_appreciation_letters WHERE id=?1", "hr_appreciation_letter"),
        "penalty" => ("hr.penalties.manage", "DELETE FROM hr_penalties WHERE id=?1", "hr_penalty"),
        "interruption" => ("hr.employees.manage", "DELETE FROM hr_service_interruptions WHERE id=?1", "hr_service_interruption"),
        _ => return Err(AppError::Validation("Unsupported HR record table".into())),
    };
    assert_permission(conn, user, permission)?;
    conn.execute(sql, params![id])?;
    if conn.changes() == 0 { return Err(AppError::NotFound); }
    log_activity(conn, user, "DELETE_HR_RECORD", Some(target), Some(id), None, None);
    Ok(())
}

fn active_salary_rule(conn: &Connection, grade: &str, step: i64, date: NaiveDate) -> AppResult<Option<HrSalaryScale>> {
    let date_str = fmt_date(date);
    conn.query_row(
        "SELECT id,rule_name,grade,step,base_salary,annual_allowance_amount,steps_per_grade,required_promotion_months,
                allowance_period_months,promotion_target_grade,promotion_target_step,effective_from,effective_to,rule_version,active,created_by,updated_by,change_reason
         FROM hr_salary_scales
         WHERE active=1 AND grade=?1 AND step=?2 AND effective_from<=?3 AND (effective_to IS NULL OR effective_to='' OR effective_to>=?3)
         ORDER BY effective_from DESC,id DESC LIMIT 1",
        params![grade, step, date_str],
        map_salary_scale,
    ).optional().map_err(Into::into)
}

fn effective_alert_months(conn: &Connection) -> i64 {
    conn.query_row("SELECT value FROM app_settings WHERE key='hr_alert_lead_months'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(6)
}

fn status_for(final_due: NaiveDate, alert_months: i64, today: NaiveDate) -> String {
    if final_due <= today {
        return if final_due < today { "Overdue".into() } else { "Due now".into() };
    }
    let days = (final_due - today).num_days();
    if days <= 31 { "Due within 1 month".into() }
    else if days <= 93 { "Due within 3 months".into() }
    else if days <= alert_months * 31 { "Due within 6 months".into() }
    else { "Not due".into() }
}

fn credit_days(months: i64, days: i64) -> i64 {
    months.saturating_mul(30).saturating_add(days)
}

fn calculate_one(conn: &Connection, profile: HrEmployeeProfile, calculation_type: &str) -> AppResult<HrEligibilityResult> {
    let today = Utc::now().date_naive();
    let alert_months = effective_alert_months(conn);
    let mut notes = Vec::new();
    let mut components = Vec::new();
    let grade = profile.current_salary_grade.clone();
    let step = profile.current_salary_step;
    let blocked = false;

    let base_date = if calculation_type == "promotion" {
        date_opt(profile.last_promotion_date.clone())?
    } else {
        date_opt(profile.last_allowance_date.clone())?
    };
    let Some(base_date) = base_date else {
        notes.push(if calculation_type == "promotion" { "Missing last promotion date" } else { "Missing last allowance date" }.into());
        return Ok(blocked_result(profile, calculation_type, notes));
    };
    let Some(grade_value) = grade.as_deref() else {
        notes.push("Missing current salary grade".into());
        return Ok(blocked_result(profile, calculation_type, notes));
    };
    let Some(step_value) = step else {
        notes.push("Missing current salary step".into());
        return Ok(blocked_result(profile, calculation_type, notes));
    };
    let Some(rule) = active_salary_rule(conn, grade_value, step_value, base_date)? else {
        notes.push("No active salary scale rule for employee grade/step/date".into());
        return Ok(blocked_result(profile, calculation_type, notes));
    };
    let period_months = if calculation_type == "promotion" {
        rule.required_promotion_months
    } else {
        Some(rule.allowance_period_months)
    };
    let Some(period_months) = period_months else {
        notes.push("Missing configured required period".into());
        return Ok(blocked_result(profile, calculation_type, notes));
    };

    let original = add_months(base_date, period_months);
    components.push(HrCalculationComponent {
        label: format!("Configured period from rule {}", rule.rule_version),
        date: Some(fmt_date(base_date)),
        months: period_months,
        days: 0,
        counted: true,
        notes: Some(format!("grade {} / step {}", rule.grade, rule.step)),
    });

    let mut appreciation_days = 0;
    for item in list_appreciation_letters(conn, Some(profile.employee_id))? {
        let affects = if calculation_type == "promotion" { item.affects_promotion } else { item.affects_allowance };
        let counted = item.used_in_calculation && affects;
        let days = if counted { credit_days(item.credit_months, item.credit_days) } else { 0 };
        appreciation_days += days;
        components.push(HrCalculationComponent {
            label: format!("Appreciation {}", item.letter_number),
            date: Some(item.letter_date),
            months: item.credit_months,
            days: item.credit_days,
            counted,
            notes: if counted { item.notes } else { Some("Ignored: not marked for this calculation or already disabled".into()) },
        });
    }

    let mut penalty_days = 0;
    for item in list_penalties(conn, Some(profile.employee_id))? {
        let affects = if calculation_type == "promotion" { item.affects_promotion } else { item.affects_allowance };
        let counted = !item.cancelled && affects;
        let days = if counted { credit_days(item.delay_months, item.delay_days) } else { 0 };
        penalty_days += days;
        components.push(HrCalculationComponent {
            label: format!("Penalty {}", item.penalty_order_number),
            date: Some(item.penalty_date),
            months: item.delay_months,
            days: item.delay_days,
            counted,
            notes: if counted { item.notes } else { Some("Ignored: cancelled/revoked or does not affect this calculation".into()) },
        });
    }

    let mut interruption_days = 0;
    for item in list_service_interruptions(conn, Some(profile.employee_id))? {
        let affects = if calculation_type == "promotion" { item.affects_promotion } else { item.affects_allowance };
        let start = parse_date(&item.start_date, "interruption start_date")?;
        let end = parse_date(&item.end_date, "interruption end_date")?;
        let counted = affects && item.counted_or_excluded == "excluded";
        let days = if counted { duration_days(start, end) } else { 0 };
        interruption_days += days;
        components.push(HrCalculationComponent {
            label: format!("Service interruption {}", item.interruption_type),
            date: Some(item.start_date),
            months: 0,
            days,
            counted,
            notes: if counted { item.notes } else { Some("Ignored: counted service or does not affect this calculation".into()) },
        });
    }

    let final_due = original - Duration::days(appreciation_days) + Duration::days(penalty_days + interruption_days);
    let alert_date = add_months(final_due, -alert_months);
    let manual = if calculation_type == "promotion" { profile.manual_promotion_due_date.clone() } else { profile.manual_allowance_due_date.clone() };
    let status = if blocked { "Blocked / missing data".into() } else { status_for(final_due, alert_months, today) };
    let final_text = fmt_date(final_due);
    if calculation_type == "promotion" {
        conn.execute("UPDATE hr_employee_profiles SET system_promotion_due_date=?1,updated_at=datetime('now') WHERE employee_id=?2", params![final_text, profile.employee_id]).ok();
    } else {
        conn.execute("UPDATE hr_employee_profiles SET system_allowance_due_date=?1,updated_at=datetime('now') WHERE employee_id=?2", params![final_text, profile.employee_id]).ok();
    }

    Ok(HrEligibilityResult {
        employee_id: profile.employee_id,
        employee_number: profile.employee_number,
        full_name: profile.full_name,
        department: profile.department,
        current_grade: profile.current_salary_grade,
        current_step: profile.current_salary_step,
        calculation_type: calculation_type.into(),
        original_due_date: Some(fmt_date(original)),
        appreciation_credit_days: appreciation_days,
        penalty_delay_days: penalty_days,
        excluded_service_days: interruption_days,
        final_due_date: Some(fmt_date(final_due)),
        manual_due_date: manual,
        alert_date: Some(fmt_date(alert_date)),
        status,
        notes,
        components,
    })
}

fn blocked_result(profile: HrEmployeeProfile, calculation_type: &str, notes: Vec<String>) -> HrEligibilityResult {
    HrEligibilityResult {
        employee_id: profile.employee_id,
        employee_number: profile.employee_number,
        full_name: profile.full_name,
        department: profile.department,
        current_grade: profile.current_salary_grade,
        current_step: profile.current_salary_step,
        calculation_type: calculation_type.into(),
        original_due_date: None,
        appreciation_credit_days: 0,
        penalty_delay_days: 0,
        excluded_service_days: 0,
        final_due_date: None,
        manual_due_date: if calculation_type == "promotion" { profile.manual_promotion_due_date } else { profile.manual_allowance_due_date },
        alert_date: None,
        status: "Blocked / missing data".into(),
        notes,
        components: Vec::new(),
    }
}

pub fn calculate_hr_employee(conn: &Connection, employee_id: i64) -> AppResult<Vec<HrEligibilityResult>> {
    let profile = get_hr_profile(conn, employee_id)?;
    Ok(vec![
        calculate_one(conn, profile.clone(), "promotion")?,
        calculate_one(conn, profile, "allowance")?,
    ])
}

pub fn calculate_hr_all(conn: &Connection) -> AppResult<Vec<HrEligibilityResult>> {
    let profiles = list_hr_profiles(conn)?;
    let mut results = Vec::new();
    for profile in profiles {
        results.push(calculate_one(conn, profile.clone(), "promotion")?);
        results.push(calculate_one(conn, profile, "allowance")?);
    }
    Ok(results)
}

pub fn dashboard_summary(conn: &Connection) -> AppResult<HrDashboardSummary> {
    let results = calculate_hr_all(conn)?;
    let promotions: Vec<_> = results.iter().filter(|item| item.calculation_type == "promotion").cloned().collect();
    let allowances: Vec<_> = results.iter().filter(|item| item.calculation_type == "allowance").cloned().collect();
    let today = Utc::now().date_naive();
    let month = today.month();
    let year = today.year();
    let due_in_days = |item: &HrEligibilityResult, max_days: i64| -> bool {
        item.final_due_date.as_deref()
            .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
            .is_some_and(|date| date >= today && (date - today).num_days() <= max_days)
    };
    let due_this_month = |item: &HrEligibilityResult| -> bool {
        item.final_due_date.as_deref()
            .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
            .is_some_and(|date| date.year() == year && date.month() == month)
    };
    let missing_hr_data = promotions.iter().filter(|item| item.status == "Blocked / missing data").count() as i64;
    let unprocessed_appreciations: i64 = conn.query_row("SELECT COUNT(*) FROM hr_appreciation_letters WHERE used_in_calculation=0", [], |r| r.get(0)).unwrap_or(0);
    let active_penalties: i64 = conn.query_row("SELECT COUNT(*) FROM hr_penalties WHERE cancelled=0", [], |r| r.get(0)).unwrap_or(0);
    Ok(HrDashboardSummary {
        promotion_due_6_months: promotions.iter().filter(|item| due_in_days(item, 186)).count() as i64,
        promotion_due_3_months: promotions.iter().filter(|item| due_in_days(item, 93)).count() as i64,
        promotion_due_this_month: promotions.iter().filter(|item| due_this_month(item)).count() as i64,
        overdue_promotions: promotions.iter().filter(|item| item.status == "Overdue").count() as i64,
        allowance_due: allowances.iter().filter(|item| ["Due now", "Overdue", "Due within 1 month"].contains(&item.status.as_str())).count() as i64,
        missing_hr_data,
        unprocessed_appreciations,
        active_penalties,
        promotions,
        allowances,
    })
}

pub fn set_hr_alert_lead_months(conn: &Connection, user: &str, months: i64) -> AppResult<i64> {
    assert_permission(conn, user, "hr.rules.manage")?;
    if !(1..=24).contains(&months) {
        return Err(AppError::Validation("Alert lead time must be between 1 and 24 months".into()));
    }
    conn.execute("INSERT INTO app_settings(key,value) VALUES('hr_alert_lead_months',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![months.to_string()])?;
    log_activity(conn, user, "UPDATE_HR_ALERT_LEAD", Some("settings"), None, Some("hr_alert_lead_months"), Some(&months.to_string()));
    Ok(months)
}

pub fn get_hr_alert_lead_months(conn: &Connection) -> AppResult<i64> {
    Ok(effective_alert_months(conn))
}
