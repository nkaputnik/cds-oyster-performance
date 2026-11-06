function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(req) {
  let value = cpu(req.data.seed, req.data.iterations);
  for (const ID of req.data.lookupIDs) {
    const row = await SELECT.one.from(this.entities.LookupRows).columns('ID', 'value').where({ ID });
    if (!row) req.reject(400, 'Lookup row missing');
    value = (value + row.value) & 2147483647;
  }
  return value;
};
