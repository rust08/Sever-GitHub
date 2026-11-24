const requiredFields = ['edgeId', 'customer', 'executor', 'officer', 'contractId', 'source', 'clause', 'reviewer'];

function validAnnexDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function readContractAnnex(file, networkVersion, edges, workTypes) {
  if (file?.mode !== 'simulation' || file.networkVersion !== networkVersion ||
      !Array.isArray(file.rows) || !file.rows.length || file.rows.length > 100) {
    throw Error('Нужен учебный файл для текущей версии сети, от 1 до 100 строк');
  }
  const mapped = new Map(), unmapped = [];
  for (const [index, row] of file.rows.entries()) {
    const line = index + 1;
    if (!row || requiredFields.some(key => typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 240) ||
        !Object.hasOwn(workTypes, row.operation) || !validAnnexDate(row.from) || !validAnnexDate(row.until) || row.from >= row.until) {
      throw Error('Проверьте поля, операцию и период строки ' + line);
    }
    if (!edges.has(row.edgeId)) {
      const {edgeId, contractId, source, clause, operation, from, until} = row;
      unmapped.push({line, edgeId, contractId, source, clause, operation, from, until});
      continue;
    }
    if (!mapped.has(row.edgeId)) mapped.set(row.edgeId, []);
    mapped.get(row.edgeId).push(row);
  }
  return {mapped, unmapped};
}
