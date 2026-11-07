function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}
module.exports = async function(req) {
  let value = cpu(req.data.seed, req.data.iterations);
  for (let i = 0; i < req.data.calls; i++) {
    await UPDATE.entity(this.entities.SideEffectRows).set({ value }).where({ ID: req.data.effectID });
  }
  return value;
};
