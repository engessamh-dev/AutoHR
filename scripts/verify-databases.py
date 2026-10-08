"""Read-only database/attachment audit. Outputs counts, never employee records."""
import collections
import datetime
import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "verification"
OUT.mkdir(exist_ok=True)
reference = sqlite3.connect(":memory:")
reference.executescript((ROOT / "database/schema.sql").read_text(encoding="utf-8"))
expected = {r[0]: {c[1] for c in reference.execute(f'PRAGMA table_info("{r[0]}")')}
            for r in reference.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}

def audit(label, path, data):
    result = {"database": label, "exists": path.is_file(), "read_only": True}
    if not path.is_file():
        return result
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    result["integrity_check"] = [r[0] for r in conn.execute("PRAGMA integrity_check")]
    fk = list(conn.execute("PRAGMA foreign_key_check"))
    result["foreign_key_violations"] = len(fk)
    result["foreign_key_violation_tables"] = dict(collections.Counter(r[0] for r in fk))
    tables = {r[0]: [c[1] for c in conn.execute(f'PRAGMA table_info("{r[0]}")')]
              for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    result["rows"] = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    result["missing_tables"] = sorted(set(expected) - set(tables))
    result["missing_columns"] = {t: sorted(cols - set(tables.get(t, []))) for t, cols in expected.items() if cols - set(tables.get(t, []))}
    result["pending_scanner_columns"] = sorted({"original_path", "processed_path", "parent_path"} - set(tables.get("document_metadata", [])))
    result["extra_tables"] = sorted(set(tables) - set(expected))
    refs = set()
    metadata_refs = set()
    invalid_json = collections.Counter()
    def collect(value):
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str): refs.add(item)
                else: collect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key.endswith("_path") and not key.endswith("_full_path") and isinstance(item, str) and item: refs.add(item)
                elif isinstance(item, (dict, list)): collect(item)
    for table, cols in tables.items():
        if table in ("backup_log", "activity_log", "app_settings"): continue
        for col in cols:
            if col.endswith("_path") and col != "parent_path":
                for (value,) in conn.execute(f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL'):
                    if isinstance(value, str) and value:
                        (metadata_refs if table == "document_metadata" else refs).add(value)
            elif col in ("attachment_paths", "passport_attachment_paths", "ration_card_attachment_paths", "spouses", "family_members", "vehicles"):
                for (value,) in conn.execute(f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL'):
                    try:
                        parsed = json.loads(value)
                        if not isinstance(parsed, list): raise ValueError("Expected array")
                        if col.endswith("_paths") and not all(isinstance(p, str) for p in parsed): raise ValueError("Invalid path array")
                        if col != "vehicles": collect(parsed)
                    except (ValueError, TypeError): invalid_json[f"{table}.{col}"] += 1
    result["invalid_json"] = dict(invalid_json)
    unsafe, missing, empty = [], [], []
    for value in sorted(refs):
        relative = Path(value)
        candidate = (data / relative).resolve()
        if relative.is_absolute() or ".." in relative.parts or not candidate.is_relative_to(data.resolve()):
            unsafe.append(value)
        elif not candidate.is_file(): missing.append(value)
        elif candidate.stat().st_size == 0: empty.append(value)
    result["metadata_files_missing"] = sum(not (data / value).is_file() for value in metadata_refs)
    result["referenced_files"] = len(refs)
    result["unsafe_paths"] = len(unsafe)
    result["missing_files"] = len(missing)
    result["empty_files"] = len(empty)
    # Detailed file paths stay in local artifacts, not console/chat.
    details = {"unsafe": unsafe, "missing": missing, "empty": empty, "metadata_missing": sorted(value for value in metadata_refs if not (data / value).is_file())}
    (OUT / f"{label}-attachment-findings.json").write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
    disk = {p.relative_to(data).as_posix() for p in data.rglob("*") if p.is_file()} if data.is_dir() else set()
    result["files_on_disk"] = len(disk)
    result["files_without_database_reference"] = len(disk - {v.replace("\\", "/") for v in refs | metadata_refs})
    if "users" in tables:
        result["user_roles"] = dict(conn.execute("SELECT role,COUNT(*) FROM users GROUP BY role"))
        result["invalid_roles"] = conn.execute("SELECT COUNT(*) FROM users WHERE role NOT IN ('system_admin','archive_admin','archive_officer','viewer')").fetchone()[0]
        result["password_formats"] = dict(collections.Counter("bcrypt" if str(v).startswith(("$2a$", "$2b$", "$2y$")) else "legacy_sha256" if len(str(v)) == 64 else "other" for (v,) in conn.execute("SELECT password FROM users")))
    result["journal_mode"] = conn.execute("PRAGMA journal_mode").fetchone()[0]
    conn.rollback()
    conn.close()
    return result

base = Path(os.environ["APPDATA"])
results = [audit(label, folder / "database.db", folder / "Data") for label, folder in
           [("production", base / "CNSArch"), ("development", base / "CNSArch-Development")]]
results.append(audit("bundled", ROOT / "src-tauri/resources/database.db", ROOT / "src-tauri/resources/Data"))
report = {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "databases": results}
(OUT / "database-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=True, indent=2))

# Stale metadata and unreferenced files are reported for review, never deleted.
import sys
sys.exit(1 if any(r.get("integrity_check") != ["ok"] or r.get("foreign_key_violations") or r.get("missing_tables") or r.get("missing_columns") or r.get("pending_scanner_columns") or r.get("invalid_json") or r.get("unsafe_paths") or r.get("missing_files") or r.get("empty_files") for r in results) else 0)
