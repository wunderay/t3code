use crate::{Error, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{path::Path, time::Duration};

pub fn open(path: &Path) -> Result<Connection> {
    if path != Path::new(":memory:")
        && let Some(parent) = path.parent()
    {
        std::fs::create_dir_all(parent).map_err(Error::internal)?;
    }
    let mut connection = Connection::open(path).map_err(Error::internal)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(Error::internal)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(Error::internal)?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(Error::internal)?;
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(Error::internal)?;
    if version > 1 {
        return Err(Error::conflict(
            "Supervisor database is newer than this executable",
        ));
    }
    let transaction = connection.transaction().map_err(Error::internal)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
         INSERT OR IGNORE INTO meta VALUES ('revision', 0), ('coverage', 0);
         CREATE TABLE IF NOT EXISTS documents (
            kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
            revision INTEGER NOT NULL, PRIMARY KEY(kind,id)
         );
         CREATE INDEX IF NOT EXISTS documents_revision ON documents(kind,revision,id);
         CREATE UNIQUE INDEX IF NOT EXISTS assignment_idempotency ON documents(json_extract(body,'$.idempotencyKey')) WHERE kind='assignment';
         CREATE UNIQUE INDEX IF NOT EXISTS reservation_identity ON documents(json_extract(body,'$.reservation.id')) WHERE kind='assignment';
         CREATE INDEX IF NOT EXISTS cards_state ON documents(kind,json_extract(body,'$.settled'),json_extract(body,'$.archived'),id);
         CREATE INDEX IF NOT EXISTS action_state ON documents(kind,json_extract(body,'$.status'),id);
         CREATE INDEX IF NOT EXISTS outcome_route ON documents(json_extract(body,'$.model'),json_extract(body,'$.effort'),json_extract(body,'$.rank')) WHERE kind='outcome';
         CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)));
         PRAGMA user_version=1;"
    ).map_err(Error::internal)?;
    crate::remote::migrate(&transaction)?;
    crate::events::migrate(&transaction)?;
    transaction.commit().map_err(Error::internal)?;
    Ok(connection)
}

pub fn revision(tx: &Transaction<'_>) -> Result<u64> {
    tx.query_row("SELECT value FROM meta WHERE key='revision'", [], |r| {
        r.get(0)
    })
    .map_err(Error::internal)
}

pub fn put<T: Serialize>(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
    value: &T,
    revision: u64,
) -> Result<()> {
    let body = serde_json::to_string(value).map_err(Error::internal)?;
    tx.execute(
        "INSERT INTO documents(kind,id,body,revision) VALUES (?1,?2,?3,?4)
         ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,revision=excluded.revision",
        params![kind, id, body, revision],
    )
    .map_err(Error::internal)?;
    tx.execute(
        "UPDATE meta SET value=MAX(value,?1) WHERE key='revision'",
        [revision],
    )
    .map_err(Error::internal)?;
    Ok(())
}

pub fn get<T: DeserializeOwned>(tx: &Transaction<'_>, kind: &str, id: &str) -> Result<Option<T>> {
    let body: Option<String> = tx
        .query_row(
            "SELECT body FROM documents WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(Error::internal)?;
    body.map(|s| serde_json::from_str(&s).map_err(Error::internal))
        .transpose()
}

pub fn required<T: DeserializeOwned>(tx: &Transaction<'_>, kind: &str, id: &str) -> Result<T> {
    get(tx, kind, id)?.ok_or_else(|| Error::not_found(format!("Unknown {kind}: {id}")))
}

pub fn list<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    filter: &str,
    after: &str,
    limit: usize,
) -> Result<Vec<T>> {
    let sql = format!(
        "SELECT body FROM documents WHERE kind=?1 AND id>?2 AND ({filter}) ORDER BY id LIMIT ?3"
    );
    let mut statement = tx.prepare(&sql).map_err(Error::internal)?;
    let rows = statement
        .query_map(params![kind, after, limit as u64], |r| {
            r.get::<_, String>(0)
        })
        .map_err(Error::internal)?;
    rows.map(|row| serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal))
        .collect()
}

/// Every row of a kind the filter matches, for a decision that must see all of them.
pub fn every<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    filter: &str,
) -> Result<Vec<T>> {
    list(tx, kind, filter, "", usize::MAX >> 1)
}

pub fn count(tx: &Transaction<'_>, kind: &str, filter: &str) -> Result<u64> {
    let sql = format!("SELECT COUNT(*) FROM documents WHERE kind=?1 AND ({filter})");
    tx.query_row(&sql, [kind], |r| r.get(0))
        .map_err(Error::internal)
}

pub fn remove(tx: &Transaction<'_>, kind: &str, id: &str, revision: u64) -> Result<()> {
    tx.execute(
        "DELETE FROM documents WHERE kind=?1 AND id=?2",
        params![kind, id],
    )
    .map_err(Error::internal)?;
    tx.execute(
        "UPDATE meta SET value=MAX(value,?1) WHERE key='revision'",
        [revision],
    )
    .map_err(Error::internal)?;
    Ok(())
}

// Display/context projections use chronology; ID-cursor history remains unchanged.
pub fn recent<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    limit: usize,
) -> Result<Vec<T>> {
    let mut statement = tx
        .prepare("SELECT body FROM documents WHERE kind=?1 ORDER BY revision DESC,id DESC LIMIT ?2")
        .map_err(Error::internal)?;
    let rows = statement
        .query_map(params![kind, limit as u64], |row| row.get::<_, String>(0))
        .map_err(Error::internal)?;
    rows.map(|row| serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal))
        .collect()
}
