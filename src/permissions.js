export function can(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}

export const roleLabels = {
  system_admin: "مسؤول النظام",
  archive_admin: "مسؤول الأرشيف",
  archive_officer: "موظف الأرشيف",
  viewer: "مشاهد",
};
