//! Synthetic, isolated acceptance tests; never opens the user's database or documents.
use super::*;
use image::{DynamicImage, Rgb, RgbImage};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[test]
#[ignore = "Opt-in migration check; always operates on an isolated copy"]
fn database_snapshot_migration_is_idempotent() {
    let path = std::env::var("AUTOHR_VERIFY_DATABASE").expect("Set AUTOHR_VERIFY_DATABASE to a snapshot");
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("database.db");
    source.backup(rusqlite::DatabaseName::Main, &copy, None).unwrap();
    let conn = Connection::open(copy).unwrap();
    let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    let counts: Vec<i64> = tables.iter().map(|table| conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()).collect();
    db::initialize_test(&conn).unwrap();
    let migrated = snapshot(&conn);
    db::initialize_test(&conn).unwrap();
    assert_eq!(migrated, snapshot(&conn), "Migration must be idempotent");
    for (table, count) in tables.iter().zip(counts) {
        let after: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r|r.get(0)).unwrap();
        assert!(after >= count, "Migration removed rows from {table}");
    }
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r|r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
    assert!(!conn.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
}

fn snapshot(conn: &Connection) -> Vec<String> {
    let mut result = Vec::new();
    for table in [
        "employees",
        "employee_spouses",
        "employee_family_members",
        "employee_attachments",
        "general_docs",
        "general_doc_attachments",
        "outgoing_docs",
        "outgoing_doc_attachments",
        "document_metadata",
        "activity_log",
        "app_settings",
        "company_config",
    ] {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let count = stmt.column_count();
        result.extend(
            stmt.query_map([], |row| {
                Ok(format!(
                    "{table}: {:?}",
                    (0..count)
                        .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                        .collect::<Vec<_>>()
                ))
            })
            .unwrap()
            .map(Result::unwrap),
        );
    }
    result
}
fn files(root: &Path) -> Vec<(PathBuf, String)> {
    let mut result = Vec::new();
    if !root.exists() {
        return result;
    }
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.extend(files(&path));
        } else {
            result.push((
                path.clone(),
                hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
            ));
        }
    }
    result.sort();
    result
}
fn ctx(command: &str) -> ScanUploadContext {
    let doc = command.contains("doc_file");
    ScanUploadContext {
        employee_id: if doc || command.contains("company") {
            None
        } else {
            Some(1)
        },
        doc_id: if doc { Some(1) } else { None },
        side: if (command.contains("card_attachment") || command.contains("badge_attachment"))
            && !command.contains("ration")
        {
            Some("front".into())
        } else {
            None
        },
        member_index: if command.contains("family") {
            Some(0)
        } else {
            None
        },
        spouse_index: if command.contains("spouse") {
            Some(0)
        } else {
            None
        },
    }
}
fn prepared(source: &Path, target: Option<String>) -> scanner::ScanPreview {
    let input = scanner::prepare(
        "scanner-admin".into(),
        source,
        scanner::ScannerSettings {
            auto_detect: false,
            ..Default::default()
        },
        target,
    )
    .unwrap();
    scanner::render(
        "scanner-admin",
        &input.token,
        scanner::full_corners(input.width, input.height),
        0,
    )
    .unwrap();
    input
}
#[test]
fn attachment_endpoints_originals_reprocessing_permissions_and_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("Data");
    std::fs::create_dir(&data).unwrap();
    services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = Some(data.clone()));
    let conn = Connection::open_in_memory().unwrap();
    db::initialize_test(&conn).unwrap();
    db::initialize_test(&conn).unwrap();
    conn.execute("INSERT INTO users(username,password,role) VALUES('scanner-admin','unused','system_admin'),('scanner-viewer','unused','viewer')",[]).unwrap();
    conn.execute(
        "INSERT INTO employees(id,full_name,gender) VALUES(1,'Synthetic Scanner Test','male')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO employee_spouses(employee_id,sort_order,name) VALUES(1,0,'Synthetic Spouse')",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO employee_family_members(employee_id,sort_order,name) VALUES(1,0,'Synthetic Family')",[]).unwrap();
    conn.execute(
        "INSERT INTO general_docs(id,title) VALUES(1,'Synthetic Administrative Document')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO outgoing_docs(id,title) VALUES(1,'Synthetic Outgoing Document')",
        [],
    )
    .unwrap();
    let source = dir.path().join("processed.png");
    let image = DynamicImage::ImageRgb8(RgbImage::from_fn(120, 90, |x, y| {
        Rgb([(x * 2) as u8, (y * 2) as u8, 180])
    }));
    image.save(&source).unwrap();
    let original_bytes = std::fs::read(&source).unwrap();
    // Recovery deletes an interrupted attempt, but never an image referenced by committed metadata.
    let protected = "Files/GeneralDocs/1/11111111111111111111111111111111.jpg".to_string();
    let abandoned = "Files/GeneralDocs/1/22222222222222222222222222222222.jpg".to_string();
    std::fs::create_dir_all(data.join("Files/GeneralDocs/1")).unwrap();
    std::fs::write(data.join(&protected), b"committed sentinel").unwrap();
    std::fs::write(data.join(&abandoned), b"uncommitted sentinel").unwrap();
    conn.execute("INSERT INTO document_metadata(stored_path,original_name,mime_type,size_bytes) VALUES(?1,'synthetic.jpg','image/jpeg',18)",[&protected]).unwrap();
    scanner::register_pending_files(&conn, &[protected.clone(), abandoned.clone()]).unwrap();
    scanner::recover_pending_files(&conn).unwrap();
    assert_eq!(
        std::fs::read(data.join(&protected)).unwrap(),
        b"committed sentinel"
    );
    assert!(!data.join(&abandoned).exists());
    scanner::cleanup_metadata_file(&conn, &protected);
    // Legacy PNG association is stable, but the processed download must have a JPEG filename.
    let legacy = upload_general_doc_file(&conn, 1, source.to_str().unwrap()).unwrap();
    assert!(legacy.ends_with(".png"));
    let input = prepared(&source, Some(legacy.clone()));
    scanner::save_existing(&conn, "scanner-admin", &input.token, &legacy).unwrap();
    scanner::release("scanner-admin", &input.token).unwrap();
    assert!(scanner::export_name(&conn, &legacy)
        .unwrap()
        .ends_with(".jpg"));
    assert_eq!(std::fs::read(data.join(&legacy)).unwrap(), original_bytes);
    let exported = dir.path().join("exported.jpg");
    download_document(&conn, "scanner-admin", &legacy, exported.to_str().unwrap()).unwrap();
    assert!(files::validate_upload(
        exported.to_str().unwrap(),
        false,
        true,
        files::MAX_DOCUMENT_SIZE
    )
    .is_ok());
    for command in [
        "cmd_upload_attachment",
        "cmd_upload_employee_photo",
        "cmd_upload_national_card_attachment",
        "cmd_upload_residence_card_attachment",
        "cmd_upload_airport_badge_attachment",
        "cmd_upload_ministry_badge_attachment",
        "cmd_upload_family_national_card_attachment",
        "cmd_upload_spouse_national_card_attachment",
        "cmd_upload_passport_attachment",
        "cmd_upload_ration_card_attachment",
        "cmd_upload_general_doc_file",
        "cmd_upload_outgoing_doc_file",
        "cmd_upload_company_logo",
    ] {
        eprintln!("testing {command}");
        let input = prepared(&source, None);
        let state = snapshot(&conn);
        let disk = files(&data);
        assert!(
            scanner_upload(&conn, "scanner-viewer", &input.token, command, ctx(command)).is_err()
        );
        assert_eq!(snapshot(&conn), state);
        assert_eq!(files(&data), disk);
        let result =
            scanner_upload(&conn, "scanner-admin", &input.token, command, ctx(command)).unwrap();
        let path = result
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| result["logo_path"].as_str().unwrap().to_owned());
        scanner::release("scanner-admin", &input.token).unwrap();
        assert_eq!(
            std::fs::read(scanner::original_path(&conn, &path).unwrap()).unwrap(),
            original_bytes,
            "original preserved: {command}"
        );
        assert!(
            scanner::associated_path(&conn, "scanner-admin", &path, true).is_ok(),
            "association: {command}"
        );
        assert_eq!(
            scanner::load_image(&scanner::effective_path(&conn, &path).unwrap())
                .unwrap()
                .width(),
            120
        );
        let original = scanner::original_path(&conn, &path).unwrap();
        let input = prepared(&original, Some(path.clone()));
        let state = snapshot(&conn);
        let disk = files(&data);
        assert!(
            scanner::save_existing(&conn, "scanner-admin", &input.token, "Files/invalid.jpg")
                .is_err()
        );
        assert_eq!(snapshot(&conn), state);
        assert_eq!(files(&data), disk);
        // Mandatory Audit failure must leave the attachment, metadata and files unchanged.
        conn.execute_batch("CREATE TRIGGER fail_scanner_audit BEFORE INSERT ON activity_log WHEN NEW.action='PROCESS_DOCUMENT' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;").unwrap();
        assert!(scanner::save_existing(&conn, "scanner-admin", &input.token, &path).is_err());
        assert_eq!(snapshot(&conn), state, "audit rollback: {command}");
        assert_eq!(files(&data), disk);
        conn.execute_batch("DROP TRIGGER fail_scanner_audit")
            .unwrap();
        scanner::render(
            "scanner-admin",
            &input.token,
            scanner::full_corners(120, 90),
            90,
        )
        .unwrap();
        scanner::save_existing(&conn, "scanner-admin", &input.token, &path).unwrap();
        scanner::release("scanner-admin", &input.token).unwrap();
        assert_eq!(
            std::fs::read(scanner::original_path(&conn, &path).unwrap()).unwrap(),
            original_bytes
        );
        let effective =
            scanner::load_image(&scanner::effective_path(&conn, &path).unwrap()).unwrap();
        assert_eq!((effective.width(), effective.height()), (90, 120));
        // Existing association and original remain usable after reopening.
        assert!(scanner::associated_path(&conn, "scanner-admin", &path, true).is_ok());
        let state = snapshot(&conn);
        scanner::versions(&conn, "scanner-admin", &path).unwrap();
        assert_eq!(snapshot(&conn), state);
    }
    // Replacing an existing scanned card must defer deletion until commit, even at a later Audit failure.
    let input = prepared(&source, None);
    let state = snapshot(&conn);
    let disk = files(&data);
    conn.execute_batch("CREATE TRIGGER fail_upload_audit BEFORE INSERT ON activity_log WHEN NEW.action='UPLOAD_NATIONAL_CARD_ATTACHMENT' BEGIN SELECT RAISE(ABORT,'injected late audit failure'); END;").unwrap();
    assert!(scanner_upload(
        &conn,
        "scanner-admin",
        &input.token,
        "cmd_upload_national_card_attachment",
        ctx("cmd_upload_national_card_attachment")
    )
    .is_err());
    assert_eq!(snapshot(&conn), state);
    assert_eq!(files(&data), disk);
    conn.execute_batch("DROP TRIGGER fail_upload_audit")
        .unwrap();
    scanner::release("scanner-admin", &input.token).unwrap();
    // A failed database association is compensated on disk as well.
    let input = prepared(&source, None);
    let state = snapshot(&conn);
    let disk = files(&data);
    conn.execute_batch("CREATE TRIGGER fail_link BEFORE INSERT ON general_doc_attachments BEGIN SELECT RAISE(ABORT,'injected association failure'); END;").unwrap();
    assert!(scanner_upload(
        &conn,
        "scanner-admin",
        &input.token,
        "cmd_upload_general_doc_file",
        ctx("cmd_upload_general_doc_file")
    )
    .is_err());
    assert_eq!(snapshot(&conn), state);
    assert_eq!(files(&data), disk);
    conn.execute_batch("DROP TRIGGER fail_link").unwrap();
    scanner::release("scanner-admin", &input.token).unwrap();
    // Cancellation and unsupported types never mutate business state.
    let state = snapshot(&conn);
    let disk = files(&data);
    let input = prepared(&source, None);
    scanner::release("scanner-admin", &input.token).unwrap();
    assert_eq!(snapshot(&conn), state);
    assert_eq!(files(&data), disk);
    let pdf = dir.path().join("original.pdf");
    let bytes = b"%PDF-1.7\nsynthetic unchanged searchable layer";
    std::fs::write(&pdf, bytes).unwrap();
    let path = upload_general_doc_file(&conn, 1, pdf.to_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(data.join(path)).unwrap(), bytes);
    let mut config = scanner::ScannerSettings::default();
    config.quality = 1;
    assert!(scanner::set_settings(&conn, "scanner-admin", config).is_err());
    assert!(scanner::set_settings(&conn, "scanner-viewer", Default::default()).is_err());
    scanner::set_settings(
        &conn,
        "scanner-admin",
        scanner::ScannerSettings {
            auto_detect: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!scanner::settings(&conn).unwrap().auto_detect);
    // Explicit record deletion removes version metadata too, so a backup cannot retain dangling refs.
    delete_general_doc(&conn, 1, "scanner-admin").unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM document_metadata WHERE stored_path LIKE 'Files/GeneralDocs/1/%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(!data.join("Files/GeneralDocs/1").exists());
    services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = None);
}

