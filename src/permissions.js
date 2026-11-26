export function can(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}

// Three roles since schema v8 (same order everywhere: highest first).
export const roles = ["system_admin", "archive_officer", "viewer"];

export const roleLabels = {
  system_admin: "مسؤول",
  archive_officer: "موظف",
  viewer: "مشاهد",
  // Merged into «مسؤول» in v8; still named in older entries of the system log.
  archive_admin: "مسؤول الأرشيف (سابقًا)",
};

// One line under each role where an admin chooses it.
export const roleDescriptions = {
  system_admin: "كل شيء: الموظفون والأرشيف والحذف والمستخدمون والإعدادات والنسخ الاحتياطي وسجل النظام.",
  archive_officer: "يضيف الموظفين ويعدلهم، ويرفع المرفقات ويمسحها ضوئيًا. لا يحذف، ولا يدير الوارد والصادر.",
  viewer: "يعرض الموظفين والأرشيف، ويطبع ويحمّل المرفقات. لا يضيف ولا يعدل شيئًا.",
};

// «ماذا يستطيع كل دور»: mirrors role_permissions() in services.rs (Rust is what enforces it).
export const permissionMatrix = [
  ["عرض الرئيسية والموظفين والأرشيف", ["system_admin", "archive_officer", "viewer"]],
  ["الطباعة وتحميل المرفقات", ["system_admin", "archive_officer", "viewer"]],
  ["إضافة الموظفين وتعديلهم", ["system_admin", "archive_officer"]],
  ["رفع المرفقات ومسحها ضوئيًا", ["system_admin", "archive_officer"]],
  ["إضافة الوارد والصادر وتعديلهما", ["system_admin"]],
  ["حذف الموظفين والوثائق والمرفقات", ["system_admin"]],
  ["سجل النظام", ["system_admin"]],
  ["المستخدمون والإعدادات والنسخ الاحتياطي", ["system_admin"]],
];
