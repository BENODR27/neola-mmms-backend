const { Op, literal } = require("sequelize");
const HttpError = require("../errors/http-error");
const { assignments } = require("../middleware/data-scope");

function pagination(query = {}) {
  const integer = (key, fallback, max) => {
    if (query[key] === undefined) return fallback;
    const value = Number(query[key]);
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "offset" ? 0 : 1) ||
      value > max
    ) {
      throw new HttpError(422, `Invalid ${key}`);
    }
    return value;
  };
  const requested = ["page", "pageSize", "limit", "offset"].some(
    (key) => query[key] !== undefined,
  );
  const pageSize = integer(
    "pageSize",
    integer("limit", requested ? 25 : undefined, 500),
    100,
  );
  const page = integer("page", 1, Number.MAX_SAFE_INTEGER);
  const offset = integer(
    "offset",
    pageSize === undefined ? 0 : (page - 1) * pageSize,
    Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(offset)) throw new HttpError(422, "Invalid page");
  return {
    page: pageSize ? Math.floor(offset / pageSize) + 1 : 1,
    pageSize,
    offset,
  };
}

// Build the same organization/factory predicate as data-scope before COUNT/LIMIT.
// Only server-owned identifiers enter SQL; all request values are escaped by Sequelize.
function scopeWhere(req, model, { destination = false, include = [] } = {}) {
  const escape = (value) => model.sequelize.escape(value);
  const quote = (value) =>
    model.sequelize.getQueryInterface().queryGenerator.quoteIdentifier(value);
  const column = (key) =>
    model.rawAttributes[key]
      ? `${quote(model.name)}.${quote(model.rawAttributes[key].field || key)}`
      : "NULL";
  const data = model.rawAttributes.data ? column("data") : null;
  const json = (key) => (data ? `${data}->>${escape(key)}` : "NULL");
  const machine = include.some((entry) => entry.as === "machine")
    ? model.associations?.machine?.target
    : null;
  const machineColumn = (key) =>
    machine?.rawAttributes[key]
      ? `${quote("machine")}.${quote(machine.rawAttributes[key].field || key)}`
      : "NULL";
  const text = (sql) => `LOWER(BTRIM(COALESCE((${sql})::text, '')))`;
  const identity = (key) =>
    destination
      ? `${data}->'destination'->>${escape(key)}`
      : `COALESCE(NULLIF(${column(key)}::text, ''), NULLIF(${json(key)}, ''), ${machineColumn(key)}::text)`;
  const moduleOrganization =
    !destination && model.rawAttributes.module
      ? `${column("module")} = 'organization'`
      : "FALSE";
  const compare = (kind, candidates) => {
    if (!candidates.length) return "TRUE";
    const key = kind === "organization" ? "organizationId" : "factoryId";
    const id = identity(key);
    const fields =
      kind === "organization"
        ? ["organizationUnit", "organization", "organizationName"]
        : ["factory", "factoryName", "factoryLocation"];
    const names = fields.map((field) =>
      text(
        model.rawAttributes[field]
          ? column(field)
          : data
            ? json(field)
            : machineColumn(field),
      ),
    );
    const moduleName = kind === "organization" ? "organization" : "factories";
    if (model.rawAttributes.module && !destination) {
      for (const field of ["id", "code", "name"])
        names.push(
          `CASE WHEN ${column("module")} = '${moduleName}' THEN ${text(column(field))} ELSE '' END`,
        );
    }
    const accepted = candidates.map((value) =>
      escape(String(value).trim().toLowerCase()),
    );
    return `(${text(id)} IN (${accepted.join(",")}) OR (${text(id)} = '' AND (${destination ? "FALSE" : names.map((name) => `${name} IN (${accepted.join(",")})`).join(" OR ")})))`;
  };
  const scopeList = assignments(req);
  const granted =
    scopeList === null
      ? "TRUE"
      : scopeList.length
        ? scopeList
            .map((scope) => {
              const organizations = [
                scope.organizationId,
                scope.organizationName,
              ].filter(
                (value) =>
                  value !== undefined && value !== null && String(value).trim(),
              );
              const factories = [scope.factoryId, scope.factoryName].filter(
                (value) =>
                  value !== undefined && value !== null && String(value).trim(),
              );
              return `(${compare("organization", organizations)} AND (${moduleOrganization} OR ${compare("factory", factories)}))`;
            })
            .join(" OR ")
        : "FALSE";
  const organization = req.query?.organizationId;
  const factory = req.query?.factoryId;
  return literal(
    `((${granted}) AND ${organization ? compare("organization", [organization]) : "TRUE"} AND (${moduleOrganization} OR ${factory ? compare("factory", [factory]) : "TRUE"}))`,
  );
}

