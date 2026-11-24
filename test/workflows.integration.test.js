const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

test(
  "database-backed maintenance workflows",
  { skip: process.env.MMMS_INTEGRATION_TEST !== "true" },
  async (t) => {
    assert.equal(
      process.env.MMMS_DB_NAME,
      "mmms_workflow_test",
      "Integration tests must use the isolated test database",
    );
    assert.equal(process.env.DB_HOST, "127.0.0.1");
    process.env.JWT_SECRET = "mmms-isolated-integration-test-secret-only";
    process.env.NODE_ENV = "test";
    process.env.MMMS_RATE_LIMIT_MAX = "2000";
    const jwt = require("jsonwebtoken");
    const models = require("../src/models");
    const {
      sequelize,
      MasterRecord,
      Machine,
      MachineHistory,
      WorkOrder,
      Technician,
      SparePart,
    } = models;
    await sequelize.authenticate();
    const app = require("../src/app");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    const sign = (claims) =>
      jwt.sign(
        { sub: "integration-supervisor", ...claims },
        process.env.JWT_SECRET,
        {
          issuer: "platform-iam",
          audience: "platform-applications",
          expiresIn: "5m",
        },
      );
    let token = sign({ permissions: ["*"] });
    if (process.env.MMMS_TEST_AUTH_URL) {
      const response = await fetch(
        `${process.env.MMMS_TEST_AUTH_URL}/users/login`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-application-name": "MMMS",
          },
          body: JSON.stringify({
            employeeCode: "MMMS-TEST",
            authCode: "mmms-local-browser-test",
          }),
        },
      );
      const body = await response.json();
      assert.equal(
        response.status,
        200,
        "Real AuthGuard test login must succeed",
      );
      token = (body.data || body).accessToken || (body.data || body).token;
      assert.ok(token);
    }
    const request = async (path, method = "GET", body, accessToken = token) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = response.status === 204 ? null : await response.json();
      return { status: response.status, ...data };
    };
    const ok = (response, status = 200) => {
      assert.equal(response.status, status, JSON.stringify(response));
      return response.result;
    };
    const organizationId = randomUUID();
    const factoryId = randomUUID();
    const destinationId = randomUUID();
    const machineId = randomUUID();
    const technicianId = randomUUID();
    const scope = { organizationId, factoryId };
    const createdIds = [];
    try {
      for (const [id, module, name, factory] of [
        [organizationId, "organization", "Test company", null],
        [factoryId, "factories", "Source factory", factoryId],
        [destinationId, "factories", "Destination factory", destinationId],
      ]) {
        await MasterRecord.create({
          id,
          module,
          name,
          status: "Active",
          organizationId,
          factoryId: factory,
          data: { organizationId },
        });
      }
      await Machine.create({
        id: machineId,
        assetNumber: machineId,
        machineCode: machineId,
        qrReference: randomUUID(),
        name: "Workflow test machine",
        category: "Sewing",
        ...scope,
        factory: "Source factory",
        currentLocation: "Bay 1",
        status: "Running",
      });
      await Technician.create({
        id: technicianId,
        employeeNumber: technicianId,
        name: "Test mechanic",
        factory: "Source factory",
        ...scope,
        active: true,
      });

      await t.test('database paging counts only authorized matches, including JSON scope and transfer destinations', async () => {
        const prefix = `Paging-${randomUUID()}`;
        const ids = [];
        for (let index = 0; index < 51; index++) {
          const legacy = index >= 37 && index < 40;
          const record = await MasterRecord.create({ module: 'departments', name: `${prefix} ${String(index).padStart(2, '0')}`, status: 'Active',
            ...(legacy ? {} : { organizationId, factoryId: index < 40 ? factoryId : destinationId }),
            data: legacy ? { organizationId, factoryId } : {},
          });
          if (index < 40) ids.push(record.id);
        }
        const access = sign({ permissions: ['MMMS-DEPARTMENTS', 'MMMS-TRANSFERS', 'MMMS-ORGANIZATION'], accessScopes: [{ applicationName: 'MMMS', organizationId, factoryId }] });
        const query = `search=${encodeURIComponent(prefix)}&organizationId=${organizationId}&factoryId=${factoryId}&pageSize=10&sortBy=name&sortDirection=asc`;
        const seen = [];
        for (let page = 1; page <= 4; page++) {
          const response = await request(`/master-data/departments?${query}&page=${page}`, 'GET', null, access);
          assert.equal(response.status, 200, JSON.stringify(response));
          assert.equal(response.total, 40);
          assert.equal(response.totalPages, 4);
          assert.equal(response.result.length, 10);
          seen.push(...response.result.map((row) => row.id));
        }
        assert.deepEqual(seen, ids);
        assert.equal(new Set(seen).size, 40);
        const empty = await request(`/master-data/departments?${query}&page=5`, 'GET', null, access);
        assert.equal(empty.total, 40); assert.deepEqual(empty.result, []);
        assert.equal((await request(`/master-data/departments?${query}&pageSize=101`, 'GET', null, access)).status, 422);
        assert.equal((await request(`/master-data/departments?${query}&sortBy=not-a-column`, 'GET', null, access)).status, 422);
        const noScope = sign({ permissions: ['MMMS-DEPARTMENTS'], accessScopes: [] });
        assert.equal((await request(`/master-data/departments?${query}`, 'GET', null, noScope)).total, 0);
        const literal = await MasterRecord.create({ module: 'departments', name: `${prefix} 100%_literal`, status: 'Active', ...scope });
        const literalPage = await request(`/master-data/departments?pageSize=10&search=${encodeURIComponent(prefix + ' 100%_')}`, 'GET', null, access);
        assert.deepEqual(literalPage.result.map((row) => row.id), [literal.id]);
        const company = await MasterRecord.create({ module: 'organization', name: `${prefix} parent`, status: 'Active', organizationId });
        const parentPage = await request(`/master-data/organization?${query}`, 'GET', null, access);
        assert.deepEqual(parentPage.result.map((row) => row.id), [company.id]);
        const incoming = await MasterRecord.create({ module: 'transfers', name: `${prefix} incoming`, status: 'Submitted', organizationId, factoryId: destinationId,
          data: { destination: { organizationId, factoryId } },
        });
        const transferPage = await request(`/master-data/transfers?${query}`, 'GET', null, access);
        assert.equal(transferPage.total, 1);
        assert.equal(transferPage.result[0].id, incoming.id);
        for (const route of ['/machines', '/work-orders', '/breakdowns', '/technicians', '/spare-parts', '/preventive-maintenance', '/expenses', '/master-data/inspections', '/master-data/calibration', '/master-data/notifications', '/vendor-services', '/hierarchy', '/production-integration']) {
          const response = await request(`${route}?page=1&pageSize=1`);
          assert.equal(response.status, 200, route + JSON.stringify(response));
          assert.ok(response.result.length <= 1, route);
          assert.equal(typeof response.total, 'number', route);
        }
        await Technician.update({ details: { userCode: require('jsonwebtoken').decode(token).sub } }, { where: { id: technicianId } });
        const personalIds = [];
        for (let index = 0; index < 3; index++) {
          const id = randomUUID();
          await WorkOrder.create({ id, machineId, issue: `${prefix} personal ${index}`, status: 'Draft', ...scope,
            technicianId: index === 0 ? technicianId : null, details: { team: index === 1 ? [technicianId] : [] },
          });
          if (index < 2) personalIds.push(id);
        }
        const personalPage = await request(`/work-orders?personal=true&activeTasks=true&pageSize=1&search=${encodeURIComponent(prefix)}`);
        assert.equal(personalPage.status, 200, JSON.stringify(personalPage));
        assert.equal(personalPage.total, 2);
        assert.equal(personalPage.result.length, 1);
        assert.ok(personalIds.includes(personalPage.result[0].id));
        const reportPage = ok(await request('/reports/data/machine-master?pageSize=1'));
        const reportExport = ok(await request('/reports/data/machine-master?export=true&pageSize=1'));
        assert.ok(reportPage.rows.length <= 1);
        assert.equal(reportExport.rows.length, reportExport.total);
        assert.equal(reportPage.total, reportExport.total);
      });
      await t.test(
        "hierarchy, registration, QR access and atomic bulk import work against a fresh schema",
        async () => {
          const company = ok(
            await request("/hierarchy", "POST", {
              unitType: "Company",
              name: "Hierarchy test company",
              code: randomUUID(),
            }),
            201,
          );
          let parent = company;
          let factory;
          for (const unitType of [
            "Business Unit",
            "Factory",
            "Building",
            "Floor",
            "Department",
            "Production Section",
            "Production Line",
            "Machine Location",
          ]) {
            parent = ok(
              await request("/hierarchy", "POST", {
                unitType,
                name: unitType + " integration",
                code: randomUUID(),
                parentId: parent.id,
                manager: "Responsible manager",
              }),
              201,
            );
            if (unitType === "Factory") factory = parent;
          }
          const payload = {
            organizationId: company.id,
            factoryId: factory.id,
            name: "Imported sewing machine",
            category: "Overlock",
          };
          const registered = ok(
            await request("/machines", "POST", payload),
            201,
          );
          assert.match(registered.qrReference, /^MMMS-/);
          assert.equal(
            ok(await request(`/machines/qr/${registered.qrReference}`)).id,
            registered.id,
          );
          assert.equal(
            (
              await request(`/machines/${registered.id}`, "PUT", {
                qrReference: "forged",
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await request(`/machines/${registered.id}`, "PUT", {
                currentLocation: "Bypass transfer",
              })
            ).status,
            422,
          );
          const assetNumber = randomUUID();
          const batch = await request("/machines/createBatch", "POST", [
            { ...payload, assetNumber },
            { ...payload, assetNumber },
          ]);
          assert.equal(batch.status, 400);
          assert.equal(await Machine.count({ where: { assetNumber } }), 0);
          assert.equal(
            (
              await request("/hierarchy", "POST", {
                unitType: "Factory",
                name: "Invalid parent",
                code: randomUUID(),
                parentId: parent.id,
              })
            ).status,
            422,
          );
        },
      );
      await t.test(
        "allocation approval changes the machine and retains history",
        async () => {
          const row = ok(
            await request("/master-data/allocations", "POST", {
              machineId,
              reason: "Line balancing",
              destination: {
                factoryId,
                currentLocation: "Line 2",
                responsiblePerson: "Line manager",
              },
            }),
            201,
          );
          createdIds.push(row.id);
          ok(
            await request(
              `/master-data/allocations/${row.id}/workflow`,
              "PATCH",
              { status: "Pending Approval" },
            ),
          );
          ok(
            await request(
              `/master-data/allocations/${row.id}/workflow`,
              "PATCH",
              { status: "Approved" },
            ),
          );
          assert.equal(
            (await Machine.findByPk(machineId)).currentLocation,
            "Line 2",
          );
          assert.equal(
            await MachineHistory.count({
              where: { machineId, eventType: "allocations" },
            }),
            3,
          );
          assert.equal(
            (await request(`/master-data/allocations/${row.id}`, "DELETE"))
              .status,
            405,
          );
        },
      );

      await t.test(
        "transfer requires approval, receiving scope, and preserves QR identity",
        async () => {
          const before = await Machine.findByPk(machineId);
          const row = ok(
            await request("/master-data/transfers", "POST", {
              machineId,
              reason: "Factory capacity",
              destination: {
                factoryId: destinationId,
                currentLocation: "Receiving bay",
              },
            }),
            201,
          );
          createdIds.push(row.id);
          assert.equal(
            (
              await request(
                `/master-data/transfers/${row.id}/workflow`,
                "PATCH",
                { status: "Received" },
              )
            ).status,
            422,
          );
          for (const status of [
            "Submitted",
            "Pending Approval",
            "Approved",
            "In Transit",
          ])
            ok(
              await request(
                `/master-data/transfers/${row.id}/workflow`,
                "PATCH",
                { status },
              ),
            );
          assert.equal(
            (await Machine.findByPk(machineId)).factoryId,
            factoryId,
          );
          const sourceOnly = sign({
            permissions: ["MMMS-TRANSFERS", "MMMS-TRANSFERS-RECEIVE"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await request(
                `/master-data/transfers/${row.id}/workflow`,
                "PATCH",
                { status: "Received" },
                sourceOnly,
              )
            ).status,
            403,
          );
          ok(
            await request(
              `/master-data/transfers/${row.id}/workflow`,
              "PATCH",
              { status: "Received" },
            ),
          );
          ok(
            await request(
              `/master-data/transfers/${row.id}/workflow`,
              "PATCH",
              { status: "Completed" },
            ),
          );
          const after = await Machine.findByPk(machineId);
          assert.equal(after.factoryId, destinationId);
          assert.equal(after.qrReference, before.qrReference);
          await after.update({ factoryId, factory: "Source factory" });
        },
      );

      let workOrder;
      await t.test(
        "work order persists assignment, repair, supervisor verification and history",
        async () => {
          workOrder = ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Repair test motor",
              status: "Draft",
            }),
            201,
          );
          for (const status of [
            "Submitted",
            "Approved",
            "Assigned",
            "In Progress",
          ])
            ok(
              await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
                status,
                technicianId,
              }),
            );
          assert.equal(
            (await WorkOrder.findByPk(workOrder.id)).technicianId,
            technicianId,
          );
          assert.equal(
            (
              await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
                status: "Completed",
              })
            ).status,
            422,
          );
          ok(
            await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
              status: "Completed",
              diagnosis: "Worn bearing",
              repairNotes: "Bearing replaced",
              completionNotes: "Safety test passed",
            }),
          );
          assert.equal(
            (
              await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
                status: "Closed",
              })
            ).status,
            422,
          );
          const mechanic = sign({
            permissions: ["MMMS-WORK-ORDERS"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await request(
                `/work-orders/${workOrder.id}/workflow`,
                "PATCH",
                { status: "Verified", verificationNotes: "OK" },
                mechanic,
              )
            ).status,
            403,
          );
          ok(
            await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
              status: "Verified",
              verificationNotes: "Production run checked",
            }),
          );
          ok(
            await request(`/work-orders/${workOrder.id}/workflow`, "PATCH", {
              status: "Closed",
            }),
          );
          assert.equal((await Machine.findByPk(machineId)).status, "Running");
          assert.equal(
            (
              await request(`/work-orders/${workOrder.id}`, "PUT", {
                issue: "Rewrite history",
              })
            ).status,
            422,
          );
        },
      );

      await t.test(
        "stock reservation, consumption and concurrent requests cannot oversell",
        async () => {
          const order = ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Parts test",
            }),
            201,
          );
          const part = ok(
            await request("/spare-parts", "POST", {
              ...scope,
              name: "Bearing",
              category: "Mechanical",
              unitCost: 12.5,
              details: { partCode: "BRG-01" },
            }),
            201,
          );
          const post = (body) =>
            request(`/spare-parts/${part.id}/transactions`, "POST", {
              requestId: randomUUID(),
              reason: "Integration workflow",
              ...body,
            });
          ok(await post({ type: "Receipt", quantity: 10 }), 201);
          const reservation = ok(
            await post({
              type: "Reservation",
              quantity: 6,
              workOrderId: order.id,
            }),
            201,
          );
          assert.equal(
            (await post({ type: "Issue", quantity: 5 })).status,
            409,
          );
          const requestId = randomUUID();
          const consumption = {
            requestId,
            type: "Consumption",
            quantity: 6,
            workOrderId: order.id,
            reservationId: reservation.id,
          };
          const consumed = ok(await post(consumption), 201);
          ok(await post(consumption), 201);
          assert.equal(
            Number((await WorkOrder.findByPk(order.id)).partsCost),
            75,
          );
          const results = await Promise.all([
            post({ type: "Issue", quantity: 3 }),
            post({ type: "Issue", quantity: 3 }),
          ]);
          assert.deepEqual(
            results.map((item) => item.status).sort(),
            [201, 409],
          );
          const current = await SparePart.findByPk(part.id);
          assert.equal(current.stockQuantity, 1);
          assert.equal(current.reservedQuantity, 0);
          ok(
            await post({
              type: "Return",
              quantity: 2,
              sourceTransactionId: consumed.id,
            }),
            201,
          );
          assert.equal(
            Number((await WorkOrder.findByPk(order.id)).partsCost),
            50,
          );
          assert.equal((await SparePart.findByPk(part.id)).stockQuantity, 3);
          assert.equal(
            (
              await request(`/spare-parts/${part.id}`, "PUT", {
                stockQuantity: 100,
              })
            ).status,
            422,
          );
        },
      );
      await t.test(
        "recurring maintenance produces durable occurrences without duplicates",
        async () => {
          const date = new Date(Date.now() - 2 * 86400000).toISOString();
          const plan = ok(
            await request("/preventive-maintenance", "POST", {
              machineId,
              task: "Daily lubrication",
              frequency: "Daily",
              nextDue: date,
              details: { checklist: ["Oil level", "Safety guard"] },
            }),
            201,
          );
          const first = ok(
            await request(
              `/preventive-maintenance/${plan.id}/generate`,
              "POST",
              {},
            ),
          );
          assert.equal(first.length, 3);
          assert.equal(
            ok(
              await request(
                `/preventive-maintenance/${plan.id}/generate`,
                "POST",
                {},
              ),
            ).length,
            0,
          );
          const occurrences = ok(
            await request(`/preventive-maintenance/${plan.id}/occurrences`),
          );
          assert.equal(occurrences.length, 3);
          const orderId = occurrences[0].workOrderId;
          for (const status of ["Approved", "Assigned", "In Progress"])
            ok(
              await request(`/work-orders/${orderId}/workflow`, "PATCH", {
                status,
                technicianId,
              }),
            );
          const completion = {
            status: "Completed",
            diagnosis: "Routine service",
            repairNotes: "Lubricated",
            completionNotes: "Tested",
          };
          assert.equal(
            (
              await request(
                `/work-orders/${orderId}/workflow`,
                "PATCH",
                completion,
              )
            ).status,
            422,
          );
          ok(
            await request(`/work-orders/${orderId}/workflow`, "PATCH", {
              ...completion,
              details: {
                checklistResults: {
                  "Oil level": "Pass",
                  "Safety guard": "Pass",
                },
              },
            }),
          );
          ok(
            await request(`/work-orders/${orderId}/workflow`, "PATCH", {
              status: "Verified",
              verificationNotes: "Checked",
            }),
          );
          ok(
            await request(`/work-orders/${orderId}/workflow`, "PATCH", {
              status: "Closed",
            }),
          );
          assert.equal(
            ok(
              await request(`/preventive-maintenance/${plan.id}/occurrences`),
            ).find((row) => row.workOrderId === orderId).status,
            "Completed",
          );
        },
      );
      await t.test(
        "inspection failures generate exactly one corrective work order",
        async () => {
          const inspection = ok(
            await request("/master-data/inspections", "POST", {
              machineId,
              type: "Safety Inspection",
              dueAt: new Date().toISOString(),
              checklist: ["Guard", "Emergency stop"],
            }),
            201,
          );
          const path = `/master-data/inspections/${inspection.id}/complete`;
          assert.equal(
            (await request(path, "POST", { results: { Guard: "Pass" } }))
              .status,
            422,
          );
          const payload = {
            results: { Guard: "Pass", "Emergency stop": "Fail" },
            observations: "Replace switch",
          };
          const completed = ok(await request(path, "POST", payload));
          assert.equal(completed.result, "Fail");
          assert.ok(completed.workOrderId);
          assert.equal(
            ok(await request(path, "POST", payload)).workOrderId,
            completed.workOrderId,
          );
          assert.equal(
            (await WorkOrder.findByPk(completed.workOrderId)).details.type,
            "Corrective Maintenance",
          );
        },
      );
      await t.test(
        "breakdown repair closure restores the machine and records downtime",
        async () => {
          const breakdown = ok(
            await request("/breakdowns", "POST", {
              machineId,
              category: "Motor Failure",
              startedAt: new Date(Date.now() - 3600000).toISOString(),
              details: { description: "Motor stopped", severity: "Critical" },
            }),
            201,
          );
          assert.equal((await Machine.findByPk(machineId)).status, "Breakdown");
          assert.equal(
            (
              await request(`/breakdowns/${breakdown.id}`, "PUT", {
                status: "Resolved",
              })
            ).status,
            422,
          );
          const orderId = breakdown.details.workOrderId;
          for (const status of [
            "Approved",
            "Assigned",
            "In Progress",
            "Completed",
            "Verified",
            "Closed",
          ])
            ok(
              await request(`/work-orders/${orderId}/workflow`, "PATCH", {
                status,
                technicianId,
                diagnosis: "Motor overload",
                repairNotes: "Motor replaced",
                completionNotes: "Load test passed",
                verificationNotes: "Confirmed",
              }),
            );
          const record = await models.Breakdown.findByPk(breakdown.id);
          assert.equal(record.status, "Resolved");
          assert.ok(new Date(record.endedAt) > new Date(record.startedAt));
          assert.equal(record.rootCause, "Motor overload");
        },
      );
      await t.test(
        "expenses, calibration certificates, notifications and filtered reports persist",
        async () => {
          const expense = ok(
            await request("/expenses", "POST", {
              machineId,
              category: "External Service Cost",
              amount: 125.5,
              currency: "USD",
              description: "Vendor service",
              occurredAt: new Date().toISOString(),
            }),
            201,
          );
          const calibration = ok(
            await request("/master-data/calibration", "POST", {
              machineId,
              type: "Pressure calibration",
              dueAt: new Date().toISOString(),
              agency: "Test laboratory",
            }),
            201,
          );
          assert.equal(
            (
              await request(
                `/master-data/calibration/${calibration.id}/complete`,
                "POST",
                { result: "Pass" },
              )
            ).status,
            422,
          );
          ok(
            await request(
              `/master-data/calibration/${calibration.id}/complete`,
              "POST",
              {
                result: "Pass",
                certificateNumber: "CERT-TEST-01",
                remarks: "Within tolerance",
              },
            ),
          );
          assert.equal(
            (
              await request(
                `/master-data/calibration/${calibration.id}/complete`,
                "POST",
                { result: "Fail", certificateNumber: "changed" },
              )
            ).status,
            422,
          );
          const report = ok(
            await request(
              `/reports/data/maintenance-costs?machineId=${machineId}`,
            ),
          );
          assert.ok(report.rows.some((row) => row.id === expense.id));
          assert.ok(report.rows.every((row) => row.machineId === machineId));
          const analytics = ok(
            await request(`/analytics?machineId=${machineId}`),
          );
          assert.equal(analytics.kpis.machineCount, 1);
          assert.equal(analytics.kpis.expensesByCurrency.USD, 175.5);
          assert.ok(analytics.kpis.downtimeHours > 0);
          await require("../src/services/maintenance-alerts").refreshAlerts();
          const notifications = ok(await request("/master-data/notifications"));
          assert.ok(notifications.length > 0);
          ok(
            await request(
              `/master-data/notifications/${notifications[0].id}/read`,
              "POST",
              {},
            ),
          );
          assert.equal(
            ok(await request("/master-data/notifications")).find(
              (row) => row.id === notifications[0].id,
            ).read,
            true,
          );
          assert.equal(
            (
              await request("/master-data/stock-transactions", "POST", {
                name: "Bypass stock ledger",
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "offline breakdown retries create one incident and one repair request",
        async () => {
          const requestId = randomUUID();
          const payload = {
            machineId,
            category: "Sensor Failure",
            details: { description: "Offline sensor fault", severity: "High" },
            requestId,
          };
          const results = await Promise.all([
            request("/breakdowns", "POST", payload),
            request("/breakdowns", "POST", payload),
          ]);
          const first = ok(results[0], 201);
          const second = ok(results[1], 201);
          assert.equal(first.id, second.id);
          assert.equal(first.details.workOrderId, second.details.workOrderId);
          assert.equal(
            (
              await request("/breakdowns", "POST", {
                ...payload,
                category: "Other",
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "shared vendor catalog, contracts, invoices and warranty workflows",
        { skip: !process.env.MMMS_TEST_AUTH_URL },
        async () => {
          const response = await fetch(
            `${process.env.MMMS_TEST_AUTH_URL}/vendors`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                code: randomUUID(),
                name: "Integration service vendor",
                category: "Maintenance",
                ...scope,
              }),
            },
          );
          assert.equal(response.status, 201);
          const vendor = (await response.json()).result;
          ok(
            await request(`/vendor-profiles/${vendor.id}`, "PUT", {
              ...scope,
              address: "Test industrial estate",
              contractDetails: "Annual maintenance",
              warrantyDetails: "One year",
              attachments: [],
            }),
          );
          const service = ok(
            await request("/vendor-services", "POST", {
              vendorId: vendor.id,
              machineId,
              description: "External motor service",
              amount: 80,
              type: "External Service",
            }),
            201,
          );
          ok(
            await request(`/vendor-services/${service.id}/status`, "POST", {
              status: "In Progress",
            }),
          );
          ok(
            await request(`/vendor-services/${service.id}/status`, "POST", {
              status: "Completed",
              remarks: "Repair verified",
              invoiceReference: "INV-TEST-01",
              rating: 5,
            }),
          );
          assert.equal(
            (
              await request(`/vendor-services/${service.id}/status`, "POST", {
                status: "Completed",
                remarks: "Duplicate",
              })
            ).status,
            422,
          );
          const expenses = ok(
            await request(
              `/reports/data/maintenance-costs?machineId=${machineId}`,
            ),
          ).rows;
          assert.equal(
            expenses.filter((row) => row.sourceVendorServiceId === service.id)
              .length,
            1,
          );
          const claim = ok(
            await request("/vendor-services", "POST", {
              vendorId: vendor.id,
              machineId,
              description: "Warranty motor replacement",
              amount: 0,
              type: "Warranty Claim",
            }),
            201,
          );
          ok(
            await request(`/vendor-services/${claim.id}/status`, "POST", {
              status: "Approved",
            }),
          );
          ok(
            await request(`/vendor-services/${claim.id}/status`, "POST", {
              status: "Resolved",
              remarks: "Replacement received under warranty",
            }),
          );
          const rejectedClaim = ok(await request('/vendor-services', 'POST', { vendorId: vendor.id, machineId, description: 'Warranty rejection branch', amount: 0, type: 'Warranty Claim' }), 201);
          const approveOnly = sign({ permissions: ['MMMS-VENDORS', 'MMMS-VENDORS-APPROVE'], accessScopes: [{ applicationName: 'MMMS', ...scope }] });
          assert.equal((await request('/vendor-services/' + rejectedClaim.id + '/status', 'POST', { status: 'Rejected', remarks: 'Outside coverage' }, approveOnly)).status, 403);
          ok(await request('/vendor-services/' + rejectedClaim.id + '/status', 'POST', { status: 'Rejected', remarks: 'Outside coverage' }));
        },
      );

      await t.test(
        "factory settings drive custom fields, notifications and calendar or usage recurrences",
        async () => {
          const setting = (key, value) =>
            request("/configuration/" + key, "PUT", { ...scope, value });
          ok(
            await setting("customFields", {
              "work-orders": [
                {
                  key: "permit",
                  label: "Safety permit",
                  type: "text",
                  required: true,
                },
              ],
            }),
          );
          assert.equal(
            (
              await request("/work-orders", "POST", {
                machineId,
                issue: "Missing permit",
              })
            ).status,
            422,
          );
          ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Configured permit",
              details: { customFields: { permit: "P-001" } },
            }),
            201,
          );
          ok(await setting("customFields", {}));
          ok(
            await setting("maintenanceFrequencies", [
              { name: "Fortnightly", unit: "Days", interval: 14 },
              { name: "Every 10 hours", unit: "Hours", interval: 10 },
            ]),
          );
          const calendar = ok(
            await request("/preventive-maintenance", "POST", {
              machineId,
              task: "Fortnight service",
              frequency: "Fortnightly",
              nextDue: new Date().toISOString(),
              details: { checklist: ["Oil"] },
            }),
            201,
          );
          const first = ok(
            await request(
              "/preventive-maintenance/" + calendar.id + "/generate",
              "POST",
              {},
            ),
          );
          assert.equal(first.length, 1);
          const reloaded = await models.PreventiveMaintenance.findByPk(
            calendar.id,
          );
          assert.ok(
            new Date(reloaded.nextDue) > new Date(Date.now() + 13 * 86400000),
          );
          await Machine.update(
            { operatingHours: 25 },
            { where: { id: machineId } },
          );
          const meter = ok(
            await request("/preventive-maintenance", "POST", {
              machineId,
              task: "Meter service",
              frequency: "Every 10 hours",
              nextDue: new Date().toISOString(),
              details: { checklist: ["Check motor"] },
            }),
            201,
          );
          assert.equal(
            ok(
              await request(
                "/preventive-maintenance/" + meter.id + "/generate",
                "POST",
                {},
              ),
            ).length,
            2,
          );
          assert.equal(
            ok(
              await request(
                "/preventive-maintenance/" + meter.id + "/generate",
                "POST",
                {},
              ),
            ).length,
            0,
          );
          ok(
            await setting("notificationRules", {
              "test-disabled": { enabled: false },
            }),
          );
          const before = await MasterRecord.count({
            where: { module: "notifications", ...scope },
          });
          await require("../src/services/maintenance-events").recordEvent({
            machine: await Machine.findByPk(machineId),
            type: "test-disabled",
            summary: "Disabled event",
            req: { auth: { sub: "test" } },
            notify: true,
          });
          assert.equal(
            await MasterRecord.count({
              where: { module: "notifications", ...scope },
            }),
            before,
          );
          assert.equal(
            (
              await setting("notificationRules", {
                invalid: { channels: ["UNKNOWN"] },
              })
            ).status,
            422,
          );
        },
      );
      await t.test(
        "location identities, personal task scope and export authorization remain enforced",
        async () => {
          const department = await MasterRecord.create({
            module: "departments",
            name: "Stable department",
            status: "Active",
            ...scope,
            data: { unitType: "Department" },
          });
          const movement = ok(
            await request("/master-data/allocations", "POST", {
              machineId,
              reason: "Department placement",
              destination: {
                factoryId,
                departmentId: department.id,
                currentLocation: "Final bay",
              },
            }),
            201,
          );
          for (const status of ["Pending Approval", "Approved"])
            ok(
              await request(
                "/master-data/allocations/" + movement.id + "/workflow",
                "PATCH",
                { status },
              ),
            );
          assert.equal(
            (await Machine.findByPk(machineId)).locationIds.departmentId,
            department.id,
          );
          const reader = sign({
            sub: "linked-mechanic",
            permissions: ["MMMS-WORK-ORDERS", "MMMS-REPORTS"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          await Technician.update(
            { details: { userCode: "linked-mechanic" } },
            { where: { id: technicianId } },
          );
          const own = await WorkOrder.create({
            id: randomUUID(),
            machineId,
            issue: "Own mobile task",
            status: "Assigned",
            technicianId,
            ...scope,
          });
          const tasks = ok(
            await request(
              "/work-orders?personal=true",
              "GET",
              undefined,
              reader,
            ),
          );
          assert.ok(tasks.some((row) => row.id === own.id));
          assert.ok(
            tasks.every(
              (row) =>
                row.technicianId === technicianId ||
                (row.details.team || []).includes(technicianId),
            ),
          );
          assert.equal(
            (
              await request(
                "/reports/data/work-orders?export=true",
                "GET",
                undefined,
                reader,
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        "audit failures roll back domain writes and concurrent read receipts preserve both actors",
        async () => {
          const create = MachineHistory.create;
          try {
            MachineHistory.create = async () => {
              throw new Error("Injected audit failure");
            };
            const response = await request("/machines", "POST", {
              ...scope,
              name: "Must roll back",
              category: "Sewing",
              assetNumber: "rollback-" + machineId,
            });
            assert.equal(response.status, 500);
          } finally {
            MachineHistory.create = create;
          }
          assert.equal(
            await Machine.count({
              where: { assetNumber: "rollback-" + machineId },
            }),
            0,
          );
          const notification = await MasterRecord.create({
            module: "notifications",
            name: "Concurrent readers",
            status: "Unread",
            ...scope,
            data: {},
          });
          const tokens = ["reader-a", "reader-b"].map((sub) =>
            sign({
              sub,
              permissions: ["MMMS-NOTIFICATIONS"],
              accessScopes: [{ applicationName: "MMMS", ...scope }],
            }),
          );
          const responses = await Promise.all(
            tokens.map((access) =>
              request(
                "/master-data/notifications/" + notification.id + "/read",
                "POST",
                {},
                access,
              ),
            ),
          );
          responses.forEach((response) => ok(response));
          assert.deepEqual((await notification.reload()).data.readBy.sort(), [
            "reader-a",
            "reader-b",
          ]);
        },
      );

      await t.test(
        "configured approval separation cannot be bypassed by a page permission",
        async () => {
          ok(
            await request("/configuration/approvalWorkflows", "PUT", {
              ...scope,
              value: {
                "work-orders": {
                  separateRequester: true,
                  approverEmployeeCodes: ["designated-approver"],
                },
              },
            }),
          );
          const order = ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Separated approval",
            }),
            201,
          );
          ok(
            await request("/work-orders/" + order.id + "/workflow", "PATCH", {
              status: "Submitted",
            }),
          );
          assert.equal(
            (
              await request("/work-orders/" + order.id + "/workflow", "PATCH", {
                status: "Approved",
              })
            ).status,
            403,
          );
          const approver = sign({
            sub: "designated-approver",
            permissions: ["MMMS-WORK-ORDERS", "MMMS-WORK-ORDERS-APPROVE"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          ok(
            await request(
              "/work-orders/" + order.id + "/workflow",
              "PATCH",
              { status: "Approved" },
              approver,
            ),
          );
        },
      );

      await t.test(
        "all stock transaction types reconcile both factories and preserve retry identity",
        async () => {
          const code = "LEDGER-" + randomUUID();
          const source = ok(
            await request("/spare-parts", "POST", {
              ...scope,
              name: "Ledger source",
              category: "Mechanical",
              unitCost: 4,
              details: { partCode: code },
            }),
            201,
          );
          const destination = ok(
            await request("/spare-parts", "POST", {
              organizationId,
              factoryId: destinationId,
              name: "Ledger destination",
              category: "Mechanical",
              unitCost: 4,
              details: { partCode: code },
            }),
            201,
          );
          const order = ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Ledger workflow",
            }),
            201,
          );
          const post = (type, quantity, extra = {}, access = token) =>
            request(
              "/spare-parts/" + source.id + "/transactions",
              "POST",
              {
                type,
                quantity,
                reason: "Ledger acceptance",
                requestId: randomUUID(),
                ...extra,
              },
              access,
            );
          ok(await post("Receipt", 10), 201);
          const reservation = ok(
            await post("Reservation", 3, { workOrderId: order.id }),
            201,
          );
          ok(
            await post("Consumption", 1, {
              workOrderId: order.id,
              reservationId: reservation.id,
            }),
            201,
          );
          ok(
            await post("Release", 2, {
              workOrderId: order.id,
              reservationId: reservation.id,
            }),
            201,
          );
          const issue = ok(await post("Issue", 2), 201);
          ok(await post("Return", 1, { sourceTransactionId: issue.id }), 201);
          ok(await post("Adjustment", 1, { direction: "Decrease" }), 201);
          const requestId = randomUUID();
          const transfer = ok(
            await post("Transfer", 2, {
              destinationPartId: destination.id,
              requestId,
            }),
            201,
          );
          assert.equal(
            ok(
              await post("Transfer", 2, {
                destinationPartId: destination.id,
                requestId,
              }),
              201,
            ).id,
            transfer.id,
          );
          assert.equal(
            (
              await post("Transfer", 1, {
                destinationPartId: destination.id,
                requestId,
              })
            ).status,
            409,
          );
          const after = await SparePart.findByPk(source.id);
          assert.equal(after.stockQuantity, 5);
          assert.equal(after.reservedQuantity, 0);
          assert.equal(
            (await SparePart.findByPk(destination.id)).stockQuantity,
            2,
          );
          assert.equal(
            Number((await WorkOrder.findByPk(order.id)).partsCost),
            4,
          );
          const storekeeper = sign({
            permissions: ["MMMS-SPARE-PARTS", "MMMS-SPARE-PARTS-TRANSACT"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await post(
                "Adjustment",
                1,
                { direction: "Increase" },
                storekeeper,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/work-orders/" + order.id, "PUT", {
                partsCost: 99,
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "assignment and reassignment permissions are enforced on ordinary update routes",
        async () => {
          const rejectedOrder = ok(
            await request("/work-orders", "POST", {
              machineId,
              issue: "Rejected branch",
              details: { requiredParts: ["Replacement belt"] },
            }),
            201,
          );
          assert.deepEqual(rejectedOrder.details.requiredParts, [
            "Replacement belt",
          ]);
          await WorkOrder.update(
            { status: "Completed", technicianId },
            { where: { id: rejectedOrder.id } },
          );
          const editorOnly = sign({
            permissions: ["MMMS-WORK-ORDERS", "MMMS-WORK-ORDERS-EDIT"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await request(
                "/work-orders/" + rejectedOrder.id,
                "PUT",
                {
                  status: "In Progress",
                  rejectionReason: "Repair requires rework",
                },
                editorOnly,
              )
            ).status,
            403,
          );
          ok(
            await request(
              "/work-orders/" + rejectedOrder.id + "/workflow",
              "PATCH",
              {
                status: "In Progress",
                rejectionReason: "Repair requires rework",
              },
            ),
          );
          const order = await WorkOrder.create({
            id: randomUUID(),
            machineId,
            issue: "Permission route matrix",
            status: "Approved",
            ...scope,
          });
          const editor = sign({
            permissions: ["MMMS-WORK-ORDERS", "MMMS-WORK-ORDERS-EDIT"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await request(
                "/work-orders/" + order.id,
                "PUT",
                { status: "Assigned", technicianId },
                editor,
              )
            ).status,
            403,
          );
          assert.equal((await order.reload()).status, "Approved");
          ok(
            await request("/work-orders/" + order.id + "/workflow", "PATCH", {
              status: "Assigned",
              technicianId,
            }),
          );
          const other = await Technician.create({
            id: randomUUID(),
            employeeNumber: randomUUID(),
            name: "Reassigned mechanic",
            active: true,
            ...scope,
          });
          assert.equal(
            (
              await request(
                "/work-orders/" + order.id,
                "PUT",
                { technicianId: other.id, rejectionReason: "Shift change" },
                editor,
              )
            ).status,
            403,
          );
          ok(
            await request("/work-orders/" + order.id, "PUT", {
              technicianId: other.id,
              rejectionReason: "Shift change",
            }),
          );
          assert.equal(
            (await order.reload()).details.assignmentHistory.length,
            1,
          );
          for (const status of [
            "In Progress",
            "On Hold",
            "In Progress",
            "Pending Spare Parts",
            "In Progress",
          ])
            ok(
              await request("/work-orders/" + order.id + "/workflow", "PATCH", {
                status,
                rejectionReason: "Operational hold",
              }),
            );
          ok(
            await request("/work-orders/" + order.id + "/workflow", "PATCH", {
              status: "On Hold",
              rejectionReason: "No longer needed",
            }),
          );
          ok(
            await request("/work-orders/" + order.id + "/workflow", "PATCH", {
              status: "Cancelled",
              rejectionReason: "Duplicate request",
            }),
          );
          assert.equal(
            (
              await request("/work-orders/" + order.id, "PUT", {
                issue: "Rewrite cancelled evidence",
              })
            ).status,
            422,
          );
        },
      );
      await t.test(
        "movement cancellation/rejection and destination validation leave machine location unchanged",
        async () => {
          const machine = ok(
            await request("/machines", "POST", {
              ...scope,
              name: "Movement branches",
              category: "Sewing",
            }),
            201,
          );
          const wrongDepartment = await MasterRecord.create({
            module: "departments",
            name: "Other site",
            status: "Active",
            organizationId,
            factoryId: destinationId,
            data: { unitType: "Department" },
          });
          assert.equal(
            (
              await request("/master-data/allocations", "POST", {
                machineId: machine.id,
                reason: "Invalid department",
                destination: {
                  factoryId,
                  departmentId: wrongDepartment.id,
                  currentLocation: "Bay X",
                },
              })
            ).status,
            422,
          );
          const cancelled = ok(
            await request("/master-data/transfers", "POST", {
              machineId: machine.id,
              reason: "Cancel branch",
              destination: {
                factoryId: destinationId,
                currentLocation: "Receiving",
              },
            }),
            201,
          );
          assert.equal(
            (
              await request(
                "/master-data/transfers/" + cancelled.id + "/workflow",
                "PATCH",
                { status: "Cancelled" },
              )
            ).status,
            422,
          );
          ok(
            await request(
              "/master-data/transfers/" + cancelled.id + "/workflow",
              "PATCH",
              { status: "Cancelled", reason: "Not required" },
            ),
          );
          const rejected = ok(
            await request("/master-data/transfers", "POST", {
              machineId: machine.id,
              reason: "Reject branch",
              destination: {
                factoryId: destinationId,
                currentLocation: "Receiving",
              },
            }),
            201,
          );
          for (const status of ["Submitted", "Pending Approval"])
            ok(
              await request(
                "/master-data/transfers/" + rejected.id + "/workflow",
                "PATCH",
                { status },
              ),
            );
          const approverOnly = sign({
            permissions: ["MMMS-TRANSFERS", "MMMS-TRANSFERS-APPROVE"],
            accessScopes: [{ applicationName: "MMMS", ...scope }],
          });
          assert.equal(
            (
              await request(
                "/master-data/transfers/" + rejected.id + "/workflow",
                "PATCH",
                { status: "Rejected", reason: "Capacity" },
                approverOnly,
              )
            ).status,
            403,
          );
          ok(
            await request(
              "/master-data/transfers/" + rejected.id + "/workflow",
              "PATCH",
              { status: "Rejected", reason: "Capacity" },
            ),
          );
          assert.equal(
            (await Machine.findByPk(machine.id)).factoryId,
            factoryId,
          );
          ok(await request("/machines/" + machine.id, "DELETE"), 204);
          assert.equal(
            (
              await request("/work-orders", "POST", {
                machineId: machine.id,
                issue: "Archived asset",
              })
            ).status,
            422,
          );
          assert.ok(
            ok(await request("/machines/" + machine.id + "/history")).length >
              0,
          );
        },
      );
      await t.test(
        "upcoming and overdue inspection/calibration/PM alerts are durable and deduplicated",
        async () => {
          const tomorrow = new Date(Date.now() + 3600000).toISOString(),
            yesterday = new Date(Date.now() - 3600000).toISOString();
          const ids = [];
          for (const [module, dueAt] of [
            ["inspections", tomorrow],
            ["calibration", tomorrow],
            ["pm-occurrences", yesterday],
          ]) {
            const row = await MasterRecord.create({
              module,
              name: "Alert acceptance",
              status: "Scheduled",
              ...scope,
              data: { machineId, dueAt },
            });
            ids.push(row.id);
          }
          const refresh =
            require("../src/services/maintenance-alerts").refreshAlerts;
          await refresh();
          await refresh();
          const alerts = (
            await MasterRecord.findAll({
              where: { module: "notifications", ...scope },
            })
          ).filter((row) => ids.includes(row.data.referenceId));
          assert.deepEqual(alerts.map((row) => row.data.event).sort(), [
            "calibration-due",
            "inspection-due",
            "preventive-maintenance-overdue",
          ]);
        },
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      // This disposable database is retained until the local test container is stopped.
      await sequelize.close();
    }
  },
);
