// @flow

import type Database from "better-sqlite3";
import stringify from "json-stable-stringify";

import dedent from "../util/dedent";
import * as Schema from "./schema";

/**
 * A local mirror of a subset of a GraphQL database.
 */
export class Mirror {
  +_db: Database;
  +_schema: Schema.Schema;

  /**
   * Create a GraphQL mirror using the given database connection and
   * GraphQL schema.
   *
   * The connection must be to a database that either (a) is empty and
   * unused, or (b) has been previously used for a GraphQL mirror with
   * an identical GraphQL schema. The database attached to the
   * connection must not be modified by any other clients. In other
   * words, passing a connection to this constructor entails transferring
   * ownership of the attached database to this module.
   *
   * If the database attached to the connection has been used with an
   * incompatible GraphQL schema or an outdated version of this module,
   * an error will be thrown and the database will remain unmodified.
   */
  constructor(db: Database, schema: Schema.Schema): void {
    if (db == null) throw new Error("db: " + String(db));
    if (schema == null) throw new Error("schema: " + String(schema));
    this._db = db;
    this._schema = schema;
    this._initialize();
  }

  _initialize() {
    const blob = stringify({version: "0.1.0", schema: this._schema});
    const db = this._db;
    _inTransaction(db, () => {
      // We store the metadata in a singleton table `meta`, whose unique row
      // has primary key `0`. Only the first ever insert will succeed; we
      // are locked into the first schema.
      db.prepare(
        dedent`\
          CREATE TABLE IF NOT EXISTS meta (
            zero INTEGER PRIMARY KEY,
            schema TEXT NOT NULL
          )
        `
      ).run();

      const existingBlob: string | void = db
        .prepare("SELECT schema FROM meta")
        .pluck()
        .get();
      if (existingBlob === blob) {
        // Already set up; nothing to do.
        return;
      } else if (existingBlob !== undefined) {
        throw new Error(
          "Database already populated with incompatible schema or version"
        );
      }
      db.prepare("INSERT INTO meta (zero, schema) VALUES (0, ?)").run(blob);

      // Create structural tables, which are independent of the schema.
      const structuralTables = [
        // Time is stored in milliseconds since 1970-01-01T00:00Z, with
        // ECMAScript semantics (leap seconds ignored, exactly 86.4M ms
        // per day, etc.).
        //
        // We use milliseconds rather than seconds because (a) this
        // simplifies JavaScript interop to a simple `+new Date()` and
        // `new Date(value)`, and (b) this avoids a Year 2038 problem by
        // surfacing >32-bit values immediately. (We have over 200,000
        // years before the number of milliseconds since epoch is more
        // than `Number.MAX_SAFE_INTEGER`.)
        dedent`\
          CREATE TABLE updates (
              rowid INTEGER PRIMARY KEY,
              time_epoch_millis INTEGER NOT NULL
          )
        `,
        dedent`\
          CREATE TABLE objects (
              id TEXT NOT NULL PRIMARY KEY,
              last_update INTEGER,
              typename TEXT NOT NULL,
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE TABLE links (
              rowid INTEGER PRIMARY KEY,
              parent_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              child_id TEXT,
              UNIQUE(parent_id, fieldname),
              FOREIGN KEY(parent_id) REFERENCES objects(id),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_links__parent_id__fieldname
          ON links (parent_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connections (
              rowid INTEGER PRIMARY KEY,
              object_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              last_update INTEGER,
              total_count INTEGER,  -- NULL iff never updated
              has_next_page BOOLEAN,  -- NULL iff never updated
              -- The end cursor may be NULL if no items are in the connection;
              -- this is a consequence of GraphQL and the Relay pagination spec.
              -- (It may also be NULL if the connection was never updated.)
              end_cursor TEXT,
              UNIQUE(object_id, fieldname),
              FOREIGN KEY(object_id) REFERENCES objects(id),
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_connections__object_id__fieldname
          ON connections (object_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connection_entries (
              rowid INTEGER PRIMARY KEY,
              connection_id INTEGER NOT NULL,
              idx INTEGER NOT NULL,  -- impose an ordering
              child_id TEXT NOT NULL,
              UNIQUE(connection_id, idx),
              FOREIGN KEY(connection_id) REFERENCES connections(rowid),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE INDEX idx_connection_entries__connection_id
          ON connection_entries (connection_id)
        `,
      ];
      for (const sql of structuralTables) {
        db.prepare(sql).run();
      }

      // Create own-data tables, which depend on the schema.
      const schema = this._schema;
      for (const typename of Object.keys(schema)) {
        const nodeType = schema[typename];
        switch (nodeType.type) {
          case "UNION":
            // Unions exist at the type level only; they have no physical
            // representation.
            break;
          case "OBJECT": {
            if (!isSqlSafe(typename)) {
              throw new Error("invalid object type name: " + typename);
            }
            const primitiveFieldNames: Schema.Fieldname[] = [];
            for (const fieldname of Object.keys(nodeType.fields)) {
              const field = nodeType.fields[fieldname];
              switch (field.type) {
                case "ID": // handled separately
                  break;
                case "NODE": // goes in `links` table
                  break;
                case "CONNECTION": // goes in `connections` table
                  break;
                case "PRIMITIVE":
                  if (!isSqlSafe(fieldname)) {
                    throw new Error("invalid field name: " + fieldname);
                  }
                  primitiveFieldNames.push(fieldname);
                  break;
                // istanbul ignore next
                default:
                  throw new Error((field.type: empty));
              }
            }
            const tableName = `"data_${typename}"`;
            const tableSpec = [
              "id TEXT NOT NULL PRIMARY KEY",
              ...primitiveFieldNames.map((fieldname) => `"${fieldname}"`),
              "FOREIGN KEY(id) REFERENCES objects(id)",
            ].join(", ");
            db.prepare(`CREATE TABLE ${tableName} (${tableSpec})`).run();
            break;
          }
          // istanbul ignore next
          default:
            throw new Error((nodeType.type: empty));
        }
      }
    });
  }

