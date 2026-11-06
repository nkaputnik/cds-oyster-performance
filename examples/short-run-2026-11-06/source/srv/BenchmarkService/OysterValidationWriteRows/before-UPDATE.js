module.exports = async function(req) {
  let data = req.data;
  if (data.quantity === undefined || data.unitPrice === undefined) {
    const stored = await SELECT.one.from(this.entities.NoHandlerWriteRows).columns("quantity", "unitPrice", "lookupID").where({ ID: data.ID });
    if (!stored) return req.reject(404, "Write row missing");
    data = { ...stored, ...data };
  }
  if (!Number.isInteger(data.quantity) || data.quantity <= 0 || !Number.isInteger(data.unitPrice) || data.unitPrice <= 0)
    return req.reject(400, "Quantity and unit price must be positive integers");
  const amount = data.quantity * data.unitPrice;
  if (amount > 1000) return req.reject(400, "Amount exceeds limit");
};
