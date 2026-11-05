function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(req) {
  let value = cpu(req.data.value === undefined ? 7 : req.data.value, 100);
  const row = await SELECT.one.from(this.entities.LookupRows).columns('value').where({ ID: req.data.lookupID });
  value = (value + row.value) & 2147483647;
  req.data.value = value;
};