  /**
   * Register a new update, representing one communication with the
   * remote server. A unique ID will be created and returned.
   */
  _createUpdate(updateTimestamp: Date): UpdateId {
    return this._db
      .prepare("INSERT INTO updates (time_epoch_millis) VALUES (?)")
      .run(+updateTimestamp).lastInsertROWID;
  }

  /**
   * Inform the GraphQL mirror of the existence of an object. The
   * object's name and concrete type must be specified. The concrete
   * type must be an OBJECT type in the GraphQL schema.
   *
   * If the object has previously been registered with the same type, no
   * action is taken and no error is raised. If the object has
   * previously been registered with a different type, an error is
   * thrown, and the database is left unchanged.
   */
  registerObject(object: {|+typename: Schema.Typename, +id: Schema.ObjectId|}) {
    _inTransaction(this._db, () => {
      this._nontransactionallyRegisterObject(object);
    });
  }

  /**
   * As `registerObject`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyRegisterObject(object: {|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}) {
    const db = this._db;
    const {typename, id} = object;

    const existingTypename = db
      .prepare("SELECT typename FROM objects WHERE id = ?")
      .pluck()
      .get(id);
    if (existingTypename === typename) {
      // Already registered; nothing to do.
      return;
    } else if (existingTypename != null) {
      const stringify = JSON.stringify;
      throw new Error(
        `Inconsistent type for ID ${stringify(id)}: ` +
          `expected ${stringify(existingTypename)}, got ${stringify(typename)}`
      );
    }

    const nodeType = this._schema[typename];
    if (nodeType == null) {
      throw new Error("Unknown type: " + JSON.stringify(typename));
    }
    switch (nodeType.type) {
      case "UNION":
        throw new Error(
          "Cannot add object of union type " +
            JSON.stringify(typename) +
            "; must specify the clause of the union"
        );
      case "OBJECT": {
        this._db
          .prepare(
            dedent`\
              INSERT INTO objects (id, last_update, typename)
              VALUES (:id, NULL, :typename)
            `
          )
          .run({id, typename});
        const addConnection = this._db.prepare(
          // These fields are initialized to NULL because there has
          // been no update and so they have no meaningful values:
          // last_update, total_count, has_next_page, end_cursor.
          dedent`\
            INSERT INTO connections (object_id, fieldname)
            VALUES (:id, :fieldname)
          `
        );
        for (const fieldname of Object.keys(nodeType.fields)) {
          const field = nodeType.fields[fieldname];
          switch (field.type) {
            case "ID":
              break;
            case "PRIMITIVE":
              break;
            case "NODE":
              break;
            case "CONNECTION": {
              addConnection.run({id, fieldname});
              break;
            }
            // istanbul ignore next
            default:
              throw new Error((field.type: empty));
          }
        }
        break;
      }
      // istanbul ignore next
      default:
        throw new Error((nodeType.type: empty));
    }
  }

  /**
   * Find objects and connections that have are not known to be
   * up-to-date as of the provided date.
   *
   * An object is up-to-date if its own data has been loaded at least as
   * recently as the provided date.
   *
   * A connection is up-to-date if it has been fetched at least as
   * recently as the provided date, and at the time of fetching there
   * were no more pages.
   */
  findOutdated(
    since: Date
  ): {|
    +objects: $ReadOnlyArray<{|
      +typename: Schema.Typename,
      +id: Schema.ObjectId,
    |}>,
    +connections: $ReadOnlyArray<{|
      +typename: Schema.Typename,
      +id: Schema.ObjectId,
      +fieldname: Schema.Fieldname,
      +endCursor: EndCursor,
    |}>,
  |} {
    const db = this._db;
    return _inTransaction(db, () => {
      const objects = db
        .prepare(
          dedent`\
            SELECT typename, id
            FROM objects
            LEFT OUTER JOIN updates ON objects.last_update = updates.rowid
            WHERE objects.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since});
      const connections = db
        .prepare(
          dedent`
            SELECT
              objects.typename,
              objects.id,
              connections.fieldname,
              connections.end_cursor AS endCursor
            FROM objects
            JOIN connections ON objects.id = connections.object_id
            LEFT OUTER JOIN updates ON objects.last_update = updates.rowid
            WHERE connections.has_next_page
            OR connections.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since});
      return {objects, connections};
    });
  }
}

