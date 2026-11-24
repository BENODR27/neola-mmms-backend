const indexes = [
  ['mmms_master_records', ['module', 'createdAt', 'id'], 'mmms_records_module_created_page'],
  ['mmms_master_records', ['module', 'name', 'id'], 'mmms_records_module_name_page'],
  ['mmms_machines', ['name', 'id'], 'mmms_machines_name_page'],
  ['mmms_work_orders', ['technician_id', 'updated_at', 'id'], 'mmms_orders_mechanic_page'],
  ['mmms_machine_history', ['machine_id', 'occurred_at', 'id'], 'mmms_history_machine_page'],
];

module.exports = {
  async up(queryInterface) {
    for (const [table, fields, name] of indexes) {
      const existing = await queryInterface.showIndex(table);
      if (!existing.some((index) => index.name === name)) await queryInterface.addIndex(table, fields, { name });
    }
  },
  async down(queryInterface) {
    for (const [table, , name] of [...indexes].reverse()) await queryInterface.removeIndex(table, name);
  },
};