#[test]
fn codecs_exif_and_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 48, Rgb([210, 220, 230])));
    for extension in ["jpg", "png", "webp"] {
        let path = dir.path().join(format!("synthetic.{extension}"));
        image.save(&path).unwrap();
        assert_eq!(scanner::load_image(&path).unwrap().width(), 64);
        assert!(files::validate_upload(
            path.to_str().unwrap(),
            false,
            true,
            files::MAX_DOCUMENT_SIZE
        )
        .is_ok());
    }
    // Minimal valid EXIF APP1 orientation=6; all fixtures are generated, no personal documents.
    let jpeg = dir.path().join("synthetic.jpg");
    let bytes = std::fs::read(&jpeg).unwrap();
    let mut exif =
        b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0".to_vec();
    let length = (exif.len() + 2) as u16;
    let mut oriented = vec![255, 216, 255, 225];
    oriented.extend(length.to_be_bytes());
    oriented.append(&mut exif);
    oriented.extend_from_slice(&bytes[2..]);
    std::fs::write(&jpeg, oriented).unwrap();
    let decoded = scanner::load_image(&jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (48, 64));
    let bad = dir.path().join("bad.png");
    std::fs::write(&bad, b"\x89PNG\r\n\x1a\nnot an image").unwrap();
    assert!(scanner::load_image(&bad).is_err());
    assert!(
        scanner::validate_corners(&[[f32::NAN, 0.], [2., 0.], [2., 2.], [0., 2.]], 64, 48).is_err()
    );
}