async function listRecords(req, model, options = {}) {
  const {
    present = (row) => row,
    scope = true,
    movement = false,
    ...find
  } = options;
  const page = pagination(req.query);
  const include = find.include || [];
  const clauses = [find.where || {}];
  if (scope)
    clauses.push(
      movement
        ? {
            [Op.or]: [
              scopeWhere(req, model, { include }),
              scopeWhere(req, model, { include, destination: true }),
            ],
          }
        : scopeWhere(req, model, { include }),
    );
  const attributes = model.rawAttributes;
  const quote = (value) =>
    model.sequelize.getQueryInterface().queryGenerator.quoteIdentifier(value);
  const col = (key) =>
    `${quote(model.name)}.${quote(attributes[key].field || key)}`;
  const escaped = (value) => model.sequelize.escape(value);
  const searchable = [
    "id",
    "name",
    "code",
    "status",
    "machineCode",
    "assetNumber",
    "serialNumber",
    "category",
    "issue",
    "description",
    "technicianName",
    "employeeNumber",
    "factory",
    "productionLine",
    "supplier",
    "email",
    "phone",
    "shift",
    "skillCategories",
    "details",
    "data",
  ];
  if (req.query.search) {
    if (typeof req.query.search !== "string" || req.query.search.length > 200)
      throw new HttpError(422, "Search must contain at most 200 characters");
    const term = `%${req.query.search.replace(/[\\%_]/g, "\\$&")}%`;
    const expressions = searchable
      .filter((key) => attributes[key])
      .map((key) => `${col(key)}::text`);
    for (const association of include) {
      if (["machine", "technician"].includes(association.as)) {
        const target = model.associations[association.as].target;
        for (const key of ["name", "machineCode", "productionLine"]) {
          if (target.rawAttributes[key])
            expressions.push(
              `${quote(association.as)}.${quote(target.rawAttributes[key].field || key)}::text`,
            );
        }
      }
    }
    clauses.push(
      literal(
        `(${expressions.map((expression) => `${expression} ILIKE ${escaped(term)} ESCAPE '\\'`).join(" OR ")})`,
      ),
    );
  }
  for (const key of ["status", "category", "machineId", "technicianId"]) {
    if (req.query[key] && attributes[key]) {
      if (typeof req.query[key] !== "string" || req.query[key].length > 200)
        throw new HttpError(422, `Invalid ${key} filter`);
      const values = attributes[key].values || attributes[key].type?.values;
      if (values && !values.includes(req.query[key]))
        throw new HttpError(422, `Invalid ${key} filter`);
      clauses.push({ [key]: req.query[key] });
    }
  }
  if (req.query.activeTasks === "true" && attributes.status)
    clauses.push({ status: { [Op.notIn]: ["Closed", "Cancelled"] } });
  if (req.query.unitTypes && attributes.data) {
    const types = String(req.query.unitTypes).split(",");
    const unitType = `COALESCE(${col("data")}->>'unitType', CASE ${col("module")} WHEN 'organization' THEN 'Company' WHEN 'factories' THEN 'Factory' WHEN 'departments' THEN 'Department' WHEN 'production-lines' THEN 'Production Line' END)`;
    clauses.push(literal(`${unitType} IN (${types.map(escaped).join(",")})`));
  }
  const sortable = [
    "id",
    "name",
    "code",
    "status",
    "createdAt",
    "updatedAt",
    "occurredAt",
    "startedAt",
    "dueAt",
    "machineCode",
    "category",
    "priority",
    "issue",
    "quantity",
    "unitCost",
  ];
  if (
    req.query.sortBy &&
    (!sortable.includes(req.query.sortBy) || !attributes[req.query.sortBy])
  )
    throw new HttpError(422, "Invalid sort field");
  if (
    req.query.sortDirection &&
    !["asc", "desc"].includes(String(req.query.sortDirection).toLowerCase())
  )
    throw new HttpError(422, "Invalid sort direction");
  const order = req.query.sortBy
    ? [
        [
          req.query.sortBy,
          String(req.query.sortDirection || "asc").toUpperCase(),
        ],
      ]
    : find.order || [[attributes.createdAt ? "createdAt" : "id", "DESC"]];
  const result = await model.findAndCountAll({
    ...find,
    where: { [Op.and]: clauses },
    order: [...order, ["id", "ASC"]],
    distinct: true,
    ...(page.pageSize === undefined
      ? {}
      : { limit: page.pageSize, offset: page.offset }),
    subQuery: false,
  });
  return {
    result: result.rows.map(present),
    total: result.count,
    page: page.page,
    pageSize: page.pageSize ?? result.count,
    totalPages: page.pageSize
      ? Math.max(1, Math.ceil(result.count / page.pageSize))
      : 1,
  };
}

// Aggregated reports must finish their calculations before paging their result groups.
function pageRows(rows, query = {}) {
  const page = pagination(query);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (query.sortBy && rows.length && !keys.includes(query.sortBy))
    throw new HttpError(422, "Invalid report sort field");
  if (
    query.sortDirection &&
    !["asc", "desc"].includes(String(query.sortDirection).toLowerCase())
  )
    throw new HttpError(422, "Invalid sort direction");
  const sorted = query.sortBy
    ? [...rows].sort(
        (a, b) =>
          String(a[query.sortBy] ?? "").localeCompare(
            String(b[query.sortBy] ?? ""),
            "en",
            { numeric: true },
          ) * (String(query.sortDirection).toLowerCase() === "desc" ? -1 : 1),
      )
    : rows;
  return {
    rows:
      page.pageSize === undefined
        ? sorted
        : sorted.slice(page.offset, page.offset + page.pageSize),
    total: rows.length,
    page: page.page,
    pageSize: page.pageSize ?? rows.length,
    totalPages: page.pageSize
      ? Math.max(1, Math.ceil(rows.length / page.pageSize))
      : 1,
    availableColumns: keys,
  };
}

module.exports = { pagination, scopeWhere, listRecords, pageRows };
