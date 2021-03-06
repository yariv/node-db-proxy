import mysql, { Connection } from "mysql2/promise";
import portfinder from "portfinder";
import { MySqlProxy, MySqlProxyListener } from "../src/mysqlProxy";
import { setupTest } from "./setup";
import { customAlphabet } from "nanoid";
const nanoid = customAlphabet("1234567890abcdef", 10);

describe("MySqlProxy test", () => {
  const defer = setupTest();

  const connOptions = {
    host: "127.0.0.1",
    user: "root",
    password: "root",
    database: "test",
  };
  const dbPort = 3306;

  const setupProxy = async (): Promise<MySqlProxy> => {
    const proxyPort = await portfinder.getPortPromise();

    const listener: MySqlProxyListener = {
      onConn: async (conn) => {},
      onProxyConn: async (proxyConn) => {},
      onQuery: async (conn, query) => [query],
    };
    const dbProxy = new MySqlProxy(
      proxyPort,
      { ...connOptions, port: dbPort },
      listener
    );
    await dbProxy.listen();
    defer(dbProxy.close.bind(dbProxy));
    return dbProxy;
  };

  const setup = async (): Promise<{
    directConn: Connection;
    proxiedConn: Connection;
    dbProxy: MySqlProxy;
    tableName: string;
  }> => {
    const dbProxy = await setupProxy();

    // connect to the actual db
    const directConn = await mysql.createConnection({
      ...connOptions,
      port: dbPort,
    });
    defer(directConn.end.bind(directConn));

    // note: randomized table names help multiple tests run in parallel
    // without naming collisions
    const tableName = "test_" + nanoid();
    directConn.query(`
    create table ${tableName} (
        id integer auto_increment primary key,
        val text
        )`);
    defer(async () => {
      await directConn.query("drop table " + tableName);
    });

    const proxiedConn = await mysql.createConnection({
      ...connOptions,
      port: dbProxy.port,
    });
    defer(proxiedConn.end.bind(proxiedConn));
    return { directConn, proxiedConn, dbProxy, tableName };
  };

  it("works", async () => {
    const { directConn, proxiedConn, tableName } = await setup();
    const getResults = async () => {
      const query = "select * from " + tableName;
      const [res1, fields1] = (await directConn.query(query)) as any;
      const [res2, fields2] = (await proxiedConn.query(query)) as any;
      // TODO test fields
      return [res1, res2];
    };
    const [res1_1, res2_1] = await getResults();
    expect(res1_1.length).toBe(0);
    expect(res2_1.length).toBe(0);

    await proxiedConn.query(`insert into ${tableName}(val) values('foo')`);
    const [res1_2, res2_2] = await getResults();

    expect(res1_2.length).toEqual(1);
    expect({ id: res1_2[0].id, val: res1_2[0].val }).toEqual({
      id: 1,
      val: "foo",
    });
    expect(res1_2).toEqual(res2_2);
  });

  it("empty onQuery result works", async () => {
    const { proxiedConn, dbProxy } = await setup();
    dbProxy.listener.onQuery = async (conn, query) => [];
    const [res] = (await proxiedConn.query("select 1")) as any;
    expect(res.fieldCount).toStrictEqual(0);
  });

  it("multiple onQuery results works", async () => {
    const { proxiedConn, dbProxy } = await setup();
    dbProxy.listener.onQuery = async (conn, query) => [
      "select 1",
      "select 2 as a",
    ];
    const [res] = (await proxiedConn.query("select 1")) as any;
    expect(res.length).toStrictEqual(1);
    expect(res[0].a).toStrictEqual(2);
  });

  it("client disconnects when proxy conn disconnects", async () => {
    const { dbProxy, proxiedConn } = await setup();

    return new Promise((resolve) => {
      proxiedConn.on("error", () => {
        resolve(null);
      });
      Object.values(dbProxy.connections)[0].proxyConn.destroy();
    });
  });

  const checkNumConns = async (dbProxy: MySqlProxy, num: number) => {
    expect(dbProxy.numProxyConns).toBe(num);
  };

  it("proxy conn disconnects after client disconnects", async () => {
    const { proxiedConn, dbProxy } = await setup();
    const numConns = dbProxy.numProxyConns;
    await proxiedConn.end();
    // TODO find a less fragile way of testing this
    await new Promise((resolve) => setTimeout(resolve, 10));
    await checkNumConns(dbProxy, numConns - 1);
  });

  it("multiple statements are disallowed", async () => {
    const dbProxy = await setupProxy();
    const directConn = await mysql.createConnection({
      ...connOptions,
      multipleStatements: true,
      port: dbPort,
    });
    defer(directConn.end.bind(directConn));

    const [res] = (await directConn.query("select 1; select 1;")) as any;
    expect(res.length).toStrictEqual(2);

    const proxiedConn = await mysql.createConnection({
      ...connOptions,
      multipleStatements: true,
      port: dbProxy.port,
    });
    defer(proxiedConn.end.bind(proxiedConn));
    try {
      await proxiedConn.query("select 1; select 1;");
      fail();
    } catch (e) {
      expect(
        e.message.startsWith("You have an error in your SQL syntax")
      ).toBeTruthy();
    }
  });

  it("onProxyConn works", async () => {
    const dbProxy = await setupProxy();
    const promise = new Promise((resolve) => {
      dbProxy.listener.onProxyConn = async (conn) => {
        const [[res]] = (await conn.query("select 1 as a")) as any;
        expect(res.a).toStrictEqual(1);
        resolve(null);
      };
    });
    await mysql.createConnection({
      ...connOptions,
      port: dbProxy.port,
    });
    return promise;
  });

  it("onConn works", async () => {
    const dbProxy = await setupProxy();

    await checkNumConns(dbProxy, 0);

    let called = false;
    dbProxy.listener.onConn = async (conn) => {
      called = true;
    };
    const conn1 = await mysql.createConnection({
      ...connOptions,
      port: dbProxy.port,
    });
    expect(called).toBeTruthy();
    await checkNumConns(dbProxy, 1);

    const conn2 = await mysql.createConnection({
      ...connOptions,
      port: dbProxy.port,
    });
    await checkNumConns(dbProxy, 2);

    conn1.destroy();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await checkNumConns(dbProxy, 1);

    conn2.destroy();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await checkNumConns(dbProxy, 0);
  });

  it("onProxyConn throws", async () => {
    const dbProxy = await setupProxy();
    dbProxy.listener.onProxyConn = async (conn) => {
      throw new Error("foo");
    };
    try {
      await mysql.createConnection({
        ...connOptions,
        port: dbProxy.port,
      });
      fail();
    } catch (e) {}
  });
});
