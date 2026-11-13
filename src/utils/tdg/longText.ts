/**
 * 超长文本生成器
 * 支持中文、English、日本語
 */

// 中文语料（现代散文/技术文档片段）
const ZH_CORPUS = [
  '随着信息技术的快速发展，软件系统的复杂度不断提高，对测试数据的质量和多样性提出了更高的要求。',
  '在软件开发过程中，测试是保证软件质量的关键环节。充分的测试数据能够帮助测试人员发现潜在的问题。',
  '系统的健壮性不仅取决于代码质量，还取决于测试覆盖的全面性。边界条件测试是其中不可或缺的一环。',
  '数据驱动测试是一种高效的测试方法，通过使用不同的输入数据来验证系统的行为是否符合预期。',
  '安全性测试是软件质量保障的重要组成部分，需要对各种可能的攻击向量进行全面验证。',
  '性能测试旨在评估系统在特定负载下的响应时间、吞吐量和资源利用率等指标。',
  '自动化测试可以显著提高回归测试的效率，降低人工测试的成本和出错率。',
  '单元测试关注最小的可测试单元，集成测试验证模块间的交互，系统测试则从用户角度出发。',
  '测试用例的设计需要考虑正常流程、异常流程和边界条件，以确保测试的全面性。',
  '持续集成和持续部署（CI/CD）实践要求测试流程能够快速反馈代码变更的影响。',
  '微服务架构下的测试挑战包括服务间依赖管理、数据隔离和端到端场景验证等。',
  'API 测试需要关注请求参数、响应格式、状态码、鉴权机制和限流策略等多个方面。',
  '数据库测试通常涉及数据完整性、事务隔离级别、索引优化和查询性能等关键维度。',
  '前端测试包括组件测试、页面交互测试、浏览器兼容性测试和视觉回归测试等类型。',
  '移动应用测试需要考虑设备碎片化、操作系统版本、网络环境和用户体验等多种因素。',
  '测试数据管理是测试流程中的重要环节，包括测试数据的生成、维护和清理等操作。',
  '混沌工程通过在生产环境中引入随机故障来验证系统的容错能力和恢复机制。',
  '安全测试中的模糊测试（Fuzzing）技术通过生成大量随机输入来发现程序中的漏洞。',
  '测试金字塔模型将测试分为单元测试、服务测试和端到端测试三个层次，底层测试应占多数。',
  '验收测试是交付前最后一道防线，确保系统满足业务需求并且用户体验良好。',
]

// 英文语料
const EN_CORPUS = [
  'The quick brown fox jumps over the lazy dog. This pangram contains every letter of the English alphabet.',
  'Software testing is an essential part of the software development lifecycle that ensures quality and reliability.',
  'Test data generation is the process of creating synthetic data sets for testing software applications.',
  'Boundary value analysis is a black-box testing technique that focuses on testing at the edges of equivalence partitions.',
  'SQL injection remains one of the most critical security vulnerabilities in web applications according to OWASP.',
  'Cross-site scripting (XSS) attacks inject malicious scripts into web pages viewed by other users.',
  'The performance of a system under load can be measured through metrics such as throughput, response time, and latency.',
  'Unit tests verify the behavior of individual components in isolation from the rest of the system.',
  'Integration tests ensure that different modules or services work together as expected.',
  'End-to-end testing validates the complete flow of an application from start to finish.',
  'Continuous integration practices require developers to integrate code changes into a shared repository frequently.',
  'A robust test suite provides fast feedback and helps prevent regressions when making changes to the codebase.',
  'Test-driven development (TDD) advocates writing tests before writing the actual implementation code.',
  'The concept of equivalence partitioning divides input data into partitions where test data behaves equivalently.',
  'Mutation testing introduces small changes to the source code to evaluate the effectiveness of existing tests.',
]

// 日语语料
const JA_CORPUS = [
  'ソフトウェアテストは、品質保証の重要なプロセスであり、システムの信頼性を確保します。',
  'テストデータ生成は、アプリケーションテストのための合成データを作成するプロセスです。',
  '境界値分析は、等価パーティションのエッジに焦点を当てたブラックボックステスト技法です。',
  'SQLインジェクションは、最も深刻なセキュリティ脆弱性の一つとして広く認識されています。',
  'クロスサイトスクリプティング（XSS）は、悪意のあるスクリプトをWebページに挿入する攻撃です。',
  '単体テストは、システムの個々のコンポーネントの動作を検証します。',
  '結合テストは、異なるモジュールが期待通りに連携することを確認します。',
  'パフォーマンステストは、特定の負荷下でのシステムの応答時間とスループットを評価します。',
  '自動化テストは、回帰テストの効率を大幅に向上させ、人的コストを削減します。',
  'テスト駆動開発（TDD）は、実際の実装コードを書く前にテストを書くことを提唱しています。',
  '継続的インテグレーション（CI）は、開発者が頻繁にコード変更を共有リポジトリに統合する手法です。',
  'マイクロサービスアーキテクチャでは、サービス間の依存関係管理がテストの課題となります。',
  'APIテストでは、リクエストパラメータ、レスポンス形式、ステータスコードを検証します。',
  'セキュリティテストは、システムの脆弱性を特定し、潜在的な攻撃から保護するために重要です。',
  'ファジング（Fuzzing）は、大量のランダム入力を生成してプログラムのバグを発見する手法です。',
]

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]
}

