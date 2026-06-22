/**
 * 导出功能模块
 * 支持 TXT / CSV / MD / XLSX / JSON 五种格式
 */

import type { GenerateResultItem, ExportFormat } from '../types/types'

/** 导出为 TXT */
export function exportTxt(items: GenerateResultItem[]): string {
  return items.map(item => item.value).join('\n')
}

/** 导出为 CSV */
export function exportCsv(items: GenerateResultItem[]): string {
  const header = '序号,数据类型,内容'
  const rows = items.map(item =>
    `${item.id},"${item.type}","${item.value.replace(/"/g, '""')}"`
  )
  return [header, ...rows].join('\n')
}

/** 导出为 Markdown 表格 */
export function exportMd(items: GenerateResultItem[]): string {
  const header = '| 序号 | 数据类型 | 内容 |'
  const separator = '| --- | --- | --- |'
  const rows = items.map(item => {
    const escaped = item.value.replace(/\|/g, '\\|')
    return `| ${item.id} | ${item.type} | ${escaped} |`
  })
  return [header, separator, ...rows].join('\n')
}

/** 导出为 JSON */
export function exportJson(items: GenerateResultItem[]): string {
  // 纯数据模式：只输出值数组
  return JSON.stringify(items.map(i => i.value), null, 2)
}

/** 导出为 SQL INSERT 语句 */
export function exportSql(items: GenerateResultItem[]): string {
  const tableName = 'test_data'
  const header = `-- 测试数据 SQL INSERT (生成于 ${new Date().toISOString().slice(0, 10)})\n`
  const createTable = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  id INT PRIMARY KEY,\n  type VARCHAR(50),\n  value TEXT\n);\n`
  const rows = items.map(item => {
    const escaped = item.value.replace(/'/g, "''")
    return `INSERT INTO ${tableName} (id, type, value) VALUES (${item.id}, '${item.type}', '${escaped}');`
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

  function addSheet(sheetName: string, data: GenerateResultItem[]) {
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31)) // Excel sheet name limit
    sheet.columns = [
      { header: '序号', key: 'id', width: 8 },
      { header: '数据类型', key: 'type', width: 18 },
      { header: '内容', key: 'value', width: 60 },
    ]
    const headerRow = sheet.getRow(1)
    headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }

    data.forEach((item, index) => {
      const row = sheet.addRow({ id: item.id, type: item.type, value: item.value })
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
    // 多类型：每种类型一个 Sheet + 汇总
    addSheet('汇总', items)
    for (const [type, typeItems] of groups) {
      addSheet(type, typeItems)
    }
  } else {
    // 单类型：直接一个 Sheet
    addSheet('测试数据', items)
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer
}

/** 复制为 Markdown 表格到剪贴板 */
export function copyAsMarkdownTable(items: GenerateResultItem[]): string {
  const header = '| 序号 | 数据类型 | 内容 |'
  const separator = '| --- | --- | --- |'
  const rows = items.map(item => {
    const escaped = item.value.replace(/\|/g, '\\|')
    return `| ${item.id} | ${item.type} | ${escaped} |`
  })
  return [header, separator, ...rows].join('\n')
}

/** 根据格式导出数据（返回文件内容字符串或二进制 Uint8Array） */
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
