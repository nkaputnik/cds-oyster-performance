const cds = require('@sap/cds');

async function validateAmount(srv, req, readLimit = false) {
  let data = req.data;
  if (req.event === 'UPDATE' && (data.quantity === undefined || data.unitPrice === undefined || (readLimit && data.lookupID === undefined))) {
    const stored = await srv.run(cds.ql.SELECT.one.from(srv.entities.NoHandlerWriteRows)
      .columns('quantity', 'unitPrice', 'lookupID').where({ ID: data.ID }));
    if (!stored) return req.reject(404, 'Write row missing');
    data = { ...stored, ...data };
  }
  if (!Number.isInteger(data.quantity) || data.quantity <= 0 || !Number.isInteger(data.unitPrice) || data.unitPrice <= 0)
    return req.reject(400, 'Quantity and unit price must be positive integers');
  let limit = 1000;
  if (readLimit) {
    const row = await srv.run(cds.ql.SELECT.one.from(srv.entities.LookupRows).columns('limit').where({ ID: data.lookupID }));
    if (!row) return req.reject(400, 'Limit row missing');
    limit = row.limit;
  }
  const amount = data.quantity * data.unitPrice;
  if (amount > limit) return req.reject(400, 'Amount exceeds limit');
  return amount;
}

module.exports = { validateAmount };
