import mysqlServer from "mysql2";
import mysql, { Connection } from "mysql2/promise";
import { ConnectionOptions } from "mysql2/typings/mysql/lib/Connection";
import util from "util";
import { nanoid } from "nanoid";

export type OnConn = (conn: mysqlServer.Connection) => Promise<void>;
export type OnProxyConn = (conn: Connection) => Promise<void>;
export type OnQuery = (
  conn: mysqlServer.Connection,
  query: string
) => Promise<string[]>;

export class MySqlProxy {
  port: number;
  remoteConnectionOptions: ConnectionOptions;
  connections: Record<
    string,
    {
      proxyConn: Connection;
      clientConn: mysqlServer.Connection;
    }
  > = {};
  server: any;
  onConn: OnConn | undefined;
  onProxyConn: OnProxyConn | undefined;
  onQuery: OnQuery | undefined;

  connCounter = 0;
  constructor(
    port: number,
    remoteConnectionOptions: ConnectionOptions,
    onConn?: OnConn,
    onProxyConn?: OnProxyConn,
    onQuery?: OnQuery
  ) {
    this.port = port;
    this.remoteConnectionOptions = remoteConnectionOptions;
    // note: createServer isn't exported by default
    this.server = (mysqlServer as any).createServer();
    this.server.on("connection", this.handleIncomingConnection.bind(this));
    this.onConn = onConn;
    this.onProxyConn = onProxyConn;
    this.onQuery = onQuery;
  }

  disconnectAll() {
    Object.values(this.connections).forEach(({ clientConn, proxyConn }) => {
      tryClose(clientConn);
      tryClose(proxyConn);
    });
    this.connections = {};
  }

  async handleIncomingConnection(conn: mysqlServer.Connection) {
    const connId = nanoid();
    (conn as any).proxyId = connId;

    if (this.onConn) {
      await this.onConn(conn);
    }

    let proxyConn: Connection;
    try {
      proxyConn = await mysql.createConnection(this.remoteConnectionOptions);
    } catch (err) {
      console.error("Can't connect to remote DB server", err);
      tryClose(conn);
      return;
    }

    if (this.onProxyConn) {
      try {
        await this.onProxyConn(proxyConn);
      } catch (e) {
        tryClose(proxyConn);
        tryClose(conn);
        return;
      }
    }

    (proxyConn as any).connection.stream.on("close", () => {
      tryClose(conn);
      if (this.connections[connId]) {
        tryClose(this.connections[connId].proxyConn);
        delete this.connections[connId];
      }
    });

    this.connections[connId] = { clientConn: conn, proxyConn };
    conn.on("query", this.processQuery.bind(this, conn));
    conn.on("error", (err: any) => {
      tryClose(conn);
    });
    (conn as any).stream.on("close", () => {
      if (connId in this.connections) {
        tryClose(this.connections[connId].proxyConn);
        delete this.connections[connId];
      }
    });
    sendHandshake(conn);
  }

  get numProxyConns(): number {
    return Object.keys(this.connections).length;
  }

  async close() {
    this.disconnectAll();
    if (this.server) {
      await util.promisify(this.server.close.bind(this.server))();
    }
    this.server = null;
  }

  async listen() {
    await util.promisify(this.server.listen.bind(this.server, this.port))();
  }

  async processQuery(conn: mysqlServer.Connection, query: string) {
    const connId = (conn as any).proxyId;
    const connPair = this.connections[connId];
    if (!connPair) {
      console.error("Missing connection group for ", connId);
      (conn as any).writeError({
        message: "Connection error",
      });
      return;
    }

    let queries = [query];
    if (this.onQuery) {
      try {
        queries = await this.onQuery(conn, query);
      } catch (e) {
        await (conn as any).writeError({ message: e.message });
        return;
      }
    }
    await this.sendQueries(conn, connPair.proxyConn, queries);
  }

  async sendQueries(
    conn: mysqlServer.Connection,
    proxyConn: Connection,
    queries: string[]
  ) {
    // Note: we only return the result of the last query
    const lastQuery = queries.pop();
    if (!lastQuery) {
      (conn as any).writeOk("Ok");
      return;
    }
    try {
      for (const query of queries) {
        await proxyConn.query(query);
      }
      const [results, fields] = await proxyConn.query(lastQuery);
      if (Array.isArray(results)) {
        (conn as any).writeTextResult(results, fields);
      } else {
        (conn as any).writeOk(results);
      }
    } catch (err) {
      // TODO make sure the error fields are properly encoded
      // in the response
      (conn as any).writeError({
        message: err.message,
        code: err.code,
        sqlState: err.sqlState,
        errno: err.errno,
      });
    }
  }
}

const tryClose = (conn: Connection | mysqlServer.Connection | undefined) => {
  if (conn) {
    try {
      conn.destroy();
    } catch (e) {}
  }
};

const sendHandshake = (conn: mysqlServer.Connection) => {
  let flags = 0xffffff;
  (conn as any).serverHandshake({
    protocolVersion: 10,
    serverVersion: "node-db-proxy 1.0",
    connectionId: 1234,
    statusFlags: 2,
    characterSet: 8,
    capabilityFlags: flags,
  });
};
