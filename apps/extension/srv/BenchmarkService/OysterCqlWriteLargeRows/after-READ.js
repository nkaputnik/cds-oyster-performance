module.exports = async function(result, req) {
  const effect = await SELECT.one.from(this.entities.SideEffectRows).columns('ID').orderBy('ID');
  await UPDATE.entity(this.entities.SideEffectRows).set({ value: 0 }).where({ ID: effect.ID });
  const extra = 0;
  for (const row of result) row.checksum = (row.value + extra) & 2147483647;
};
