export function cpu(seed, iterations) {
  let value = seed & 2147483647;
  for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
  return value;
}

export async function executeWork(input, io = {}) {
  let value = cpu(input.seed ?? 0, input.iterations ?? 0);
  for (let i = 0; i < (input.calls ?? 0); i++) {
    if (io.kind === 'read') value = (value + await io.read(input.lookupID)) & 2147483647;
    if (io.kind === 'write') await io.write(input.effectID, value);
  }
  return value;
}
