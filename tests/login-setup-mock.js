// Mock backend for the login and first-run tests (tests/login-setup.spec.js). Loaded with
// page.addInitScript before the app starts. Messages are copied from Rust (account.rs, services.rs,
// storage.rs), whose own tests cover the real logic.
(() => {
  const M = window.__mock = Object.assign({
    state: "needs_setup", data_root: "", backup_root: "", message: "",
    suggested_data_root: "D:\\CNSArch-Data", suggested_backup_root: "E:\\CNSArch-Backups",
    needsAdmin: true, users: { sysadmin: { password: "password", mustChange: true } }, base: "sysadmin",
    failures: {}, department: "", division: "", recoveryCode: "", unlock: true, calls: [],
    policy: { min_length: 9, require_upper: true, require_lower: true, require_digit: true, require_symbol: false, reject_common: true, max_failures: 5, lockout_minutes: 5 },
    busyFolders: ["D:\\", "E:\\", "D:\\Shared"],
  }, window.__mockInit || {});
  const UNAUTH = "You are not authorized to perform this action";
  const WRONG = "اسم المستخدم أو كلمة المرور غير صحيحة";
  const lock = m => `تم إيقاف الدخول مؤقتًا بسبب تكرار المحاولات الخاطئة. حاول بعد ${m === 5 ? "5 دقائق" : m + " دقيقة"}.`;
  const drive = p => (p.match(/^([A-Za-z]):/) || [])[1]?.toUpperCase();
  const status = () => ({ state: M.state, data_root: M.data_root, backup_root: M.backup_root, message: M.message, suggested_data_root: M.suggested_data_root, suggested_backup_root: M.suggested_backup_root });
  const own = (p, name) => M.busyFolders.includes(p) ? `${p.replace(/\\$/, "")}\\${name}` : p;
  function checkPair(d0, b0) {
    if (!/^[A-Za-z]:\\/.test(d0)) throw "اختر مسارًا كاملًا لـمجلد البيانات";
    if (!/^[A-Za-z]:\\/.test(b0)) throw "اختر مسارًا كاملًا لـمجلد النسخ الاحتياطية";
    const d = M.state === "needs_setup" ? own(d0, "CNSArch-Data") : d0, b = own(b0, "CNSArch-Backups");
    const n = s => s.toLowerCase().replace(/\\+$/, "");
    if (n(b).startsWith(n(d)) || n(d).startsWith(n(b))) throw "يجب أن يكون مجلد النسخ الاحتياطية منفصلًا عن مجلد البيانات، وليس داخله أو يحتويه";
    const w = [];
    if (drive(d) === "C") w.push("مجلد البيانات على قرص النظام C. إذا أُعيد تثبيت ويندوز أو تعطل القرص قد تضيع البيانات، فيُفضّل قرص آخر مثل D.");
    if (drive(d) && drive(d) === drive(b)) w.push("مجلد البيانات ومجلد النسخ الاحتياطية على نفس القرص. يُفضّل وضع النسخ على قرص آخر أو مجلد شبكة.");
    const existing = (M.existingDb || []).includes(d);
    if (M.state !== "needs_setup" && !existing) throw `لم يتم العثور على قاعدة بيانات البرنامج في ${d}. اختر المجلد الذي يحتوي على الملف «database.db»`;
    return { warnings: w, existing_database: existing, data_root: d, backup_root: b, adjusted: d !== d0 || b !== b0 };
  }
  const isCommon = pw => ["password", "12345678", "123456789", "qwerty"].includes(pw.toLowerCase().replace(/[^a-z]+$|[0-9]+$/g, "")) || /^(.)\1+$/.test(pw);
  function policyError(pw, user = "") {
    const p = M.policy;
    if ([...pw].length < p.min_length) return `كلمة المرور يجب أن تكون ${p.min_length} أحرف على الأقل`;
    if (p.require_upper && !/[A-Z]/.test(pw)) return "كلمة المرور يجب أن تحتوي على حرف إنجليزي كبير (A-Z)";
    if (p.require_lower && !/[a-z]/.test(pw)) return "كلمة المرور يجب أن تحتوي على حرف إنجليزي صغير (a-z)";
    if (p.require_digit && !/[0-9]/.test(pw)) return "كلمة المرور يجب أن تحتوي على رقم (0-9)";
    if (user.length >= 3 && pw.toLowerCase().includes(user.toLowerCase())) return "كلمة المرور يجب ألا تحتوي على اسم المستخدم";
    if (p.reject_common && isCommon(pw)) return "كلمة المرور سهلة التخمين، اختر غيرها";
    return "";
  }
  const ADMIN = ["dashboard.view", "employees.view", "documents.view", "users.manage", "users.assign_system_admin", "settings.manage", "backups.manage", "audit.view"];
  const account = name => ({ id: 1, username: name, role: "system_admin", is_master: true, is_base: name === M.base, must_change_password: Boolean(M.users[name]?.mustChange), permissions: ADMIN });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    convertFileSrc: p => p, transformCallback: () => Math.floor(Math.random() * 1e9),
    invoke: async (cmd, args = {}) => {
      M.calls.push({ cmd, args });
      switch (cmd) {
        case "cmd_get_startup_status": return status();
        case "cmd_check_setup_folders": return checkPair(args.dataRoot, args.backupRoot);
        case "cmd_complete_setup": { const r = checkPair(args.dataRoot, args.backupRoot); M.state = "ready"; M.data_root = r.data_root; M.backup_root = r.backup_root; return status(); }
        case "cmd_retry_data_folder": return M.retryOk ? (M.state = "ready", status()) : { ...status(), state: "data_missing", message: "ما زال مجلد البيانات غير متاح." };
        case "cmd_get_first_run_state": return { needs_admin: M.needsAdmin };
        case "cmd_get_password_policy": return M.policy;
        case "cmd_set_password_policy": M.policy = args.policy; return M.policy;
        case "cmd_complete_first_run": {
          if (!M.needsAdmin) throw UNAUTH;
          const { username, password, department_name, division_name } = args.data;
          const err = policyError(password, username); if (err) throw err;
          delete M.users.sysadmin; M.users[username] = { password, mustChange: false }; M.base = username;
          M.department = department_name; M.division = division_name; M.needsAdmin = false;
          M.recoveryCode = "K7QM-2XPA-9TRF-H4WD";
          return { user: account(username), recovery_code: M.recoveryCode };
        }
        case "cmd_get_public_company_config": case "cmd_get_company_config":
          return { company_name: "الشركة العامة لإدارة المطارات والملاحة الجوية", department_name: M.department, division_name: M.division, logo_path: null };
        case "cmd_login": {
          const key = args.username.trim().toLowerCase();
          if ((M.failures[key] || 0) >= M.policy.max_failures) throw lock(M.policy.lockout_minutes);
          const name = Object.keys(M.users).find(u => u.toLowerCase() === key);
          if (!name || M.users[name].password !== args.password) {
            const count = M.failures[key] = (M.failures[key] || 0) + 1;
            const left = M.policy.max_failures - count;
            if (left <= 0) throw lock(M.policy.lockout_minutes);
            if (left === 2) throw `${WRONG}. بقيت محاولتان قبل إيقاف الدخول 5 دقائق.`;
            if (left === 1) throw `${WRONG}. بقيت محاولة واحدة قبل إيقاف الدخول 5 دقائق.`;
            throw UNAUTH;
          }
          M.failures[key] = 0;
          return account(name);
        }
        case "cmd_change_password": {
          const name = Object.keys(M.users)[0];
          const err = policyError(args.newPassword, name); if (err) throw err;
          if (args.currentPassword === args.newPassword) throw "كلمة المرور الجديدة يجب أن تختلف عن الحالية";
          if (args.currentPassword !== M.users[name].password) throw UNAUTH;
          M.users[name] = { password: args.newPassword, mustChange: false };
          return account(name);
        }
        case "cmd_get_recovery_options": return { recovery_code: Boolean(M.recoveryCode), developer_unlock: M.unlock };
        case "cmd_get_recovery_status": return { exists: Boolean(M.recoveryCode), created_at: "2026-11-26 09:30", admin: M.base };
        case "cmd_regenerate_recovery_code": M.recoveryCode = "N8VB-3KQZ-7MHT-2CXE"; return M.recoveryCode;
        case "cmd_recover_admin_password": {
          if (args.code.replace(/[^A-Za-z0-9]/g, "").toUpperCase() !== M.recoveryCode.replace(/-/g, "")) throw "رمز الاستعادة غير صحيح";
          const err = policyError(args.newPassword, M.base); if (err) throw err;
          M.users[M.base] = { password: args.newPassword, mustChange: false };
          M.recoveryCode = "P3WX-8DKR-5QHN-ZT7A";
          return { username: M.base, recovery_code: M.recoveryCode };
        }
        case "cmd_new_unlock_challenge": return "CNS1-K7QMPX-3FA2-20261126";
        case "cmd_unlock_admin": throw "رمز الفتح غير صحيح. انسخه كما وصلك كاملًا.";
        case "cmd_list_users": return Object.keys(M.users).map((u, i) => ({ ...account(u), id: i + 1, created_at: "2026-11-26 09:30:00", trusted: true, disabled: false, last_login: null }));
        case "plugin:dialog|open": return M.pick ?? null;
        default: return cmd.startsWith("cmd_list_") ? [] : null;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
