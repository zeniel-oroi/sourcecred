// @flow

import type Database from "better-sqlite3";
import stringify from "json-stable-stringify";

import dedent from "../util/dedent";
import * as Schema from "./schema";
import * as Queries from "./queries";

/**
 * A local mirror of a subset of a GraphQL database.
 */
/*
 * NOTE(perf): The implementation of this class is not particularly
 * optimized. In particular, when we interact with SQLite, we compile
 * our prepared statements many times over the lifespan of an
 * instance. It may be beneficial to precompile them at instance
 * construction time.
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
    // The following version number must be updated if there is any
    // change to the way in which a GraphQL schema is mapped to a SQL
    // schema or the way in which the resulting SQL schema is
    // interpreted. If you've made a change and you're not sure whether
    // it requires bumping the version, bump it: requiring some extra
    // one-time cache resets is okay; doing the wrong thing is not.
    const blob = stringify({version: "MIRROR_v1", schema: this._schema});
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

  /**
   * Create a GraphQL selection set required to identify the typename
   * and ID for an object. This is the minimal information required to
   * register an object in our database, so we query this information
   * whenever we find a reference to an object that we want to traverse
   * later.
   *
   * The resulting GraphQL should be embedded in any node context. For
   * instance, it might replace the `?` in any of the following queries:
   *
   *     repository(owner: "foo", name: "bar") { ? }
   *
   *     repository(owner: "foo", name: "bar") {
   *       issues(first: 1) {
   *         nodes { ? }
   *       }
   *     }
   *
   *     nodes(ids: ["baz", "quux"]) { ? }
   *
   * The result of this query has type `NodeFieldResult`.
   */
  _queryShallow(): Queries.Selection[] {
    const b = Queries.build;
    return [b.field("__typename"), b.field("id")];
  }

  /**
   * Get the current value of the end cursor on a connection, or
   * `undefined` if the object has never been fetched. If no object by
   * the given ID is known, or the object does not have a connection of
   * the given name, then an error is thrown.
   *
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`.
   */
  _getEndCursor(
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname
  ): EndCursor | void {
    const result: {|
      +initialized: 0 | 1,
      +endCursor: string | null,
    |} | void = this._db
      .prepare(
        dedent`\
          SELECT
            last_update IS NOT NULL AS initialized,
            end_cursor AS endCursor
          FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      // No need to worry about corruption in the form of multiple
      // matches: there is a UNIQUE(object_id, fieldname) constraint.
      .get({objectId, fieldname});
    if (result === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    return result.initialized ? result.endCursor : undefined;
  }

  /**
   * Create a GraphQL selection set to fetch elements from a collection.
   * If the connection has been queried before and you wish to fetch new
   * elements, use an appropriate end cursor. Use `undefined` otherwise.
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`. Note that these semantics are compatible with the
   * return value of `_getEndCursor`.
   *
   * If an end cursor for a particular node's connection was specified,
   * then the resulting GraphQL should be embedded in the context of
   * that node. For instance, if repository "foo/bar" has ID "baz" and
   * an end cursor of "c000" on its "issues" connection, then the
   * GraphQL emitted by `_queryConnection("issues", "c000")` might
   * replace the `?` in the following query:
   *
   *     node(id: "baz") { ? }
   *
   * If no end cursor was specified, then the resulting GraphQL may be
   * embedded in the context of _any_ node with a connection of the
   * appropriate fieldname. For instance, `_queryConnection("issues")`
   * emits GraphQL that may replace the `?` in either of the following
   * queries:
   *
   *     node(id: "baz") { ? }  # where "baz" is a repository ID
   *     repository(owner: "foo", name: "bar") { ? }
   *
   * Note, however, that this query will fetch nodes from the _start_ of
   * the connection. It would be wrong to append these results onto an
   * connection for which we have already fetched data.
   *
   * The result of this query has type `ConnectionFieldResult`.
   *
   * See: `_getEndCursor`.
   * See: `_updateConnection`.
   */
  _queryConnection(
    fieldname: Schema.Fieldname,
    endCursor: EndCursor | void,
    connectionPageSize: number = 100
  ): Queries.Selection[] {
    const b = Queries.build;
    const connectionArguments: Queries.Arguments = {
      first: b.literal(connectionPageSize),
    };
    if (endCursor !== undefined) {
      connectionArguments.after = b.literal(endCursor);
    }
    return [
      b.field(fieldname, connectionArguments, [
        b.field("totalCount"),
        b.field("pageInfo", {}, [b.field("endCursor"), b.field("hasNextPage")]),
        b.field("nodes", {}, this._queryShallow()),
      ]),
    ];
  }

  /**
   * Ingest new entries in a connection on an existing object.
   *
   * The connection's last update will be set to the given value, which
   * must be an existing update lest an error be thrown.
   *
   * If the object does not exist or does not have a connection by the
   * given name, an error will be thrown.
   *
   * See: `_queryConnection`.
   * See: `_createUpdate`.
   */
  _updateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyUpdateConnection(
        updateId,
        objectId,
        fieldname,
        queryResult
      );
    });
  }

  /**
   * As `_updateConnection`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyUpdateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    const db = this._db;
    const connectionId: number = this._db
      .prepare(
        dedent`\
          SELECT rowid FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      .pluck()
      .get({objectId, fieldname});
    // There is a UNIQUE(object_id, fieldname) constraint, so we don't
    // have to worry about pollution due to duplicates. But it's
    // possible that no such connection exists, indicating that the
    // object has not been registered. This is an error.
    if (connectionId === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    db.prepare(
      dedent`\
          UPDATE connections
          SET
            last_update = :updateId,
            total_count = :totalCount,
            has_next_page = :hasNextPage,
            end_cursor = :endCursor
          WHERE rowid = :connectionId
        `
    ).run({
      updateId,
      totalCount: queryResult.totalCount,
      hasNextPage: +queryResult.pageInfo.hasNextPage,
      endCursor: queryResult.pageInfo.endCursor,
      connectionId,
    });
    let nextIndex: number = db
      .prepare(
        dedent`\
            SELECT IFNULL(MAX(idx), 0) + 1 FROM connection_entries
            WHERE connection_id = :connectionId
          `
      )
      .pluck()
      .get({connectionId});
    const addEntry = db.prepare(
      dedent`\
        INSERT INTO connection_entries
        (connection_id, idx, child_id)
        VALUES (:connectionId, :idx, :childId)
      `
    );
    for (const node of queryResult.nodes) {
      const childObject = {typename: node.__typename, id: node.id};
      this._nontransactionallyRegisterObject(childObject);
      addEntry.run({connectionId, idx: nextIndex++, childId: childObject.id});
    }
  }
}

type UpdateId = number;

/**
 * An `endCursor` of a GraphQL `pageInfo` object, denoting where the
 * cursor should continue reading the next page. This is `null` when the
 * cursor is at the beginning of the connection (i.e., when the
 * connection is empty, or when `first: 0` is provided).
 */
type EndCursor = string | null;

type NodeFieldResult = {|
  +__typename: Schema.Typename,
  +id: Schema.ObjectId,
|};
type ConnectionFieldResult = {|
  +totalCount: number,
  +pageInfo: {|+hasNextPage: boolean, +endCursor: string | null|},
  +nodes: $ReadOnlyArray<NodeFieldResult>,
|};

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
