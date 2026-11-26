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

// «ماذا يستطيع كل دور»: the rows of PERMISSION_GROUPS in services.rs (Rust is what enforces them).
// A System Admin may tick the editable rows for «موظف» and «مشاهد»; «view» stays on for every role
// and «admin» stays with «مسؤول» only.
export const permissionGroups = [
  { id: "view", label: "عرض الرئيسية والموظفين والأرشيف", short: "العرض", locked: "all" },
  { id: "print", label: "الطباعة وتحميل المرفقات", short: "الطباعة وتحميل المرفقات" },
  { id: "employees_edit", label: "إضافة الموظفين وتعديلهم", short: "إضافة الموظفين وتعديلهم" },
  { id: "upload", label: "رفع المرفقات ومسحها ضوئيًا", short: "رفع المرفقات ومسحها" },
  { id: "correspondence", label: "إضافة الوارد والصادر وتعديلهما", short: "الوارد والصادر" },
  { id: "delete", label: "حذف الموظفين والوثائق والمرفقات", short: "الحذف" },
  { id: "audit", label: "سجل النظام", short: "سجل النظام" },
  { id: "admin", label: "المستخدمون والإعدادات والنسخ الاحتياطي", short: "المستخدمون والإعدادات", locked: "admin" },
];

/** What «موظف» and «مشاهد» have when nothing was changed (role_permissions() in Rust). */
export const builtInRoleGroups = { archive_officer: ["print", "employees_edit", "upload"], viewer: ["print"] };

/** True when `role` has the row `group` under the given choice. */
export function roleHasGroup(role, group, groups = builtInRoleGroups) {
  if (role === "system_admin") return true;
  if (group.locked === "all") return true;
  if (group.locked === "admin") return false;
  return (groups?.[role] ?? []).includes(group.id);
}

/** The line under a role where an admin chooses it, following the current choice. */
export function describeRole(role, groups = builtInRoleGroups) {
  if (role === "system_admin") return roleDescriptions.system_admin;
  const same = [...(groups?.[role] ?? [])].sort().join() === [...(builtInRoleGroups[role] ?? [])].sort().join();
  if (same && roleDescriptions[role]) return roleDescriptions[role];
  const extra = permissionGroups.filter(group => !group.locked && roleHasGroup(role, group, groups)).map(group => group.short);
  return extra.length ? `يعرض الموظفين والأرشيف، ويستطيع: ${extra.join("، ")}.` : "يعرض الموظفين والأرشيف فقط.";
}
