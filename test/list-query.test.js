const test = require('node:test');
const assert = require('node:assert/strict');
const { pagination, pageRows } = require('../src/services/list-query');

test('pagination rejects invalid and excessive sizes, offsets and unsafe integers', () => {
  for (const query of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { pageSize: '101' }, { pageSize: 'abc' }, { offset: '-1' }, { page: String(Number.MAX_SAFE_INTEGER), pageSize: '100' }]) {
    assert.throws(() => pagination(query), { status: 422 });
  }
  assert.deepEqual(pagination({ page: '3', pageSize: '25' }), { page: 3, pageSize: 25, offset: 50 });
  assert.deepEqual(pagination({ page: '2' }), { page: 2, pageSize: 25, offset: 25 });
});

test('aggregate reports sort the full result before paging and retain full totals', () => {
  const rows = [{ name: 'Machine 10' }, { name: 'Machine 2' }, { name: 'Machine 1' }];
  const result = pageRows(rows, { page: '2', pageSize: '1', sortBy: 'name', sortDirection: 'asc' });
  assert.deepEqual(result.rows, [{ name: 'Machine 2' }]);
  assert.equal(result.total, 3);
  assert.equal(result.totalPages, 3);
  assert.equal(pageRows(rows, {}).rows.length, 3, 'Exports and existing lookup calls keep their full dataset');
  assert.throws(() => pageRows(rows, { sortBy: 'untrusted' }), { status: 422 });
});
