#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const schemaPath = join(root, "database", "schema.sql");
const bundledDb = join(root, "src-tauri", "resources", "database.db");
const runtimeDb = process.env.APPDATA ? join(process.env.APPDATA, "CNSArch", "database.db") : null;

const targets = [
  ["bundled", bundledDb],
  ...(runtimeDb && existsSync(runtimeDb) ? [["runtime", runtimeDb]] : []),
];

const grades = ["الدرجة الرابعة", "الدرجة الخامسة", "الدرجة السادسة", "الدرجة السابعة", "الدرجة الثامنة", "الدرجة التاسعة", "الدرجة العاشرة"];
const departments = [
  ["الموارد البشرية", "شؤون الموظفين"],
  ["المالية", "الحسابات"],
  ["تقنية المعلومات", "الأنظمة"],
  ["العمليات", "المراقبة"],
  ["الصيانة", "الصيانة الكهربائية"],
  ["القانونية", "العقود"],
  ["الأرشيف", "الصادر والوارد"],
  ["الإدارة", "الخدمات"],
];
const names = [
  ["سيف ناظم كريم", "هدى سلمان جاسم", "ذكر", "مهندس نظم", "بكالوريوس", "هندسة حاسبات"],
  ["مريم فاضل حسن", "إيمان كريم عباس", "أنثى", "محاسب أول", "بكالوريوس", "محاسبة"],
  ["حيدر سامي جبار", "ابتسام نوري كاظم", "ذكر", "مشرف عمليات", "دبلوم", "إدارة عمليات"],
  ["زهراء كاظم عادل", "سعاد حميد لطيف", "أنثى", "مسؤول موارد بشرية", "بكالوريوس", "إدارة أعمال"],
  ["ليث مازن صالح", "نجلاء جاسم محمد", "ذكر", "فني صيانة", "دبلوم", "تقنيات كهربائية"],
  ["علي حسين عبد", "أمل فاضل مهدي", "ذكر", "موظف أرشيف", "إعدادية", "إدارة مكتبية"],
  ["نور علي جاسم", "وفاء عبد الرضا", "أنثى", "مدقق حسابات", "بكالوريوس", "علوم مالية"],
  ["مصطفى رياض خليل", "رنا طالب كاظم", "ذكر", "مبرمج", "بكالوريوس", "علوم حاسبات"],
  ["رسل أحمد ياسين", "سهام كامل حمزة", "أنثى", "باحث قانوني", "بكالوريوس", "قانون"],
  ["كرار فلاح مهدي", "منى صباح حسن", "ذكر", "مراقب حركة", "دبلوم", "ملاحة جوية"],
  ["دينا جلال عباس", "حنان سعدون جابر", "أنثى", "سكرتير تنفيذي", "بكالوريوس", "إدارة"],
  ["مرتضى قاسم هادي", "خلود ناصر علي", "ذكر", "فني اتصالات", "دبلوم", "اتصالات"],
  ["سارة عادل مهدي", "نادية رزاق شنان", "أنثى", "موظف وارد", "دبلوم", "إدارة مكاتب"],
  ["أحمد جبار سالم", "مها نوري عبد", "ذكر", "سائق إداري", "متوسطة", "خدمات"],
  ["بتول نعيم كاظم", "شذى قاسم حسين", "أنثى", "محلل بيانات", "بكالوريوس", "إحصاء"],
  ["حسن واثق جاسم", "سميرة غازي عودة", "ذكر", "مسؤول مخازن", "إعدادية", "إدارة مخازن"],
  ["ريم عبد الكريم", "ليلى صابر عباس", "أنثى", "موظف رواتب", "بكالوريوس", "محاسبة"],
  ["باسم فؤاد شاكر", "رجاء حميد صالح", "ذكر", "مهندس أجهزة", "بكالوريوس", "هندسة إلكترونيك"],
  ["آية منتظر علي", "إخلاص فاضل رحيم", "أنثى", "مدقق عقود", "بكالوريوس", "قانون"],
  ["مؤمل صلاح جاسم", "سناء عبد الله كريم", "ذكر", "فني سلامة", "دبلوم", "سلامة مهنية"],
];
const cities = ["بغداد", "البصرة", "كربلاء", "النجف", "الموصل", "واسط", "ذي قار", "ديالى"];
const bloodTypes = ["A+", "O+", "B+", "AB+", "O-", "A-"];

function pad(n) {
  return String(n).padStart(2, "0");
}

