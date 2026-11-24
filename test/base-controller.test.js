const test = require("node:test");
const assert = require("node:assert/strict");
const BaseController = require("../src/controllers/BaseController");
const own = { id: "own", organizationId: "o1", factoryId: "f1" };
const other = { id: "other", organizationId: "o1", factoryId: "f2" };
const request = (body = {}) => ({
  body,
  query: {},
  params: { id: "other" },
  auth: {
    accessScopes: [
      { applicationName: "MMMS", organizationId: "o1", factoryId: "f1" },
    ],
  },
});
function response() {
  return {
    code: 200,
    data: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
    send() {
      return this;
    },
  };
}
test("delete checks the existing record before destroying it", async () => {
  let destroyed = false;
  const controller = new BaseController({
    findByPk: async () => ({
      ...other,
      destroy: async () => {
        destroyed = true;
      },
    }),
  });
  let error;
  await controller.delete(request(), response(), (value) => {
    error = value;
  });
  assert.equal(error.status, 403);
  assert.equal(destroyed, false);
});
test("batch create validates every scope before any insert", async () => {
  let inserted = false;
  const controller = new BaseController({
    bulkCreate: async () => {
      inserted = true;
    },
  });
  let error;
  await controller.createBatch(request([own, other]), response(), (value) => {
    error = value;
  });
  assert.equal(error.status, 403);
  assert.equal(inserted, false);
});
test("filter update cannot modify another factory through a broad where clause", async () => {
  let mutated = false;
  const record = (value) => ({
    ...value,
    toJSON: () => value,
    update: async () => {
      mutated = true;
    },
  });
  const controller = new BaseController({
    findAll: async () => [record(own), record(other)],
  });
  let error;
  await controller.updateWithFilter(
    request({ where: {}, values: { name: "changed" } }),
    response(),
    (value) => {
      error = value;
    },
  );
  assert.equal(error.status, 403);
  assert.equal(mutated, false);
});
test("pagination sends the authorization predicate and limit to the database", async () => {
  const { Sequelize, DataTypes, Op } = require('sequelize');
  const database = new Sequelize('postgres://unused:unused@127.0.0.1/unused', { logging: false });
  const model = database.define('ScopedRecord', { id: { type: DataTypes.STRING, primaryKey: true }, organizationId: DataTypes.STRING, factoryId: DataTypes.STRING });
  model.findAndCountAll = async (options) => {
    assert.equal(options.limit, 1);
    assert.equal(options.offset, 0);
    assert.match(options.where[Op.and][1].val, /f1/);
    assert.match(options.where[Op.and][1].val, /o1/);
    assert.deepEqual(options.order.at(-1), ['id', 'ASC']);
    return { rows: [own], count: 1 };
  };
  const controller = new BaseController(model);
  const req = request();
  req.query.limit = "1";
  const res = response();
  await controller.getAll(req, res, (error) => {
    throw error;
  });
  assert.deepEqual(res.data.result, [own]);
  assert.equal(res.data.total, 1);
  await database.close();
});
test("batch update checks all records before writing the first one", async () => {
  let mutated = false;
  const rows = [own, other].map((value) => ({
    ...value,
    toJSON: () => value,
    update: async () => {
      mutated = true;
    },
  }));
  const controller = new BaseController({
    sequelize: {
      transaction: async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }),
    },
    findByPk: async (id) => rows.find((row) => row.id === id),
  });
  let error;
  await controller.updateBatch(
    request([
      { id: "own", name: "new" },
      { id: "other", name: "new" },
    ]),
    response(),
    (value) => {
      error = value;
    },
  );
  assert.equal(error.status, 403);
  assert.equal(mutated, false);
});
