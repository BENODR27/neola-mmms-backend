// Shared masters are authoritative in IAM. These rows are a local operational projection, never another editable catalog.
const jwt = require("jsonwebtoken");
const {
  MasterRecord,
  Machine,
  SparePart,
  Technician,
  sequelize,
} = require("../models");
const HttpError = require("../errors/http-error");
const modules = [
  "organization",
  "factories",
  "departments",
  "production-lines",
  "organization-units",
  "units",
  "currencies",
  "employees",
  "contacts",
];
let pending,
  expires = 0;
async function sync(force = false) {
  if (process.env.PLATFORM_MASTERS_MODE !== "shared") return;
  if (!force && Date.now() < expires) return;
  if (pending) {
    await pending;
    if (force) return sync(true);
    return;
  }
  pending = (async () => {
    const origin = process.env.IAM_API_URL;
    if (!origin)
      throw new HttpError(503, "Shared master service is not configured");
    const token = jwt.sign(
      { sub: "mmms-catalog-consumer" },
      process.env.JWT_SECRET,
      {
        algorithm: "HS256",
        issuer: process.env.JWT_ISSUER || "platform-iam",
        audience: "platform-catalogs",
        expiresIn: "30s",
      },
    );
    let response;
    try {
      response = await fetch(
        `${origin}/v3/api/auth/shared-masters/internal/snapshot`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
    } catch {
      throw new HttpError(503, "Shared master service unavailable");
    }
    if (!response.ok)
      throw new HttpError(503, "Shared master snapshot was rejected");
    const { result } = await response.json();
    if (
      !Array.isArray(result) ||
      result.some((r) => !modules.includes(r.module))
    )
      throw new HttpError(503, "Invalid shared master snapshot");
    await sequelize.transaction(async (transaction) => {
      for (const r of result) {
        const existing = await MasterRecord.findByPk(r.id, { transaction });
        if (
          existing?.data.sharedMaster &&
          Number(existing.data.sharedRevision) === Number(r.revision)
        )
          continue;
        await MasterRecord.upsert(
          {
            id: r.id,
            module: r.module,
            name: r.name,
            code: r.code,
            organizationId: r.organization_id,
            factoryId: r.factory_id,
            status: r.status,
            data: {
              ...r.data,
              sharedMaster: true,
              sharedRevision: Number(r.revision),
            },
          },
          { transaction },
        );
      }
    });
    const machines = await Machine.findAll({
      attributes: ["organizationId", "factoryId", "locationIds"],
    });
    const parts = await SparePart.findAll({
      attributes: ["organizationId", "factoryId", "details"],
    });
    const people = await Technician.findAll({
      where: { active: true },
      attributes: ["organizationId", "factoryId", "employeeNumber", "details"],
    });
    const references = result.map((r) => ({
      id: r.id,
      count:
        machines.filter((m) =>
          [
            m.organizationId,
            m.factoryId,
            ...Object.values(m.locationIds || {}),
          ].includes(r.id),
        ).length +
        parts.filter(
          (p) =>
            [p.organizationId, p.factoryId, p.details?.unitId].includes(r.id) ||
            (r.module === "units" && p.details?.unit === r.name),
        ).length +
        people.filter(
          (p) =>
            [p.organizationId, p.factoryId, p.details?.employeeId].includes(
              r.id,
            ) ||
            (r.module === "employees" &&
              p.employeeNumber === r.code &&
              (!r.organization_id || r.organization_id === p.organizationId)),
        ).length,
    }));
    const recorded = await fetch(
      `${origin}/v3/api/auth/shared-masters/internal/references`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ references }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!recorded.ok)
      throw new HttpError(
        503,
        "Shared master references could not be refreshed",
      );
    expires = Date.now() + 1000;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
async function middleware(req, res, next) {
  try {
    if (process.env.PLATFORM_MASTERS_MODE !== "shared") return next();
    const segments = req.path.split("/");
    const module = segments[1] === "master-data" ? segments[2] : segments[1];
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (module === "hierarchy" ||
        modules.includes(module) ||
        (["masters", "master-records"].includes(module) &&
          modules.includes(req.body?.module)))
    )
      throw new HttpError(
        409,
        "Edit common masters in the shared Platform Masters application",
      );
    await sync(!["GET", "HEAD"].includes(req.method));
    if (!["GET", "HEAD"].includes(req.method))
      res.once("finish", () => {
        expires = 0;
        sync(true).catch((e) =>
          console.error("Master reference refresh pending:", e.message),
        );
      });
    next();
  } catch (e) {
    next(e);
  }
}
module.exports = { sync, middleware, modules };
