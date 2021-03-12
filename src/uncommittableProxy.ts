import mysql2 from "mysql2";
import { ConnectionOptions } from "mysql2/typings/mysql";
import { MySqlProxy, MySqlProxyListener } from "./mysqlProxy";

const crudQueryRe = /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|START TRANSACTION|COMMIT|ROLLBACK)/i;

export class UncommittableProxy {
  mysqlProxy: MySqlProxy;

  constructor(port: number, remoteConnectionOptions: ConnectionOptions) {
    const listener: MySqlProxyListener = {
      onConn: async (conn) => {
        (conn as any).inTransaction = false;
      },
      onProxyConn: async (proxyConn) => {
        await proxyConn.query("BEGIN");
      },
      onQuery: this.onQuery.bind(this),
    };
    this.mysqlProxy = new MySqlProxy(port, remoteConnectionOptions, listener);
  }

  async listen() {
    await this.mysqlProxy.listen();
  }

  async close(): Promise<void> {
    return this.mysqlProxy.close();
  }

  async onQuery(conn: mysql2.Connection, query: string) {
    if (!crudQueryRe.test(query)) {
      throw new Error("Invalid query: " + query);
    }

    const inTransaction = (conn as any).inTransaction;
    if (/^(BEGIN|START TRANSACTION)/i.test(query)) {
      if (inTransaction) {
        return ["RELEASE SAVEPOINT s1", "SAVEPOINT s1"];
      }
      (conn as any).inTransaction = true;
      return ["SAVEPOINT s1"];
    }
    if (/^COMMIT/i.test(query)) {
      if (inTransaction) {
        return ["RELEASE SAVEPOINT s1"];
      }
      // Ignore COMMIT statements
      return [];
    }
    if (/^ROLLBACK/i.test(query)) {
      if (inTransaction) {
        (conn as any).inTransaction = false;
        return ["ROLLBACK TO SAVEPOINT s1"];
      }
      // Ignore ROLLBACK statements
      return [];
    }

    return [query];
  }
}
