const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
test(
  "shared appearance: real login, account isolation, membership, mode and validation",
  { skip: process.env.MMMS_INTEGRATION_TEST !== "true" },
  async () => {
    assert.equal(process.env.DB_HOST, "127.0.0.1");
    assert.equal(process.env.DB_PORT, "55432");
    process.env.DB_NAME = "mmms_auth_workflow_test";
    const {
      sequelize,
      User,
      BrandingAccount,
      UserAppearance,
      Vendor,
    } = require("../../authguardv2-node/src/models");
    const bcrypt = require("../../authguardv2-node/node_modules/bcryptjs");
    const {
      defaultTheme,
    } = require("../../authguardv2-node/src/services/appearance-validation");
    const base = process.env.MMMS_TEST_AUTH_URL;
    const request = async (path, method, body, token) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const login = async (employeeCode) => {
      const response = await request("/users/login", "POST", {
        employeeCode,
        authCode: "mmms-local-browser-test",
      });
      assert.equal(response.status, 200, JSON.stringify(response));
      const data = response.body.data || response.body;
      return data.accessToken || data.token;
    };
    const suffix = randomUUID().slice(0, 8);
    const users = [];
    const vendorIds = [];
    let account;
    try {
      for (let i = 0; i < 3; i++)
        users.push(
          await User.create({
            employeeCode: "THEME-" + suffix + "-" + i,
            employeeName: "Theme isolation " + suffix + " " + i,
            authCode: await bcrypt.hash("mmms-local-browser-test", 10),
          }),
        );
      const admin = await login("MMMS-TEST"),
        a = await login(users[0].employeeCode),
        b = await login(users[1].employeeCode),
        c = await login(users[2].employeeCode);
      const org = randomUUID(), factory = randomUUID(), otherFactory = randomUUID();
      for (let index = 0; index < 3; index++) {
        const vendor = await Vendor.create({ code: `PAGE-${suffix}-${index}`, name: `Vendor page ${suffix} ${index}`, organizationId: org, factoryId: index < 2 ? factory : otherFactory });
        vendorIds.push(vendor.id);
      }
      const vendorPage = await request(`/vendors?pageSize=1&search=${suffix}`, 'GET', null, admin);
      assert.equal(vendorPage.status, 200);
      assert.equal(vendorPage.body.total, 3);
      assert.equal(vendorPage.body.result.length, 1);
      const vendorService = require('../../authguardv2-node/src/services/vendor.service');
      const scoped = { query: { pageSize: '1', page: '2', search: suffix }, authClaims: { permissions: ['MMMS-VENDORS'], accessScopes: [{ applicationName: 'MMMS', organizationId: org, factoryId: factory }] } };
      const scopedPage = await vendorService.listPage(scoped);
      assert.equal(scopedPage.total, 2);
      assert.equal(scopedPage.result[0].id, vendorIds[1]);
      assert.equal((await vendorService.listPage({ ...scoped, authClaims: { permissions: ['MMMS-VENDORS'], accessScopes: [] } })).total, 0);
      assert.equal((await request('/vendors?pageSize=101', 'GET', null, admin)).status, 422);
      assert.equal((await request("/appearance", "GET")).status, 401);
      assert.equal(
        (await request("/appearance/management", "GET", null, a)).status,
        403,
      );
      const theme = structuredClone(defaultTheme);
      theme.font = "arial";
      theme.cardRadius = 22;
      theme.defaultMode = "dark";
      theme.light.primary = "#7046a0";
      theme.dark.primary = "#c3a1ed";
      let result = await request(
        "/appearance/accounts",
        "POST",
        { name: "Vendor " + suffix, code: "THEME-" + suffix, theme },
        admin,
      );
      assert.equal(result.status, 201, JSON.stringify(result));
      account = result.body.result;
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id + "/members",
            "PUT",
            { userIds: users.slice(0, 2).map((user) => String(user.id)) },
            a,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id + "/members",
            "PUT",
            { userIds: users.slice(0, 2).map((user) => String(user.id)) },
            admin,
          )
        ).status,
        200,
      );
      for (const token of [a, b]) {
        result = await request("/appearance", "GET", null, token);
        assert.equal(result.body.result.account.id, account.id);
        assert.deepEqual(result.body.result.theme, theme);
      }
      assert.equal(
        (await request("/appearance", "GET", null, c)).body.result.account,
        null,
      );
      for (const mode of ["light", "dark", "system", "inherit"]) {
        result = await request(
          "/appearance/mode",
          "PUT",
          { mode, userId: users[1].id },
          a,
        );
        assert.equal(result.status, 200);
        assert.equal(result.body.result.mode, mode);
        assert.equal(
          (await request("/appearance", "GET", null, b)).body.result.mode,
          "inherit",
        );
      }
      assert.equal(
        (await request("/appearance/mode", "PUT", { mode: "injected" }, a))
          .status,
        422,
      );
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id,
            "PUT",
            { ...account, revision: 0 },
            admin,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id,
            "PUT",
            { ...account, theme: { ...theme, font: "unsafe" } },
            admin,
          )
        ).status,
        422,
      );
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id + "/members",
            "PUT",
            { userIds: [users[0].id, users[0].id] },
            admin,
          )
        ).status,
        422,
      );
      assert.equal(
        (
          await request(
            "/appearance/accounts/" + account.id + "/members",
            "PUT",
            { userIds: [String(users[0].id)] },
            admin,
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/appearance", "GET", null, b)).body.result.account,
        null,
      );
      assert.equal(
        (await request("/appearance", "GET", null, a)).body.result.account.id,
        account.id,
      );
    } finally {
      if (vendorIds.length) await Vendor.destroy({ where: { id: vendorIds } });
      if (account) await BrandingAccount.destroy({ where: { id: account.id } });
      for (const user of users) {
        await UserAppearance.destroy({ where: { userId: user.id } });
        await user.destroy();
      }
      await sequelize.close();
    }
  },
);