#[test]
fn personal_photo_delete_clears_only_photo_and_removes_file() {
    let dir = tempfile::tempdir().unwrap();
    services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = Some(dir.path().to_path_buf()));
    let conn = Connection::open_in_memory().unwrap();
    db::initialize_test(&conn).unwrap();
    conn.execute("INSERT INTO employees(id,full_name,gender) VALUES(1,'Synthetic','male'),(2,'Other','male')", []).unwrap();
    let source = dir.path().join("source.png");
    DynamicImage::ImageRgb8(RgbImage::new(20,20)).save(&source).unwrap();
    let photo = upload_employee_photo(&conn, 1, source.to_str().unwrap()).unwrap();
    let other = upload_employee_photo(&conn, 2, source.to_str().unwrap()).unwrap();
    assert!(dir.path().join(&photo).exists());
    files::delete_employee_photo(&conn, 1).unwrap();
    let value: Option<String> = conn.query_row("SELECT photo_path FROM employees WHERE id=1", [], |r|r.get(0)).unwrap();
    assert!(value.is_none());
    assert!(!dir.path().join(&photo).exists());
    assert!(dir.path().join(&other).exists());
    assert!(source.exists());
    files::delete_employee_photo(&conn, 1).unwrap();
    assert!(files::delete_employee_photo(&conn, 999).is_err());
    services::TEST_STORAGE_ROOT.with(|v| *v.borrow_mut() = None);
}
