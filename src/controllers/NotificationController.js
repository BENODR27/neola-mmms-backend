const { listRecords } = require("../services/list-query");
const { MasterRecord, sequelize } = require("../models");
const {
  filterRecords,
  assertRecordAccess,
} = require("../middleware/data-scope");
const HttpError = require("../errors/http-error");
class NotificationController {
  async list(req, res) {
    const actorId = String(req.auth?.sub || "system");
    res.json(
      await listRecords(req, MasterRecord, {
        where: { module: "notifications" },
        present: (row) => ({
          ...row.data,
          id: row.id,
          title: row.name,
          createdAt: row.createdAt,
          read: (row.data.readBy || []).includes(actorId),
        }),
      }),
    );
  }
  async read(req, res) {
    const row = await sequelize.transaction(async (transaction) => {
      const row = await MasterRecord.findOne({
        where: { id: req.params.id, module: "notifications" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new HttpError(404, "Notification not found");
      assertRecordAccess(req, row);
      await row.update(
        {
          data: {
            ...row.data,
            readBy: [
              ...new Set([
                ...(row.data.readBy || []),
                String(req.auth?.sub || "system"),
              ]),
            ],
          },
        },
        { transaction },
      );
      return row;
    });
    res.json({ result: { id: row.id, read: true } });
  }
}
module.exports = new NotificationController();
