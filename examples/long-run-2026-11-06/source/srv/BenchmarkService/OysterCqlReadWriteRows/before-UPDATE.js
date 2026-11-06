module.exports = async function(req) {
  let value = req.data.value === undefined ? 7 : req.data.value;
  const row = await SELECT.one.from(this.entities.LookupRows).columns('value').where({ ID: req.data.lookupID });
  value = (value + row.value) & 2147483647;
  req.data.value = value;
};
