import type { ArchetypeId } from '@riosoma/ingest';

const helpers = `
const { tableByName, findHeaderRow, cellText, isTotalRow, findLabelValueBlocks,
  normalizeMarker, unpivot, pivot, fillDown, pageLines, lineTable, between, splitText } = ingest
const T = value => ingest.text(value).value
const I = value => ingest.identifier(value).value
const N = value => ingest.number(value, { decimalMark: '.' }).value
const D = value => ingest.date(value).value
const row = (values, at) => ({ values, at, raw: {} })
const grid = async name => {
  const sheet = (await source.sheets()).find(sheet => sheet.name === name)
  const rows = []
  for (let start = 0; start < sheet.rowCount; start += 1000)
    rows.push(...await source.rows(name, start, 1000))
  return rows
}
const named = async (name, markers) => {
  const rows = await grid(name)
  return tableByName(rows, findHeaderRow(rows, markers))
}
const clean = (cells, at, columns, constants = {}) => {
  const values = { ...constants }, raw = {}
  for (const [field, index, cleaner] of columns) {
    const cell = cells[index]
    values[field] = cleaner(cell)
    if (values[field] !== (cell?.v ?? null)) raw[field] = cellText(cell)
  }
  return { values, at, raw }
}
`;

/** Reference scripts compose the public bridge and toolkit, with no host-side reading. */
const readings: Record<ArchetypeId, string> = {
  1: `
const data = await named('Orders', ['ID', 'Amount'])
const product = data.indices('Product').length ? 'Product' : 'Item'
await emit(data.rows.filter(cells => I(data.get(cells, 'ID')) !== null).map((cells, index) =>
  clean(cells, { sheet: 'Orders', row: data.headerIndex + index + 2 }, [
    ['id', data.indices('ID')[0], I], ['product', data.indices(product)[0], T],
    ['amount', data.indices('Amount')[0], N],
    ['date', data.indices('Date')[0], value => ingest.date(value, { formats: ['MM/DD/YYYY'] }).value],
  ])))`,
  2: `
const data = await named('Departments', ['Department', 'Product', 'Amount'])
let department = null, sum = '0'
const output = []
for (let index = 0; index < data.rows.length; index++) {
  const cells = data.rows[index]
  if (isTotalRow(cells)) {
    if (cellText(cells[0]) === 'Grand total') await check('amount', N(cells[1]), sum)
    continue
  }
  department = T(cells[0]) ?? department
  const item = clean(cells, { sheet: 'Departments', row: data.headerIndex + index + 2 }, [
    ['department', 0, () => department], ['product', 1, T], ['amount', 2, N],
  ])
  sum = ingest.addDecimals(sum, item.values.amount)
  output.push(item)
}
await emit(output)`,
  3: `
for (const sheet of await source.sheets()) {
  const data = await named(sheet.name, ['ID', 'Period', 'Amount'])
  const output = []
  let sum = '0'
  for (let index = 0; index < data.rows.length; index++) {
    const cells = data.rows[index]
    if (['Period total', 'Order count', ''].includes(cellText(cells[0]))) {
      if (cellText(cells[0]) === 'Period total') await check(sheet.name, N(cells[1]), sum)
      continue
    }
    const item = clean(cells, { sheet: sheet.name, row: data.headerIndex + index + 2 }, [
      ['id', 0, I], ['product', 1, T], ['period', 2, D], ['amount', 3, N],
    ])
    sum = ingest.addDecimals(sum, item.values.amount)
    output.push(item)
  }
  await emit(output)
}`,
  4: `
const data = await named('Dispatch', ['ID', 'Amount'])
const output = []
for (let index = 0; index < data.rows.length; index++) {
  const cells = data.rows[index]
  const sender = (await lookup('sender', cellText(cells[3]))).value
  output.push(clean(cells, { sheet: 'Dispatch', row: data.headerIndex + index + 2 }, [
    ['id', 0, I], ['product', 1, T], ['amount', 2, N], ['sender', 3, () => sender],
  ], { currency: 'USD' }))
}
await emit(output)`,
  5: `
const directory = await named('Directory', ['Data tab', 'Region'])
const labels = Object.fromEntries(findLabelValueBlocks(await grid('Directory'),
  ['Footnote currency', 'Footnote period']).map(block => [normalizeMarker(block.label), block.value]))
const sheets = await source.sheets()
for (const cells of directory.rows) {
  const name = cellText(directory.get(cells, 'Data tab'))
  if (!sheets.some(sheet => sheet.name === name)) continue
  const data = await named(name, ['ID', 'Product', 'Amount'])
  await emit(data.rows.map((record, index) => row({
    id: I(data.get(record, 'ID')), product: T(data.get(record, 'Product')), amount: N(data.get(record, 'Amount')),
    region: T(directory.get(cells, 'Region')), currency: T(labels['footnote currency']), period: D(labels['footnote period']),
  }, { sheet: name, row: data.headerIndex + index + 2 })))
}`,
  6: `
const terms = await named('Terms', ['Tier', 'Rate'])
const rates = new Map(terms.rows.map(cells => [T(terms.get(cells, 'Tier')), N(terms.get(cells, 'Rate'))]))
const data = await named('Orders', ['ID', 'Tier', 'Units'])
await emit(data.rows.map((cells, index) => {
  const tier = T(data.get(cells, 'Tier')), units = N(data.get(cells, 'Units'))
  return row({ id: I(data.get(cells, 'ID')), tier, units, amount: ingest.multiplyDecimals(units, rates.get(tier)) },
    { sheet: 'Orders', row: data.headerIndex + index + 2 })
}))`,
  7: `
const data = await named('Periods', ['Product'])
const columns = data.headers.slice(1).map(key => ({ key, period: D(key) }))
await emit(data.rows.flatMap((cells, index) => {
  const values = Object.fromEntries(data.headers.map(key => [key, key === 'Product' ? T(data.get(cells, key)) : N(data.get(cells, key))]))
  return unpivot([values], { keys: ['Product'], columns, periodField: 'period', valueField: 'amount' })
    .map(value => row({ product: value.Product, period: value.period, amount: value.amount },
      { sheet: 'Periods', row: data.headerIndex + index + 2 }))
}))`,
  8: `
const data = await named('Pairs', ['Product'])
const entities = [...new Set(data.headers.slice(1))]
await emit(data.rows.slice(1).flatMap((cells, index) => entities.map(entity => {
  const measures = data.all(cells, entity)
  return row({ product: T(data.get(cells, 'Product')), entity, quantity: N(measures[0]), amount: N(measures[1]) },
    { sheet: 'Pairs', row: data.headerIndex + index + 3 })
})))`,
  9: `
const data = await named('Measures', ['ID', 'Product', 'Measure', 'Value'])
const records = fillDown(data.rows.map(cells => ({ id: I(data.get(cells, 'ID')), product: T(data.get(cells, 'Product')),
  measure: T(data.get(cells, 'Measure')), value: N(data.get(cells, 'Value')) })), ['id', 'product'])
const result = pivot(records, { keys: ['id', 'product'], measureField: 'measure', valueField: 'value' })
const positions = new Map()
records.forEach((record, index) => { if (!positions.has(record.id)) positions.set(record.id, data.headerIndex + index + 2) })
await emit(result.rows.map(values => row(values, { sheet: 'Measures', row: positions.get(values.id) })))`,
  10: `
const blocks = findLabelValueBlocks(await grid('Blocks'), ['ID', 'Product', 'Amount'])
const groups = new Map()
for (const block of blocks) {
  const values = groups.get(block.row) ?? {}
  values[normalizeMarker(block.label)] = block.value
  groups.set(block.row, values)
}
await emit([...groups].map(([index, values]) => row({ id: I(values.id), product: T(values.product), amount: N(values.amount) },
  { sheet: 'Blocks', row: index + 1 })))`,
  11: `
const lines = lineTable(pageLines({ pages: await source.pages() }), ['ID', 'Product', 'Amount'])
const data = tableByName(lines.rows, lines.headerIndex)
await emit(data.rows.flatMap((cells, index) => cells.length !== 3 || isTotalRow(cells) ? [] :
  [row({ id: I(data.get(cells, 'ID')), product: T(data.get(cells, 'Product')), amount: N(data.get(cells, 'Amount')) },
    lines.locations[data.headerIndex + index + 1])]))`,
  12: `
const data = await named('Instructions', ['ID', 'Instruction'])
await emit(data.rows.map((cells, index) => {
  const instruction = cellText(data.get(cells, 'Instruction'))
  const tail = splitText(instruction, ' - ')[1]
  return row({ id: I(data.get(cells, 'ID')), hold: N(between(instruction, 'Hold ', ' - ')),
    stage: T(splitText(tail, '[')[0]), code: T(between(tail, '[', ']')) },
    { sheet: 'Instructions', row: data.headerIndex + index + 2 })
}))`,
  13: `
const email = await source.email()
if (email.tables.length) {
  for (let table = 0; table < email.tables.length; table++) {
    const rows = email.tables[table].map(cells => cells.map(ingest.cell))
    const data = tableByName(rows, findHeaderRow(rows, ['ID', 'Product', 'Amount']))
    await emit(data.rows.map((cells, index) => row({ id: I(data.get(cells, 'ID')), product: T(data.get(cells, 'Product')),
      amount: N(data.get(cells, 'Amount')) }, { table: table + 1, row: data.headerIndex + index + 2 })))
  }
} else {
  await emit(splitText(email.bodyText, '\\n').flatMap((line, index) => line.startsWith('Order ') ?
    [row({ id: I(between(line, 'Order ', ' contains ')), product: T(between(line, ' contains ', ' at USD ')),
      amount: N(splitText(line, ' at USD ')[1].slice(0, -1)) }, { line: index + 1 })] : []))
}`,
  14: `
for (const page of await source.pages()) {
  const transcription = await fact('page:' + page.number)
  if (!transcription) throw new Error('ingest.cleaner.missingInput')
  await emit([row({ id: I(transcription.id), product: T(transcription.product), amount: N(transcription.amount) },
    { page: page.number })])
}`,
  15: `
for (const page of await source.pages()) {
  const lines = ingest.splitLines(page.text)
  const document = lines.at(-2), text = lines.at(-1)
  let values
  if (document === 'order') {
    const [id, product, amount] = splitText(text.slice('Order '.length), ', ')
    values = { document, id: I(id), product: T(product), amount: N(amount.slice('USD '.length)) }
  } else if (document === 'expense') {
    const [person, , amount] = splitText(text, ', ')
    values = { document, person: T(person), amount: N(amount.slice('USD '.length)) }
  } else {
    const [product, hours, complete] = splitText(text, ', ')
    values = { document, product: T(product.slice(0, -' inspection'.length)), hours: N(hours.slice(0, -' hours'.length)),
      complete: complete === 'complete' }
  }
  await emit([row(values, { page: page.number })])
}`,
};

export const REFERENCE_READERS = Object.fromEntries(
  Object.entries(readings).map(([id, code]) => [id, helpers + code]),
) as Record<ArchetypeId, string>;
