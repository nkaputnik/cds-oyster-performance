function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(req) {
  let cursor = req.data.cursor, left = req.data.count, checksum = 0;
  while (left > 0) {
    const rows = await SELECT.from(this.entities.NoHandlerLargeRows).columns('ID', 'value')
      .where`ID > ${cursor}`.orderBy('ID').limit(Math.min(req.data.pageSize, left));
    if (!rows.length) req.reject(400, 'Scan requested more rows than exist');
    for (const row of rows) checksum = (checksum + cpu(row.value, req.data.iterations === undefined ? 100 : req.data.iterations)) & 2147483647;
    left -= rows.length; cursor = rows[rows.length - 1].ID;
  }
  return checksum;
};
