function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(result, req) {
  const effect = await SELECT.one.from(this.entities.SideEffectRows).columns('ID').orderBy('ID');
  await UPDATE.entity(this.entities.SideEffectRows).set({ value: 0 }).where({ ID: effect.ID });
  const extra = 0;
  for (const row of result) row.checksum = (cpu(row.value, 100) + extra) & 2147483647;
};
