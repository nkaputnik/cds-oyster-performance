module.exports = async function(result, req) {
  const lookup = await SELECT.one.from(this.entities.LookupRows).columns('value').orderBy('ID');
  const extra = lookup.value;
  for (const row of result) row.checksum = (row.value + extra) & 2147483647;
};
