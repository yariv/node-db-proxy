import mysql2 from "mysql2";
import { Connection } from "mysql2/promise";
import { ConnectionOptions } from "mysql2/typings/mysql";
import { MySqlProxy, OnConn, OnProxyConn } from "./mysqlProxy";

const crudQueryRe = /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|START TRANSACTION|COMMIT|ROLLBACK)/i;

export class UncommittableProxy {
  mysqlProxy: MySqlProxy;

  constructor(port: number, remoteConnectionOptions: ConnectionOptions) {
    // TODO group by token hash
    const groupConnections = false;
    this.mysqlProxy = new MySqlProxy(
      port,
      remoteConnectionOptions,
      groupConnections,
      onConn,
      onProxyConn,
      this.onQuery.bind(this)
    );
  }

  async listen() {
    await this.mysqlProxy.listen();
  }

  async close(): Promise<void> {
    return this.mysqlProxy.close();
  }

  async onQuery(conn: mysql2.Connection, query: string) {
    const devInProdConn = (conn as unknown) as DevInProdConn;
    const devInProdData = devInProdConn.devInProdData;

    if (!crudQueryRe.test(query)) {
      throw new Error("Invalid query: " + query);
    }

    if (/^(BEGIN|START TRANSACTION)/i.test(query)) {
      if (devInProdData.inTransaction) {
        return ["RELEASE SAVEPOINT s1", "SAVEPOINT s1"];
      }
      devInProdData.inTransaction = true;
      return ["SAVEPOINT s1"];
    }
    if (/^COMMIT/i.test(query)) {
      if (devInProdData.inTransaction) {
        return ["RELEASE SAVEPOINT s1"];
      }
      // Ignore COMMIT statements
      return [];
    }
    if (/^ROLLBACK/i.test(query)) {
      if (devInProdData.inTransaction) {
        devInProdData.inTransaction = false;
        return ["ROLLBACK TO SAVEPOINT s1"];
      }
      // Ignore ROLLBACK statements
      return [];
    }

    return [query];
  }
}

const onConn: OnConn = async (conn) => {
  (conn as any).devInProdData = new DevInProdConnData();
};

type DevInProdConn = Connection & { devInProdData: DevInProdConnData };

const onProxyConn: OnProxyConn = async (conn) => {
  await conn.query("BEGIN");
};

class DevInProdConnData {
  inTransaction = false;
}