/** 生成中文文本 */
function generateZhText(minLen: number, maxLen: number): string {
  let text = ''
  while (text.length < maxLen) {
    text += pick(ZH_CORPUS)
    if (text.length < maxLen) text += '，'
    if (Math.random() < 0.2) text += '。'
    if (text.length >= minLen && text.length * 1.2 >= minLen) break
  }
  // 截断到目标长度
  if (text.length > maxLen) text = text.slice(0, maxLen)
  if (text.length < minLen) text += pick(ZH_CORPUS).slice(0, minLen - text.length)
  return text
}

/** 生成英文文本 */
function generateEnText(minLen: number, maxLen: number): string {
  let text = ''
  while (text.length < maxLen) {
    text += pick(EN_CORPUS)
    if (text.length < maxLen) text += ' '
    if (text.length >= minLen && text.length * 1.2 >= minLen) break
  }
  if (text.length > maxLen) text = text.slice(0, maxLen)
  if (text.length < minLen) text += pick(EN_CORPUS).slice(0, minLen - text.length)
  return text
}

/** 生成日语文本 */
function generateJaText(minLen: number, maxLen: number): string {
  let text = ''
  while (text.length < maxLen) {
    text += pick(JA_CORPUS)
    if (text.length < maxLen) text += '。'
    if (Math.random() < 0.3) text += ' '
    if (text.length >= minLen && text.length * 1.2 >= minLen) break
  }
  if (text.length > maxLen) text = text.slice(0, maxLen)
  if (text.length < minLen) text += pick(JA_CORPUS).slice(0, minLen - text.length)
  return text
}

// 中英文混合用到的特殊字符集
const SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`\'"'
const MIX_EN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const MIX_NUM = '0123456789'
const MIX_ZH_RANGE = 0x9fa5 - 0x4e00 // 常用中文字符范围

function randZhChar(): string {
  return String.fromCharCode(0x4e00 + Math.floor(Math.random() * MIX_ZH_RANGE))
}

/** 生成中英文特殊字符混合文本 */
function generateMixedText(minLen: number, maxLen: number): string {
  const pools = [ZH_CORPUS, EN_CORPUS, null]  // null = random chars
  let text = ''
  while (text.length < maxLen) {
    const pool = pick(pools)
    if (pool) {
      text += pick(pool)
    } else {
      // 随机生成一段混合字符
      const segLen = Math.floor(Math.random() * 30) + 5
      for (let i = 0; i < segLen && text.length < maxLen; i++) {
        const choice = Math.random()
        if (choice < 0.4) {
          text += randZhChar()                          // 中文
        } else if (choice < 0.65) {
          text += MIX_EN[Math.floor(Math.random() * MIX_EN.length)]  // 英文
        } else if (choice < 0.8) {
          text += MIX_NUM[Math.floor(Math.random() * MIX_NUM.length)] // 数字
        } else {
          text += SPECIAL_CHARS[Math.floor(Math.random() * SPECIAL_CHARS.length)] // 特殊字符
        }
      }
    }
    if (text.length >= minLen && text.length * 1.2 >= minLen) break
  }
  if (text.length > maxLen) text = text.slice(0, maxLen)
  if (text.length < minLen) {
    // 补齐
    while (text.length < minLen) {
      text += randZhChar()
    }
  }
  return text
}

/** 生成超长文本 */
export function generateLongText(language: 'zh' | 'en' | 'ja' | 'mix', minLength: number, maxLength: number): string {
  switch (language) {
    case 'zh': return generateZhText(minLength, maxLength)
    case 'en': return generateEnText(minLength, maxLength)
    case 'ja': return generateJaText(minLength, maxLength)
    case 'mix': return generateMixedText(minLength, maxLength)
  }
}

/** 批量生成超长文本 */
export function generateLongTexts(
  count: number,
  language: 'zh' | 'en' | 'ja' | 'mix',
  minLength: number,
  maxLength: number
): string[] {
  const result: string[] = []
  for (let i = 0; i < count; i++) {
    result.push(generateLongText(language, minLength, maxLength))
  }
  return result
}
