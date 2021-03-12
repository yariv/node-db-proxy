import mysql, { Connection, ConnectionOptions } from "mysql2/promise";
import portfinder from "portfinder";
import { UncommittableProxy } from "../uncommittableProxy";
import { setupTest } from "./setup";
import { customAlphabet } from "nanoid";
const nanoid = customAlphabet("1234567890abcdef", 10);

export const connOptions: ConnectionOptions = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "root",
  database: "test",
};

describe("Uncommittable proxy", () => {
  const defer = setupTest();

  const setupDbTest = async (): Promise<{
    directConn: Connection;
    proxiedConn: Connection;
    tableName: string;
  }> => {
    // connect to the actual db
    const directConn = await mysql.createConnection({
      ...connOptions,
      port: 3306,
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

    const dbProxyPort = await portfinder.getPortPromise();
    const dbProxy = new UncommittableProxy(dbProxyPort, connOptions);
    await dbProxy.listen();

    const proxiedConn = await mysql.createConnection({
      ...connOptions,
      port: dbProxyPort,
    });
    defer(async () => {
      await directConn.query("drop table " + tableName);
    });
    defer(dbProxy.close.bind(dbProxy));
    return { directConn, proxiedConn, tableName };
  };

  it("simple query works", async () => {
    const { proxiedConn } = await setupDbTest();
    const [[res]] = (await proxiedConn.query("select 1 as a")) as any;
    expect(res.a).toStrictEqual(1);
  });

  it("crud works", async () => {
    const { proxiedConn, tableName } = await setupDbTest();
    await proxiedConn.query(`insert into ${tableName}(val) values('test');`);
    const [res] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res.length).toStrictEqual(1);
    expect(res[0].id).toStrictEqual(1);
    expect(res[0].val).toStrictEqual("test");

    await proxiedConn.query(`update ${tableName} set val=? where id=?`, [
      "foo",
      res[0].id,
    ]);
    const [res1] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res.length).toStrictEqual(1);
    expect(res1[0].id).toStrictEqual(1);
    expect(res1[0].val).toStrictEqual("foo");

    await proxiedConn.query(`delete from ${tableName}`);
    const [res2] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res2.length).toStrictEqual(0);
  });

  it("isolation works", async () => {
    const { directConn, proxiedConn, tableName } = await setupDbTest();
    await proxiedConn.query(`insert into ${tableName}(val) values('test');`);
    const [res] = (await directConn.query(`select * from ${tableName}`)) as any;
    expect(res.length).toStrictEqual(0);

    // isolation works even after the connection ends
    proxiedConn.destroy();

    const [res1] = (await directConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res1.length).toStrictEqual(0);
  });

  const transactionTest = async (
    startTxQuery: string,
    endTxQuery: string,
    expectedVal: string
  ) => {
    const { directConn, proxiedConn, tableName } = await setupDbTest();
    await proxiedConn.query(`insert into ${tableName}(val) values('test');`);
    const [res0] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    console.log(res0);
    expect(res0.length).toStrictEqual(1);
    expect(res0[0].val).toStrictEqual("test");

    await proxiedConn.query(startTxQuery);
    await proxiedConn.query(`update ${tableName} set val="foo" `);
    const [res1] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res1.length).toStrictEqual(1);
    expect(res1[0].val).toStrictEqual("foo");

    await proxiedConn.query(endTxQuery);
    const [res2] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res2.length).toStrictEqual(1);
    expect(res2[0].val).toStrictEqual(expectedVal);

    const [res3] = (await directConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res3.length).toStrictEqual(0);
  };

  it("rollback works", async () => {
    await transactionTest("begin", "rollback", "test");
  });

  it("commit works", async () => {
    await transactionTest("begin", "commit", "foo");
  });

  it("start transaction rollback works", async () => {
    await transactionTest("start transaction", "rollback", "test");
  });

  it("start transaction commit works", async () => {
    await transactionTest("start transaction", "commit", "foo");
  });

  it("auto commits savepoint on second begin", async () => {
    const { directConn, proxiedConn, tableName } = await setupDbTest();
    await proxiedConn.query("begin");
    await proxiedConn.query(`insert into ${tableName}(val) values('test');`);
    await proxiedConn.query("begin");
    await proxiedConn.query(`update ${tableName} set val="foo" `);
    const [res0] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    expect(res0.length).toStrictEqual(1);
    expect(res0[0].val).toStrictEqual("foo");
    await proxiedConn.query("rollback");
    const [res1] = (await proxiedConn.query(
      `select * from ${tableName}`
    )) as any;
    console.log(res1);
    expect(res1.length).toStrictEqual(1);
    expect(res1[0].val).toStrictEqual("test");
  });

  it("disallows non crud queries", async () => {
    const { proxiedConn, tableName } = await setupDbTest();

    // see https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html for some bad queries
    const invalidQueries = [
      "set autocommit=1",
      "set autocommit = 1",
      "drop table " + tableName,
      "create table foo",
      "lock tables",
      "unlock tables",
    ];
    for (const query of invalidQueries) {
      try {
        const res = await proxiedConn.query(query);
      } catch (e) {
        expect(e.message).toStrictEqual("Invalid query: " + query);
      }
    }
  });
});
