/**
 * Jest mock for `expo-sqlite`.
 *
 * The repo tests in `src/lib/db/__tests__` exercise SQL behaviour
 * against this in-memory shim. Tests that touch SQLite indirectly
 * (e.g. `usePortfolio` reading from the `tx` repo with no rows) get
 * a fresh empty database per test file because the singleton in
 * `db.ts` rebuilds on `__setDbForTests(null)`.
 *
 * The shim only implements the slice of `expo-sqlite`'s API our
 * production code uses:
 *   - openDatabaseAsync(name) → SQLiteDatabase
 *   - db.execAsync(sql)
 *   - db.getAllAsync(sql, params?)
 *   - db.getFirstAsync(sql, params?)
 *   - db.runAsync(sql, params?)
 *   - db.prepareAsync(sql) → statement.executeAsync(params), .finalizeAsync()
 *   - db.withTransactionAsync(fn)
 *
 * The SQL parser is hand-rolled and supports just the dialect the
 * repos emit. Unsupported SQL throws so a future repo addition is
 * forced to extend the mock rather than silently passing.
 */

type Row = Record<string, unknown>;

interface TableState {
  primaryKey: string[];
  rows: Row[];
}

interface DatabaseState {
  tables: Map<string, TableState>;
}

function emptyDb(): DatabaseState {
  return { tables: new Map() };
}

function parsePrimaryKey(ddl: string): string[] {
  const match = ddl.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
  if (match) return match[1].split(',').map((s) => s.trim());
  // Inline PRIMARY KEY on a single column. Permissive on the type
  // declaration so e.g. `scope TEXT NOT NULL PRIMARY KEY` (the
  // sync_state shape) matches just as well as `id INTEGER PRIMARY KEY`.
  // Non-greedy + `[^,]` keeps the match scoped to a single column
  // definition.
  const inline = ddl.match(/(\w+)\s+[^,]*?PRIMARY KEY/i);
  if (inline) return [inline[1]];
  return [];
}

function parseColumnsAndValues(sql: string): { table: string; columns: string[]; valueCount: number } | null {
  const match = sql.match(
    /INSERT(?:\s+OR\s+IGNORE|\s+OR\s+REPLACE)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
  );
  if (!match) return null;
  const table = match[1];
  const columns = match[2].split(',').map((s) => s.trim());
  const valueCount = match[3].split(',').length;
  return { table, columns, valueCount };
}

function rowKey(row: Row, pk: string[]): string {
  return pk.map((c) => String(row[c])).join('');
}

