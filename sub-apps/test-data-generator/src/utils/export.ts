/**
 * 导出功能模块
 * 支持 TXT / CSV / MD / XLSX / JSON / SQL 五种格式
 * 所有格式均包含「后N位」列（当有身份证数据时）
 */

import type { GenerateResultItem, ExportFormat } from '../types/types'

/** 是否需要显示后 N 位列 */
function hasLast6(items: GenerateResultItem[]): boolean {
  return items.some(i => i.last6 !== undefined && i.last6 !== null)
}

/** 导出为 TXT */
export function exportTxt(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  return items.map(item => {
    let line = item.value
    if (showLast6 && item.last6) line += '\t' + item.last6
    return line
  }).join('\n')
}

/** 导出为 CSV */
export function exportCsv(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  const header = showLast6 ? '序号,数据类型,内容,后N位' : '序号,数据类型,内容'
  const rows = items.map(item => {
    let row = `${item.id},"${item.type}","${item.value.replace(/"/g, '""')}"`
    if (showLast6) row += `,"${item.last6 || ''}"`
    return row
  })
  return [header, ...rows].join('\n')
}

/** 导出为 Markdown 表格 */
export function exportMd(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  const header = showLast6 ? '| 序号 | 数据类型 | 内容 | 后N位 |' : '| 序号 | 数据类型 | 内容 |'
  const separator = showLast6 ? '| --- | --- | --- | --- |' : '| --- | --- | --- |'
  const rows = items.map(item => {
    const escaped = item.value.replace(/\|/g, '\\|')
    let row = `| ${item.id} | ${item.type} | ${escaped} |`
    if (showLast6) row += ` ${item.last6 || '-'} |`
    return row
  })
  return [header, separator, ...rows].join('\n')
}

/** 导出为 JSON */
export function exportJson(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  if (showLast6) {
    return JSON.stringify(items.map(i => ({
      value: i.value,
      lastN: i.last6 || '',
    })), null, 2)
  }
  return JSON.stringify(items.map(i => i.value), null, 2)
}

/** 导出为 SQL INSERT 语句 */
export function exportSql(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  const tableName = 'test_data'
  const header = `-- 测试数据 SQL INSERT (生成于 ${new Date().toISOString().slice(0, 10)})\n`
  const cols = showLast6 ? 'id, type, value, last_x' : 'id, type, value'
  const createTable = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  id INT PRIMARY KEY,\n  type VARCHAR(50),\n  value TEXT${showLast6 ? ',\n  last_x VARCHAR(20)' : ''}\n);\n`
  const rows = items.map(item => {
    const escaped = item.value.replace(/'/g, "''")
    let sql = `INSERT INTO ${tableName} (${cols}) VALUES (${item.id}, '${item.type}', '${escaped}'`
    if (showLast6) sql += `, '${item.last6 || ''}'`
    sql += ');'
    return sql
  })
  return header + createTable + '\n' + rows.join('\n')
}

/** 导出为 XLSX（支持按类型分 Sheet） */
export async function exportXlsx(items: GenerateResultItem[]): Promise<Uint8Array> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.default.Workbook()

  // 按类型分组
  const groups = new Map<string, GenerateResultItem[]>()
  for (const item of items) {
    const list = groups.get(item.type) || []
    list.push(item)
    groups.set(item.type, list)
  }

  const showLast6 = hasLast6(items)

  function addSheet(sheetName: string, data: GenerateResultItem[]) {
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31))
    const columns: { header: string; key: string; width: number }[] = [
      { header: '序号', key: 'id', width: 8 },
      { header: '数据类型', key: 'type', width: 18 },
      { header: '内容', key: 'value', width: 60 },
    ]
    if (showLast6) columns.push({ header: '后N位', key: 'last6', width: 15 })
    sheet.columns = columns

    const headerRow = sheet.getRow(1)
    headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }

    data.forEach((item, index) => {
      const rowData: Record<string, unknown> = { id: item.id, type: item.type, value: item.value }
      if (showLast6) rowData.last6 = item.last6 || ''
      const row = sheet.addRow(rowData)
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' },
        }
      })
      if (index % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
        })
      }
    })
  }

  if (groups.size > 1) {
    addSheet('汇总', items)
    for (const [type, typeItems] of groups) {
      addSheet(type, typeItems)
    }
  } else {
    addSheet('测试数据', items)
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer
}

/** 复制为 Markdown 表格到剪贴板 */
export function copyAsMarkdownTable(items: GenerateResultItem[]): string {
  const showLast6 = hasLast6(items)
  const header = showLast6 ? '| 序号 | 数据类型 | 内容 | 后N位 |' : '| 序号 | 数据类型 | 内容 |'
  const separator = showLast6 ? '| --- | --- | --- | --- |' : '| --- | --- | --- |'
  const rows = items.map(item => {
    const escaped = item.value.replace(/\|/g, '\\|')
    let row = `| ${item.id} | ${item.type} | ${escaped} |`
    if (showLast6) row += ` ${item.last6 || '-'} |`
    return row
  })
  return [header, separator, ...rows].join('\n')
}

/** 根据格式导出数据 */
export async function exportData(
  items: GenerateResultItem[],
  format: ExportFormat
): Promise<{ content: string | Uint8Array; extension: string; mime: string }> {
  switch (format) {
    case 'txt':
      return { content: exportTxt(items), extension: 'txt', mime: 'text/plain' }
    case 'csv':
      return { content: exportCsv(items), extension: 'csv', mime: 'text/csv' }
    case 'md':
      return { content: exportMd(items), extension: 'md', mime: 'text/markdown' }
    case 'json':
      return { content: exportJson(items), extension: 'json', mime: 'application/json' }
    case 'sql':
      return { content: exportSql(items), extension: 'sql', mime: 'text/plain' }
    case 'xlsx':
      return { content: await exportXlsx(items), extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  }
}
