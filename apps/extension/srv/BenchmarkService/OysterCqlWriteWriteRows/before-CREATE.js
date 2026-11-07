module.exports = async function(req) {
  let value = req.data.value === undefined ? 7 : req.data.value;
  await UPDATE.entity(this.entities.SideEffectRows).set({ value }).where({ ID: req.data.effectID });
  req.data.value = value;
};