function applyOrderBy(rows: Row[], sql: string): Row[] {
  const match = sql.match(/ORDER\s+BY\s+(\w+)\s*(ASC|DESC)?/i);
  if (!match) return rows;
  const col = match[1];
  const dir = (match[2] ?? 'ASC').toUpperCase();
  const sorted = [...rows].sort((a, b) => {
    const av = a[col] as string | number;
    const bv = b[col] as string | number;
    if (av < bv) return dir === 'ASC' ? -1 : 1;
    if (av > bv) return dir === 'ASC' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function applyLimit(rows: Row[], sql: string): Row[] {
  const match = sql.match(/LIMIT\s+(\d+)/i);
  if (!match) return rows;
  return rows.slice(0, Number(match[1]));
}

function applyWhere(rows: Row[], sql: string, params: unknown[]): Row[] {
  const whereMatch = sql.match(/WHERE\s+(.+?)(\s+ORDER\s+BY|\s+LIMIT|$)/i);
  if (!whereMatch) return rows;
  const where = whereMatch[1].trim();

  // Single-column equality / comparison with bound params (?).
  let i = 0;
  return rows.filter((row) => {
    let localIndex = 0;
    return where.split(/\s+AND\s+/i).every((clause) => {
      const inMatch = clause.match(/(\w+)\s+IN\s*\(([^)]+)\)/i);
      if (inMatch) {
        const col = inMatch[1];
        const placeholders = inMatch[2].split(',').map((p) => p.trim());
        const values = placeholders.map((p) => {
          if (p === '?') return params[i + localIndex++];
          return p;
        });
        return values.includes(row[col]);
      }
      const cmpMatch = clause.match(/(\w+)\s*(>=|<=|=|<|>)\s*\?/);
      if (cmpMatch) {
        const col = cmpMatch[1];
        const op = cmpMatch[2];
        const value = params[i + localIndex++];
        const cell = row[col] as string | number;
        if (op === '=') return cell === value;
        if (op === '>=') return cell >= (value as string | number);
        if (op === '<=') return cell <= (value as string | number);
        if (op === '>') return cell > (value as string | number);
        if (op === '<') return cell < (value as string | number);
      }
      return true;
    });
  });
}

function makeDb(): unknown {
  let state = emptyDb();
  const exec = async (sql: string): Promise<void> => {
    const create = sql.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]+)\)/i);
    if (create) {
      const table = create[1];
      if (!state.tables.has(table)) {
        state.tables.set(table, { primaryKey: parsePrimaryKey(create[2]), rows: [] });
      }
      return;
    }
    if (/^\s*CREATE\s+INDEX/i.test(sql)) return; // no-op
    if (/^\s*PRAGMA/i.test(sql)) return;
    const drop = sql.match(/DROP TABLE(?:\s+IF EXISTS)?\s+(\w+)/i);
    if (drop) {
      state.tables.delete(drop[1]);
      return;
    }
    const del = sql.match(/^\s*DELETE\s+FROM\s+(\w+)/i);
    if (del) {
      const t = state.tables.get(del[1]);
      if (t) t.rows = [];
      return;
    }
    throw new Error(`Unsupported execAsync SQL: ${sql}`);
  };

  const getAll = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const select = sql.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
    if (!select) throw new Error(`Unsupported getAllAsync SQL: ${sql}`);
    const table = select[2];
    const cols = select[1].split(',').map((s) => s.trim());
    const tableState = state.tables.get(table);
    if (!tableState) return [];
    let rows = applyWhere(tableState.rows, sql, params);
    rows = applyOrderBy(rows, sql);
    rows = applyLimit(rows, sql);
    const projected = rows.map((r): Row => {
      if (cols.length === 1 && cols[0] === '*') return r;
      const out: Row = {};
      for (const c of cols) {
        const asMatch = c.match(/^(.+?)\s+as\s+(\w+)$/i);
        if (asMatch) {
          const expr = asMatch[1].trim();
          const alias = asMatch[2];
          const maxMatch = expr.match(/MAX\(\s*(\w+)\s*\)/i);
          if (maxMatch) {
            const col = maxMatch[1];
            const values = rows
              .map((row) => row[col])
              .filter((v) => v != null) as (string | number)[];
            out[alias] =
              values.length === 0
                ? null
                : values.reduce<string | number>(
                    (max, v) => (v > max ? v : max),
                    values[0],
                  );
            continue;
          }
          if (/^COUNT\(\*\)$/i.test(expr)) {
            out[alias] = rows.length;
            continue;
          }
        }
        out[c] = r[c];
      }
      return out;
    });
    return projected as T[];
  };

  const getFirst = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    const rows = await getAll<T>(sql, params);
    return rows[0] ?? null;
  };

  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    const insert = parseColumnsAndValues(sql);
    if (insert) {
      const table = state.tables.get(insert.table);
      if (!table) throw new Error(`Table ${insert.table} not found`);
      const row: Row = {};
      insert.columns.forEach((c, i) => {
        row[c] = params[i];
      });
      if (table.primaryKey.length > 0) {
        const key = rowKey(row, table.primaryKey);
        const exists = table.rows.find((r) => rowKey(r, table.primaryKey) === key);
        if (exists) {
          if (/INSERT\s+OR\s+IGNORE/i.test(sql)) return;
          if (/INSERT\s+OR\s+REPLACE/i.test(sql) || /ON CONFLICT/i.test(sql)) {
            for (const k of Object.keys(row)) (exists as Row)[k] = row[k];
            return;
          }
          throw new Error(`UNIQUE constraint failed on ${insert.table}`);
        }
      }
      table.rows.push(row);
      return;
    }
    // ON CONFLICT ... DO UPDATE SET — emulated by INSERT-or-replace above.
    if (/INSERT\s+INTO\s+\w+.+ON\s+CONFLICT/is.test(sql)) {
      // Coerce to a row by parsing leading INSERT + VALUES.
      const fallback = parseColumnsAndValues(sql.replace(/\s+ON\s+CONFLICT[\s\S]*/i, ''));
      if (fallback) {
        const t = state.tables.get(fallback.table);
        if (!t) throw new Error(`Table ${fallback.table} not found`);
        const row: Row = {};
        fallback.columns.forEach((c, i) => {
          row[c] = params[i];
        });
        const key = rowKey(row, t.primaryKey);
        const exists = t.rows.find((r) => rowKey(r, t.primaryKey) === key);
        if (exists) {
          for (const k of Object.keys(row)) (exists as Row)[k] = row[k];
        } else {
          t.rows.push(row);
        }
        return;
      }
    }
    throw new Error(`Unsupported runAsync SQL: ${sql}`);
  };

  const prepare = async (sql: string) => {
    return {
      executeAsync: async (params: unknown[]) => run(sql, params),
      finalizeAsync: async () => {},
    };
  };

  const withTx = async <T>(fn: () => Promise<T>): Promise<T> => fn();

  return {
    execAsync: exec,
    getAllAsync: getAll,
    getFirstAsync: getFirst,
    runAsync: run,
    prepareAsync: prepare,
    withTransactionAsync: withTx,
  };
}

// No caching across calls — every `openDatabaseAsync` returns a fresh
// in-memory database. Production code holds the singleton via
// `dbPromise` in `db.ts`; tests reset that via `__setDbForTests(null)`
// in `beforeEach`, which is enough to force a clean DB per test.
export async function openDatabaseAsync(_name: string): Promise<unknown> {
  return makeDb();
}

export function openDatabaseSync(_name: string): unknown {
  return makeDb();
}

/**
 * Backwards-compatible no-op so existing test files keep compiling
 * if they imported it. The real reset mechanism is now
 * `__setDbForTests(null)` from `@/src/lib/db/db`.
 */
export function __resetAllForTests(): void {
  // No-op: see openDatabaseAsync — each open returns a fresh DB.
}
