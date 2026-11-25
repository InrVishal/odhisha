// Examples for .semgrep/nightshift.yml, checked by `semgrep --test .semgrep`.
// Never imported or built: it only has to parse.
/* eslint-disable */
// @ts-nocheck

function rawSql(db, sql, userInput) {
  // ruleid: no-raw-sql
  db.execute(sql.raw(`select * from job where id = '${userInput}'`));
  // ok: no-raw-sql
  db.execute(sql`select * from job where id = ${userInput}`);
}

function stringBuilt(db, pool, userInput) {
  // ruleid: no-string-built-sql
  db.execute(`delete from job where id = ${userInput}`);
  // ruleid: no-string-built-sql
  db.execute("select * from job where buyer_id = " + userInput);
  // ruleid: no-string-built-sql
  db.execute("select * from session");
  // ruleid: no-string-built-sql
  pool.query(`select * from "user" where email = '${userInput}'`);
  // ok: no-string-built-sql
  db.execute(sql`select 1`);
}

function identifiers(sql, column) {
  // ruleid: sql-identifier-literal-only
  sql`select ${sql.identifier(column)} from job`;
  // ok: sql-identifier-literal-only
  sql`select ${sql.identifier("status")} from job`;
}

function roles(db, users, id) {
  // ruleid: no-role-writes
  db.update(users).set({ role: "admin" });
  // ruleid: no-role-writes
  db.update(users).set({ email: null, role: body.role });
  // ruleid: no-role-writes
  db.insert(users).values({ email: "x@example.in", role: "admin" });
  // ruleid: no-role-writes
  db.update(users).set({ isAdmin: true });
  // ok: no-role-writes
  db.update(users).set({ email: null, deletedAt: new Date() });
}

function headersAuth(req) {
  // ruleid: no-trusting-middleware-headers
  if (req.headers.get("x-middleware-subrequest")) return true;
  // ruleid: no-trusting-middleware-headers
  const role = req.headers.get("x-user-role");
  // ok: no-trusting-middleware-headers
  const origin = req.headers.get("origin");
}

function code(userInput) {
  // ruleid: no-eval
  eval(userInput);
  // ruleid: no-eval
  new Function(userInput);
}

function secrets() {
  // ruleid: no-public-secret-env
  const k = process.env.NEXT_PUBLIC_AUTH_SECRET;
  // ruleid: no-public-secret-env
  const a = process.env.NEXT_PUBLIC_ADMIN_EMAILS;
  // ok: no-public-secret-env
  const site = process.env.NEXT_PUBLIC_SITE_NAME;
}

function shell(child_process, userInput) {
  // ruleid: no-child-process-exec
  child_process.exec(`convert ${userInput}`);
  // ruleid: no-child-process-exec
  execSync(userInput);
}