export opaque type UpdateId = number;

/**
 * An `endCursor` of a GraphQL `pageInfo` object, denoting where the
 * cursor should continue reading the next page. This is `null` when the
 * cursor is at the beginning of the connection (i.e., when the
 * connection is empty, or when `first: 0` is provided).
 */
type EndCursor = string | null;

/**
 * Execute a function inside a database transaction.
 *
 * The database must not be in a transaction. A new transaction will be
 * entered, and then the callback will be invoked.
 *
 * If the callback completes normally, then its return value is passed
 * up to the caller, and the currently active transaction (if any) is
 * committed.
 *
 * If the callback throws an error, then the error is propagated to the
 * caller, and the currently active transaction (if any) is rolled back.
 *
 * Note that the callback may choose to commit or roll back the
 * transaction before returning or throwing an error. Conversely, note
 * that if the callback commits the transaction, and then begins a new
 * transaction but does not end it, then this function will commit the
 * new transaction if the callback returns (or roll it back if it
 * throws).
 */
export function _inTransaction<R>(db: Database, fn: () => R): R {
  if (db.inTransaction) {
    throw new Error("already in transaction");
  }
  try {
    db.prepare("BEGIN").run();
    const result = fn();
    if (db.inTransaction) {
      db.prepare("COMMIT").run();
    }
    return result;
  } finally {
    if (db.inTransaction) {
      db.prepare("ROLLBACK").run();
    }
  }
}

/*
 * In some cases, we need to interpolate user input in SQL queries in
 * positions that do not allow bound variables in prepared statements
 * (e.g., table and column names). In these cases, we manually sanitize.
 *
 * If this function returns `true`, then its argument may be safely
 * included in a SQL identifier. If it returns `false`, then no such
 * guarantee is made (this function is overly conservative, so it is
 * possible that the argument may in fact be safe).
 *
 * For instance, the function will return `true` if passed "col", but
 * will return `false` if passed "'); DROP TABLE objects; --".
 */
function isSqlSafe(token) {
  return !token.match(/[^A-Za-z0-9_]/);
}
