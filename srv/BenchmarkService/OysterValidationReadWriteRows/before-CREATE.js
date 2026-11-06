module.exports = async function(req) {
  let data = req.data;
  if (!Number.isInteger(data.quantity) || data.quantity <= 0 || !Number.isInteger(data.unitPrice) || data.unitPrice <= 0)
    return req.reject(400, "Quantity and unit price must be positive integers");
  const row = await SELECT.one.from(this.entities.LookupRows).columns("limit").where({ ID: data.lookupID });
  if (!row) return req.reject(400, "Limit row missing");
  const amount = data.quantity * data.unitPrice;
  if (amount > row.limit) return req.reject(400, "Amount exceeds limit");
};