function date(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function employeeRows() {
  return names.map((item, index) => {
    const n = index + 1;
    const [department, division] = departments[index % departments.length];
    const grade = grades[index % grades.length];
    const step = (index % 5) + 1;
    const city = cities[index % cities.length];
    const birthYear = 1983 + (index % 16);
    const hireYear = 2010 + (index % 14);
    const lastPromotionYear = Math.min(2025, hireYear + 8 + (index % 4));
    const lastAllowanceYear = 2024 + (index % 2);
    return {
      employee_number: `FAKE-EMP-${pad(n)}`,
      full_name: item[0],
      mother_name: item[1],
      gender: item[2],
      job_title: item[3],
      education_level: item[4],
      specialization: item[5],
      birthdate: date(birthYear, (index % 12) + 1, ((index * 3) % 27) + 1),
      birthplace: city,
      marital_status: index % 4 === 0 ? "أعزب" : "متزوج",
      blood_type: bloodTypes[index % bloodTypes.length],
      workplace: index % 3 === 0 ? "موقع العمليات" : "مقر الشركة",
      job_grade: grade,
      salary_step: step,
      hire_date: date(hireYear, ((index + 2) % 12) + 1, ((index * 5) % 25) + 1),
      appointment_date: date(hireYear, ((index + 2) % 12) + 1, ((index * 5) % 25) + 1),
      contract_type: index % 5 === 0 ? "عقد" : "ملاك",
      work_schedule: index % 3 === 0 ? "مناوب" : "صباحي",
      department,
      division,
      phone: `07700000${String(n).padStart(3, "0")}`,
      email: `fake.employee${pad(n)}@example.test`,
      civil_id: `FAKE-NID-${100000 + n}`,
      civil_id_issuer: `مديرية البطاقة الوطنية - ${city}`,
      civil_id_issue_date: date(2020 + (index % 4), ((index + 4) % 12) + 1, ((index * 7) % 24) + 1),
      civil_id_expiry_date: date(2030 + (index % 4), ((index + 4) % 12) + 1, ((index * 7) % 24) + 1),
      residence_card_no: `FAKE-RES-${1000 + n}`,
      residence_card_issuer: `مركز معلومات ${city}`,
      residence_address: `${city} - عنوان تجريبي رقم ${n}`,
      ration_card_no: `FAKE-RAT-${1000 + n}`,
      ration_center_name: `مركز تموين ${city} التجريبي`,
      passport_no: `FAKE-P-${100000 + n}`,
      passport_name: `FAKE EMPLOYEE ${pad(n)}`,
      passport_issue_date: date(2021 + (index % 3), ((index + 1) % 12) + 1, 10),
      passport_expiry_date: date(2029 + (index % 3), ((index + 1) % 12) + 1, 9),
      last_promotion_date: date(lastPromotionYear, ((index + 3) % 12) + 1, 1),
      last_allowance_date: date(lastAllowanceYear, ((index + 5) % 12) + 1, 1),
      service_status: index === 18 ? "إجازة دراسية" : "مستمر بالخدمة",
      current_base_salary: 420000 + (grades.indexOf(grade) * 70000) + (step * 15000),
      notes: "بيانات وهمية لأغراض الاختبار والتجربة فقط",
      spouse_name: index % 4 === 0 ? null : `زوج/زوجة تجريبي ${n}`,
      children: index % 3,
    };
  });
}

function ensureSampleSalaryScale(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO hr_salary_scales(
      rule_name,grade,step,base_salary,annual_allowance_amount,steps_per_grade,
      required_promotion_months,allowance_period_months,promotion_target_grade,promotion_target_step,
      effective_from,rule_version,active,created_by,updated_by,change_reason
    ) VALUES('sample_salary_scale',?,?,?,?,?,?,?,?,?,'2020-01-01','sample-v1',1,'seed','seed','editable fake sample')
  `);
  for (const [gradeIndex, grade] of grades.entries()) {
    for (let step = 1; step <= 5; step += 1) {
      const targetGrade = grades[Math.max(0, gradeIndex - 1)] ?? grade;
      insert.run(
        grade,
        step,
        420000 + (gradeIndex * 70000) + (step * 15000),
        10000 + (gradeIndex * 2500),
        5,
        48 + (gradeIndex % 3) * 12,
        12,
        targetGrade,
        1,
      );
    }
  }
}

function seed(dbPath, label) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(schemaPath, "utf8"));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM employees WHERE employee_number LIKE 'FAKE-EMP-%'").run();
    ensureSampleSalaryScale(db);

    const insertEmployee = db.prepare(`
      INSERT INTO employees(
        employee_number,full_name,mother_name,gender,birthdate,birthplace,marital_status,blood_type,
        workplace,job_title,job_grade,hire_date,appointment_date,contract_type,work_schedule,
        department,division,phone,email,education_level,specialization,civil_id,civil_id_issuer,
        civil_id_issue_date,civil_id_expiry_date,civil_id_birthplace,civil_id_birthdate,civil_id_family_number,
        residence_card_no,residence_card_issuer,residence_address,ration_card_no,ration_center_name,
        passport_no,passport_name,passport_issue_date,passport_expiry_date,spouse_name,family_members,notes,is_active
      ) VALUES(
        @employee_number,@full_name,@mother_name,@gender,@birthdate,@birthplace,@marital_status,@blood_type,
        @workplace,@job_title,@job_grade,@hire_date,@appointment_date,@contract_type,@work_schedule,
        @department,@division,@phone,@email,@education_level,@specialization,@civil_id,@civil_id_issuer,
        @civil_id_issue_date,@civil_id_expiry_date,@birthplace,@birthdate,@civil_id,
        @residence_card_no,@residence_card_issuer,@residence_address,@ration_card_no,@ration_center_name,
        @passport_no,@passport_name,@passport_issue_date,@passport_expiry_date,@spouse_name,@family_members,@notes,1
      )
    `);
    const insertProfile = db.prepare(`
      INSERT INTO hr_employee_profiles(
        employee_id,certificate,current_salary_grade,current_salary_step,current_base_salary,
        last_promotion_date,last_allowance_date,service_status,linked_document_refs,notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    const insertAppreciation = db.prepare(`
      INSERT INTO hr_appreciation_letters(
        employee_id,letter_number,letter_date,issuing_authority,appreciation_type,credit_months,credit_days,
        affects_promotion,affects_allowance,used_in_calculation,notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertPenalty = db.prepare(`
      INSERT INTO hr_penalties(
        employee_id,penalty_order_number,penalty_date,penalty_type,delay_months,delay_days,
        affects_promotion,affects_allowance,cancelled,notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    const insertInterruption = db.prepare(`
      INSERT INTO hr_service_interruptions(
        employee_id,interruption_type,start_date,end_date,affects_promotion,affects_allowance,counted_or_excluded,notes
      ) VALUES(?,?,?,?,?,?,?,?)
    `);

    for (const row of employeeRows()) {
      const family = Array.from({ length: row.children }, (_, i) => ({
        name: `طفل تجريبي ${i + 1} للموظف ${row.employee_number}`,
        birthdate: date(2015 + i + (Number(row.employee_number.slice(-2)) % 3), i + 2, 12),
        civil_id: `${row.employee_number}-CHILD-${i + 1}`,
        issuer: row.birthplace,
      }));
      const info = insertEmployee.run({ ...row, family_members: JSON.stringify(family) });
      const employeeId = info.lastInsertRowid;
      insertProfile.run(
        employeeId,
        row.education_level,
        row.job_grade,
        row.salary_step,
        row.current_base_salary,
        row.last_promotion_date,
        row.last_allowance_date,
        row.service_status,
        "[]",
        row.notes,
      );
      if (employeeId % 2 === 0) {
        insertAppreciation.run(employeeId, `FAKE-APP-${employeeId}`, "2025-03-15", "إدارة تجريبية", "شكر وتقدير", 1, 0, 1, 0, 1, "كتاب شكر وهمي للاختبار");
      }
      if (employeeId % 5 === 0) {
        insertPenalty.run(employeeId, `FAKE-PEN-${employeeId}`, "2024-10-10", "تنبيه", 0, 15, 1, 1, 0, "عقوبة وهمية للاختبار");
      }
      if (employeeId % 7 === 0) {
        insertInterruption.run(employeeId, "إجازة بدون راتب", "2024-05-01", "2024-05-20", 1, 1, "excluded", "انقطاع خدمة وهمي للاختبار");
      }
    }
  });
  tx();
  const count = db.prepare("SELECT COUNT(*) count FROM employees WHERE employee_number LIKE 'FAKE-EMP-%'").get().count;
  db.close();
  console.log(`✓ ${label}: inserted ${count} fake employees into ${dbPath}`);
}

if (!targets.length) {
  console.error("No database targets found.");
  process.exit(1);
}

for (const [label, dbPath] of targets) {
  seed(dbPath, label);
}
