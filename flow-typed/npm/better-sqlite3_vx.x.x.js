// flow-typed signature: 946429b216273f6ed9345df0294cfd25
// flow-typed version: <<STUB>>/better-sqlite3_v4.1.4/flow_v0.77.0

declare class bettersqlite3$Database {
  +memory: boolean;
  +readonly: boolean;
  +name: string;
  +open: boolean;
  +inTransaction: boolean;

  constructor(
    filename: string,
    options?: bettersqlite3$Database$ConstructorOptions
  ): void;
  prepare(source: string): bettersqlite3$Statement;
  exec(source: string): this;
  transaction(sources: $ReadOnlyArray<string>): bettersqlite3$Transaction;
  pragma(pragma: string, simplify?: boolean): any;
  checkpoint(databaseName?: string): this;
  register(fn: (...args: any[]) => any): void;
  register(
    options: bettersqlite3$Database$RegisterOptions,
    fn: (...args: any[]) => any
  ): void;
  close(): this;
  defaultSafeIntegers(toggleState?: boolean): this;

  static SqliteError: Class<bettersqlite3$SqliteError>;
}

export type bettersqlite3$Database$ConstructorOptions = {
  +memory?: boolean,
  +readonly?: boolean,
  +fileMustExist?: boolean,
};

export type bettersqlite3$Database$RegisterOptions = {
  +name?: string,
  +varargs?: boolean,
  +deterministic?: boolean,
  +safeIntegers?: boolean,
};

declare class bettersqlite3$Statement {
  +memory: boolean;
  +readonly: boolean;
  +name: string;
  +open: boolean;
  +inTransaction: boolean;

  run(...params: any[]): bettersqlite3$RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
  each(params: any, cb: (row: any) => void): void;
  each(cb: (row: any) => void): void;
  each(...params: any[]): void;
  pluck(toggleState?: boolean): this;
  bind(...params: any[]): this;
  safeIntegers(toggleState?: boolean): this;
}

declare class bettersqlite3$Transaction {
  +database: bettersqlite3$Database;
  +source: string;

  constructor(db: bettersqlite3$Database, sources: string[]): void;
  run(...params: any[]): bettersqlite3$RunResult;
  bind(...params: any[]): this;
  safeIntegers(toggleState?: boolean): this;
}

export interface bettersqlite3$RunResult {
  changes: number;
  // TODO: This is actually `Integer.IntLike` from npm/integer, but we
  // don't have those typedefs. For now, `number` is a good
  // approximation.
  lastInsertROWID: number;
}

declare class bettersqlite3$SqliteError extends Error {
  +code: string;
  constructor(message: string, code: string): void;
}

declare module "better-sqlite3" {
  declare export type Database = bettersqlite3$Database;
  declare export type Database$ConstructorOptions = bettersqlite3$Database$ConstructorOptions;
  declare export type Database$RegisterOptions = bettersqlite3$Database$RegisterOptions;
  declare export type Statement = bettersqlite3$Statement;
  declare export type Transaction = bettersqlite3$Transaction;
  declare export type RunResult = bettersqlite3$RunResult;
  declare export type SqliteError = bettersqlite3$SqliteError;
  declare module.exports: Class<bettersqlite3$Database>;
}
