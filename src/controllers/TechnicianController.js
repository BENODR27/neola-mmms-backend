const { listRecords } = require("../services/list-query");
const { Op } = require("sequelize");
const BaseController = require("./BaseController");
const {
  assertPayloadAccess,
  assertRecordAccess,
} = require("../middleware/data-scope");
const { filterRecords } = require("../middleware/data-scope");
const { WorkOrder, MasterRecord } = require("../models");
const { randomUUID } = require("node:crypto");

class TechnicianController extends BaseController {
  async getAll(req, res, next) {
    try {
      const page = await listRecords(req, this.model, {
        order: [["name", "ASC"]],
      });
      const records = page.result;
      const orders = filterRecords(
        req,
        await WorkOrder.findAll({
          where: {
            [Op.or]: [
              { technicianId: { [Op.in]: records.map((row) => row.id) } },
              ...records.map((row) => ({
                details: { [Op.contains]: { team: [row.id] } },
              })),
            ],
          },
        }),
      );
      res.json({
        ...page,
        result: records.map((record) => {
          const jobs = orders.filter(
            (order) =>
              order.technicianId === record.id ||
              (order.details.team || []).includes(record.id),
          );
          const open = jobs.filter(
            (order) => !["Closed", "Cancelled"].includes(order.status),
          );
          return {
            ...record.toJSON(),
            currentWorkload: open.length,
            availability: !record.active
              ? "Unavailable"
              : open.length
                ? "Busy"
                : "Available",
            completedJobs: jobs.filter((order) => order.status === "Closed")
              .length,
            laborMinutes: jobs.reduce(
              (total, order) => total + Number(order.laborMinutes || 0),
              0,
            ),
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  }
  async create(req, res, next) {
    try {
      const payload = this.normalise(req.body);
      await this.linkEmployee(payload);
      await this.validateFactory(payload);
      assertPayloadAccess(req, payload);
      if (!payload.employeeNumber || !payload.name)
        return res.status(400).json({
          error: { message: "Employee number and name are required" },
        });
      res.status(201).json({
        result: await this.model.create({ ...payload, id: randomUUID() }),
      });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const record = await this.model.findByPk(req.params.id);
      if (!record)
        return res
          .status(404)
          .json({ error: { message: "Technician not found" } });
      assertRecordAccess(req, record);
      assertPayloadAccess(req, { ...record.toJSON(), ...req.body });
      const values = { ...record.toJSON(), ...this.normalise(req.body) };
      await this.linkEmployee(values);
      await this.validateFactory(values);
      if (
        !String(values.name || "").trim() ||
        !String(values.employeeNumber || "").trim()
      )
        return res.status(422).json({
          error: { message: "Employee number and name are required" },
        });
      await record.update(this.normalise(values));
      res.json({ result: record });
    } catch (error) {
      next(error);
    }
  }

  async validateFactory(payload) {
    const factory = await MasterRecord.findOne({
      where: { id: payload.factoryId, module: "factories", status: "Active" },
    });
    if (!factory || factory.organizationId !== payload.organizationId) {
      const HttpError = require("../errors/http-error");
      throw new HttpError(422, "Select an active factory in this company");
    }
  }
  async linkEmployee(payload) {
    if (process.env.PLATFORM_MASTERS_MODE !== "shared") return;
    const employee = await MasterRecord.findOne({
      where: {
        module: "employees",
        ...(payload.details?.employeeId
          ? { id: payload.details.employeeId }
          : { code: payload.employeeNumber }),
        status: "Active",
        [Op.or]: [
          { organizationId: null },
          { organizationId: payload.organizationId },
        ],
      },
    });
    if (
      !employee ||
      employee.code !== payload.employeeNumber ||
      (employee.organizationId &&
        employee.organizationId !== payload.organizationId)
    )
      throw new (require("../errors/http-error"))(
        422,
        "Create or activate this employee in Platform Masters first",
      );
    payload.name = employee.name;
    payload.email = employee.data.email || "";
    payload.phone = employee.data.phone || "";
    payload.details = { ...payload.details, employeeId: employee.id };
  }
  normalise(body = {}) {
    return {
      ...Object.fromEntries(
        [
          "employeeNumber",
          "name",
          "email",
          "phone",
          "shift",
          "factory",
          "organizationId",
          "factoryId",
          "active",
          "details",
        ]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      ),
      ...(body.skillCategories !== undefined
        ? {
            skillCategories: Array.isArray(body.skillCategories)
              ? body.skillCategories
              : String(body.skillCategories || "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
          }
        : {}),
    };
  }
  async delete(req, res, next) {
    req.body = { active: false };
    return this.update(req, res, next);
  }
  rejectBulk(req, res) {
    res.status(405).json({
      error: {
        message: "Use individual mechanic records to retain assignment history",
      },
    });
  }
  createBatch(req, res) {
    this.rejectBulk(req, res);
  }
  updateBatch(req, res) {
    this.rejectBulk(req, res);
  }
  updateWithFilter(req, res) {
    this.rejectBulk(req, res);
  }
  updateAllByCustomKey(req, res) {
    this.rejectBulk(req, res);
  }
}

module.exports = TechnicianController;
