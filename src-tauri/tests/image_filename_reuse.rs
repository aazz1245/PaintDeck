use anima_app::db::Db;
use rusqlite::Connection;
use serde_json::json;

#[test]
fn migrated_trash_does_not_claim_new_output_with_same_name() {
    let path = std::env::temp_dir().join(format!(
        "anima_filename_reuse_{}_{}.db",
        std::process::id(),
        rand::random::<u64>()
    ));
    {
        let con = Connection::open(&path).unwrap();
        con.execute_batch(
            "CREATE TABLE images (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               filename TEXT NOT NULL, subfolder TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'output',
               mode TEXT, prompt TEXT, negative TEXT, seed INTEGER, width INTEGER, height INTEGER,
               params TEXT, job TEXT, created REAL, fav INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
               idea TEXT, trashed REAL, UNIQUE(subfolder, filename));
             INSERT INTO images (id, filename, subfolder, type, seed, params, deleted)
             VALUES (70, 'txt2img_00069_.png', 'AnimaWeb', 'output', 111, '{}', 1);",
        )
        .unwrap();
    }
    let db = Db::open(&path).unwrap();
    let info = json!({"seed": 222});
    let id = db
        .add_image(
            "txt2img_00069_.png",
            "AnimaWeb",
            "output",
            &info,
            &json!({"seed": 222}),
            Some("new-job"),
        )
        .unwrap();
    assert_ne!(id, 70);
    assert_eq!(db.image(70).unwrap().unwrap()["deleted"], 1);
    assert_eq!(db.image(id).unwrap().unwrap()["seed"], 222);
    assert_eq!(db.image(id).unwrap().unwrap()["job"], "new-job");
    assert_eq!(
        db.add_image(
            "txt2img_00069_.png",
            "AnimaWeb",
            "output",
            &info,
            &json!({}),
            None,
        )
        .unwrap(),
        id
    );
    assert_eq!(db.active_files().unwrap().len(), 1);
    assert!(db
        .run("UPDATE images SET deleted=0 WHERE id=70", [])
        .is_err());
    assert_eq!(db.image(70).unwrap().unwrap()["deleted"], 1);
    drop(db);
    let _ = std::fs::remove_file(path);
}
