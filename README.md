# Introduction

NodeDBProxy is a pure NodeJS/TypeScript-based database proxy, currently supporting MySQL. It handles the low-level protocol details while exposing event handlers for high-level events such as connection establishment or sending of queries.

One of NodeDBProxy's key features is its support for `uncommittable` mode. This mode enforces that all SQL queries sent to the server are executed in the context of a single transaction that can't be committed. The `uncommitable` mode is useful for executing tests against production (or production-like) data in an isolated manner, which prevents side-effects visibile to other DB users. When the database connection is severed at the end of the session, the database engine automatically rolls back all the queries previously executed in the transaction.

If the developer's process attempts to start, commit, or roll back the transaction, the related SQL statements are translated into their `SAVEPOINT` counterparts so as to simulate transaction behavior while maintaining isolation from other developer or user sessions. `COMMIT` or `ROLLBACK` statements outside of `SAVEPOINT`s are ignored. So as to prevent unintended sideffects, only a whitelisted set of queries is supported: `SELECT`, `CREATE`, `UPDATE`, `DELETE`, `BEGIN`, `START TRANSACTION`, `COMMIT`, and `ROLLBACK`.

Here's an example of how a series of DB statements would be translated by the DB proxy:

| Original Query                              | Rewritten Query                             |
| ------------------------------------------- | ------------------------------------------- |
|                                             | BEGIN                                       |
| BEGIN                                       | SAVEPOINT s1                                |
| INSERT INTO table_name(val) VALUES ('test') | INSERT INTO table_name(val) VALUES ('test') |
| COMMIT                                      | RELEASE SAVEPOINT s1                        |
| BEGIN                                       | SAVEPOINT s1                                |
| UPDATE table_name SET val='new val'         | UPDATE table_name SET val='new val'         |
| ROLLBACK                                    | ROLLBACK TO SAVEPOINT s1                    |
| DELETE FROM table_name                      | DELETE FROM table_name                      |
| COMMIT                                      |                                             |

As a word of warning, it's not advised to use the Uncommitable proxy directly against your production database.
It would be much safer to use the Uncommitable proxy against a replica. You should also make sure access to the Uncommitable
proxy is secure (it hasn't been tested with SSL) so avoid leaking sensitive data.

# Usage

To instantiate a simple MySQL proxy, follow the following example

```typescript
import { MySqlProxy } from "node-db-proxy";

const listener: MySqlProxyListener = {
  // Called when a client connection is made to the proxy
  onConn: async (conn) => {},

  // Called when a connection is made to the server
  onProxyConn: async (proxyConn) => {},

  // Called when a client connection sends a query to the proxy.
  // The return value is an array of SQL queries to be sent
  // to the DB server. This default implementation forwards
  // the original query.
  onQuery: async (conn, query) => [query],
};
const connectionOptions = {
  host: "127.0.0.1",
  user: "root",
  password: "root",
  database: "test",
  port: 3305,
};
const dbProxy = new MySqlProxy(proxyPort, connectionOptions);
await dbProxy.listen();
```

If you want the proxy to stop listening (which can be useful in unit tests), call

```typescript
await dbProxy.stop();
```

The example below shows how to create an uncommitable proxy:

```typescript
const uncommittableProxy = new UncommittableProxy(port, connectionOptions);
```

Similar to the simple proxy, this is how you close it:

```typescript
await uncommittableProxy.close();
```

You're encouraged to look at the unit tests to see how the Uncommitable proxy handles
different edge cases.
