function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(result, req) {
  const lookup = await SELECT.one.from(this.entities.LookupRows).columns('value').orderBy('ID');
  const extra = lookup.value;
  for (const row of result) row.checksum = (cpu(row.value, 100) + extra) & 2147483647;
};
