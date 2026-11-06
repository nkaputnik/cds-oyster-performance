function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(req) {
  const rows = await SELECT.from(this.entities.LookupRows).columns('ID', 'value')
    .where`ID in ${req.data.lookupIDs}`.orderBy('ID');
  if (rows.length !== req.data.lookupIDs.length) req.reject(400, 'Lookup row missing');
  let value = cpu(req.data.seed, req.data.iterations);
  for (const row of rows) value = (value + row.value) & 2147483647;
  return value;
};
