<template>
  <div class="app-container" :class="{ dark: isDark }">
    <!-- 顶部工具栏 -->
    <header class="app-header">
      <div class="header-left">
        <h1 class="app-title">
          <el-icon :size="24"><Coin /></el-icon>
          生成测试数据
        </h1>
      </div>
      <div class="header-right">
        <el-switch
          v-model="isDark"
          active-icon="Moon"
          inactive-icon="Sunny"
          inline-prompt
          style="--el-switch-on-color: #2c3e50; --el-switch-off-color: #f0f0f0"
        />
      </div>
    </header>

    <div class="app-body">
      <!-- 左侧面板：类别选择 + 参数配置 -->
      <aside class="left-panel" :class="{ collapsed: sidebarCollapsed }">
        <div class="sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed" :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'">
          <el-icon :size="18">
            <Fold v-if="!sidebarCollapsed" />
            <Expand v-else />
          </el-icon>
          <span v-show="!sidebarCollapsed" class="toggle-label">折叠</span>
        </div>
        <el-scrollbar>
          <h3 class="panel-title" v-show="!sidebarCollapsed">数据类型</h3>
          <div class="category-groups">
            <template v-for="group in sortedGroups" :key="group.title">
              <h4 v-show="!sidebarCollapsed" class="group-title">{{ group.title }}</h4>
              <div class="category-grid" :class="{ collapsed: sidebarCollapsed }">
                <div
                  v-for="gen in group.items"
                  :key="gen.id"
                  class="category-card"
                  :class="{ active: selectedTypes.has(gen.id), pinned: pinnedTypes.has(gen.id) }"
                  @click="toggleCategory(gen.id)"
                  :title="gen.description"
                >
                  <el-icon :size="18"><component :is="gen.icon as any" /></el-icon>
                  <span class="cat-label" v-show="!sidebarCollapsed">{{ gen.label }}</span>
                  <el-icon
                    v-show="!sidebarCollapsed"
                    :size="12"
                    class="pin-icon"
                    :class="{ pinned: pinnedTypes.has(gen.id) }"
                    @click="togglePin(gen.id, $event)"
                    title="置顶/取消置顶"
                  ><StarFilled /></el-icon>
                </div>
              </div>
            </template>
          </div>

          <!-- 参数配置区（折叠时隐藏） -->
          <div v-if="activeCategoryParams && !sidebarCollapsed" class="params-section">
            <h3 class="panel-title">参数配置</h3>
            <el-form size="small" label-position="top">


              <!-- 身份证参数 -->
              <template v-if="activeCategory === 'idCard'">
                <el-form-item label="身份证类型">
                  <el-radio-group v-model="idCardParams.idType">
                    <el-radio value="mainland">大陆</el-radio>
                    <el-radio value="hk">香港</el-radio>
                    <el-radio value="macau">澳门</el-radio>
                    <el-radio value="mixed">混合</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="性别">
                  <el-radio-group v-model="idCardParams.gender">
                    <el-radio value="random">随机</el-radio>
                    <el-radio value="male">男</el-radio>
                    <el-radio value="female">女</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="出生年份范围">
                  <div class="range-input-group">
                    <el-input-number v-model="birthYearRange[0]" :min="1940" :max="birthYearRange[1] - 1" :step="1" size="small" style="width: 120px" />
                    <span class="range-sep">~</span>
                    <el-input-number v-model="birthYearRange[1]" :min="birthYearRange[0] + 1" :max="2010" :step="1" size="small" style="width: 120px" />
                  </div>
                </el-form-item>
                <el-form-item label="表格显示后几位">
                  <el-input-number v-model="idCardParams.lastDigits" :min="2" :max="8" :step="1" size="small" style="width: 100px" />
                </el-form-item>
              </template>

              <!-- 姓名参数 -->
              <template v-if="activeCategory === 'name'">
                <el-form-item label="民族">
                  <el-radio-group v-model="nameEthnicity">
                    <el-radio value="random">随机</el-radio>
                    <el-radio value="han">汉族</el-radio>
                    <el-radio value="xinjiang">维吾尔族</el-radio>
                    <el-radio value="tibetan">藏族</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="关联拼音">
                  <el-switch v-model="nameWithPinyin" active-text="附带拼音" inactive-text="仅中文" />
                </el-form-item>
              </template>

              <!-- 超长文本参数 -->
              <template v-if="activeCategory === 'longText'">
                <el-form-item label="语言">
                  <el-select v-model="longTextParams.language" style="width: 100%">
                    <el-option label="中文" value="zh" />
                    <el-option label="English" value="en" />
                    <el-option label="日本語" value="ja" />
                    <el-option label="中英混合" value="mix" />
                  </el-select>
                </el-form-item>
                <el-form-item label="文本长度范围">
                  <div class="range-input-group">
                    <el-input-number v-model="longTextLengthRange[0]" :min="10" :max="longTextLengthRange[1] - 1" :step="10" size="small" style="width: 130px" />
                    <span class="range-sep">~</span>
                    <el-input-number v-model="longTextLengthRange[1]" :min="longTextLengthRange[0] + 1" :max="100000" :step="10" size="small" style="width: 130px" />
                  </div>
                  <div class="range-labels">{{ longTextLengthRange[0] }} ~ {{ longTextLengthRange[1] }} 字符</div>
                </el-form-item>
              </template>

              <!-- 邮箱参数 -->
              <template v-if="activeCategory === 'email'">
                <el-form-item label="域名后缀">
                  <el-select v-model="emailParams.domains" multiple collapse-tags style="width: 100%">
                    <el-option v-for="d in commonDomains" :key="d" :label="d" :value="d" />
                  </el-select>
                </el-form-item>
                <el-form-item label="特殊字符">
                  <el-switch v-model="emailParams.allowSpecialChars" active-text="允许" inactive-text="不允许" />
                </el-form-item>
              </template>

              <!-- 手机号参数 -->
              <template v-if="activeCategory === 'phone'">
                <el-form-item label="号段前缀（多选）">
                  <el-select v-model="phoneParams.prefixes" multiple collapse-tags style="width: 100%">
                    <el-option v-for="p in commonPrefixes" :key="p" :label="p" :value="p" />
                  </el-select>
                </el-form-item>
              </template>

              <!-- IP 参数 -->
              <template v-if="activeCategory === 'ip'">
                <el-form-item label="IP 版本">
                  <el-radio-group v-model="ipParams.version">
                    <el-radio :value="4">IPv4</el-radio>
                    <el-radio :value="6">IPv6</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="地址类别" v-if="ipParams.version === 4">
                  <el-checkbox-group v-model="ipParams.categories">
                    <el-checkbox value="A">A 类</el-checkbox>
                    <el-checkbox value="B">B 类</el-checkbox>
                    <el-checkbox value="C">C 类</el-checkbox>
                    <el-checkbox value="private">私有</el-checkbox>
                    <el-checkbox value="loopback">回环</el-checkbox>
                  </el-checkbox-group>
                </el-form-item>
              </template>

              <!-- 日期参数 -->
              <template v-if="activeCategory === 'date'">
                <el-form-item label="年份范围">
                  <div class="range-input-group">
                    <el-input-number v-model="dateYearRange[0]" :min="1970" :max="dateYearRange[1] - 1" :step="1" size="small" style="width: 120px" />
                    <span class="range-sep">~</span>
                    <el-input-number v-model="dateYearRange[1]" :min="dateYearRange[0] + 1" :max="2099" :step="1" size="small" style="width: 120px" />
                  </div>
                </el-form-item>
                <el-form-item label="格式">
                  <el-select v-model="dateParams.format" style="width: 100%">
                    <el-option label="yyyy-MM-dd" value="date" />
                    <el-option label="yyyy-MM-dd HH:mm:ss" value="datetime" />
                    <el-option label="yyyyMMddHHmmss (时间戳)" value="timestamp" />
                  </el-select>
                </el-form-item>
              </template>

              <!-- 边界值参数 -->
              <template v-if="activeCategory === 'boundary'">
                <el-form-item label="边界类型">
                  <el-checkbox-group v-model="boundaryParams.types">
                    <el-checkbox value="empty">空字符串</el-checkbox>
                    <el-checkbox value="oversize">超长</el-checkbox>
                    <el-checkbox value="unicode">Unicode 边界</el-checkbox>
                    <el-checkbox value="emoji">Emoji</el-checkbox>
                    <el-checkbox value="rtl">RTL 双向文本</el-checkbox>
                    <el-checkbox value="zerowidth">零宽字符</el-checkbox>
                    <el-checkbox value="newline">换行符混合</el-checkbox>
                  </el-checkbox-group>
                </el-form-item>
                <el-form-item label="超长字符数" v-if="boundaryParams.types.includes('oversize')">
                  <el-input-number v-model="boundaryParams.extraLength" :min="1" :max="100000" :step="100" style="width: 100%" />
                </el-form-item>
              </template>

              <!-- 银行卡号参数 -->
              <template v-if="activeCategory === 'bankCard'">
                <el-form-item label="卡品牌">
                  <el-radio-group v-model="bankCardParams.brand">
                    <el-radio value="random">随机</el-radio>
                    <el-radio value="visa">Visa</el-radio>
                    <el-radio value="mastercard">MasterCard</el-radio>
                    <el-radio value="unionpay">银联</el-radio>
                  </el-radio-group>
                </el-form-item>
              </template>

              <!-- 车牌号参数 -->
              <template v-if="activeCategory === 'licensePlate'">
                <el-form-item label="车牌类型">
                  <el-radio-group v-model="licensePlateParams.type">
                    <el-radio value="random">随机</el-radio>
                    <el-radio value="blue">蓝牌（普通）</el-radio>
                    <el-radio value="green">绿牌（新能源）</el-radio>
                    <el-radio value="embassy">使馆牌</el-radio>
                    <el-radio value="police">警用牌</el-radio>
                  </el-radio-group>
                </el-form-item>
              </template>

              <!-- MAC 地址参数 -->
              <template v-if="activeCategory === 'macAddress'">
                <el-form-item label="分隔符">
                  <el-radio-group v-model="macAddressParams.separator">
                    <el-radio value=":">冒号 (AA:BB:CC)</el-radio>
                    <el-radio value="-">连字符 (AA-BB-CC)</el-radio>
                    <el-radio value="none">无 (AABBCC)</el-radio>
                  </el-radio-group>
                </el-form-item>
              </template>

              <!-- 占位图参数 -->
              <template v-if="activeCategory === 'imagePlaceholder'">
                <el-form-item label="尺寸">
                  <div class="range-input-group">
                    <el-input-number v-model="imagePlaceholderParams.width" :min="100" :max="1920" :step="100" size="small" style="width: 100px" />
                    <span class="range-sep">×</span>
                    <el-input-number v-model="imagePlaceholderParams.height" :min="100" :max="1080" :step="100" size="small" style="width: 100px" />
                  </div>
                </el-form-item>
                <el-form-item label="服务商">
                  <el-radio-group v-model="imagePlaceholderParams.service">
                    <el-radio value="picsum">picsum.photos</el-radio>
                    <el-radio value="placeholder">via.placeholder.com</el-radio>
                  </el-radio-group>
                </el-form-item>
              </template>

              <!-- 段落文本参数 -->
              <template v-if="activeCategory === 'loremIpsum'">
                <el-form-item label="语言">
                  <el-radio-group v-model="loremIpsumParams.language">
                    <el-radio value="zh">中文</el-radio>
                    <el-radio value="en">English</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="段落数">
                  <el-input-number v-model="loremIpsumParams.paragraphs" :min="1" :max="20" size="small" style="width: 100%" />
                </el-form-item>
                <el-form-item label="每段句子数">
                  <el-input-number v-model="loremIpsumParams.sentencesPerParagraph" :min="1" :max="30" size="small" style="width: 100%" />
                </el-form-item>
              </template>

              <!-- 正则生成参数 -->
              <template v-if="activeCategory === 'regex'">
                <el-form-item label="正则表达式">
                  <el-input v-model="regexPattern" placeholder="输入正则表达式，如 [a-zA-Z0-9]{8}" size="small" />
                </el-form-item>
                <el-form-item label="修饰符">
                  <el-input v-model="regexFlags" placeholder="如 gi" size="small" style="width: 100px" />
                </el-form-item>
                <el-form-item label="常用预设">
                  <div class="preset-grid">
                    <el-tag
                      v-for="preset in regexPresets"
                      :key="preset.pattern"
                      size="small"
                      class="preset-tag"
                      @click="regexPattern = preset.pattern"
                    >
                      {{ preset.label }}
                    </el-tag>
                  </div>
                </el-form-item>
              </template>

              <!-- 配置模板 -->
              <div class="template-section">
                <el-divider />
                <div class="template-header">
                  <span class="template-title">配置模板</span>
                  <el-button size="small" text type="primary" @click="showTemplateDialog = true">
                    <el-icon><Plus /></el-icon> 保存当前
                  </el-button>
                </div>
                <div v-if="configTemplates.length === 0" class="template-empty">暂无保存的模板</div>
                <div v-for="(tpl, idx) in configTemplates" :key="tpl.name" class="template-item">
                  <span class="template-name" @click="loadTemplate(tpl)" :title="`加载「${tpl.name}」`">{{ tpl.name }}</span>
                  <el-button size="small" text type="danger" @click="deleteTemplate(idx)" title="删除">
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </div>
              </div>

              <!-- 排除项（通用） -->
              <div class="exclude-section">
                <el-divider />
                <el-form-item label="排除项（每行一个）">
                  <el-input
                    v-model="excludeText"
                    type="textarea"
                    :rows="2"
                    placeholder="输入要排除的值，每行一个&#10;如：130（排除130开头的手机号）"
                    size="small"
                  />
                </el-form-item>
              </div>

            </el-form>

            <!-- 保存模板对话框 -->
            <el-dialog v-model="showTemplateDialog" title="保存配置模板" width="320px" append-to-body>
              <el-input v-model="templateNameInput" placeholder="输入模板名称" size="small" @keyup.enter="saveCurrentTemplate" />
              <template #footer>
                <el-button size="small" @click="showTemplateDialog = false">取消</el-button>
                <el-button size="small" type="primary" @click="saveCurrentTemplate">保存</el-button>
              </template>
            </el-dialog>
          </div>
        </el-scrollbar>
      </aside>

      <!-- 右侧主区域 -->
      <main class="main-panel">
        <!-- 生成控制栏 -->
        <div class="control-bar">
          <div class="control-left">
            <span class="control-label">生成数量：</span>
            <el-input-number
              v-model="generateCount"
              :min="1"
              :max="10000"
              :step="10"
              size="small"
              style="width: 140px"
            />
            <div class="quick-btns">
              <el-button v-for="n in quickCounts" :key="n" size="small" :type="generateCount === n ? 'primary' : ''" @click="generateCount = n">{{ n }}</el-button>
            </div>
          </div>
          <div class="control-right">
            <el-button type="primary" size="default" @click="handleGenerate" :disabled="selectedTypes.size === 0" :loading="isGenerating">
              <el-icon><Lightning /></el-icon> 一键生成
            </el-button>
            <el-button size="default" @click="handleGenerateMore" :disabled="results.length === 0">
              <el-icon><Plus /></el-icon> 追加
            </el-button>
            <el-button size="default" @click="handleClear" :disabled="results.length === 0">
              <el-icon><Delete /></el-icon> 清空
            </el-button>
          </div>
        </div>

        <!-- 统计栏 -->
        <div v-if="results.length > 0" class="stats-bar">
          <el-tag type="primary">总条数：{{ results.length }}</el-tag>
          <el-tag v-if="dedupedCount < results.length" type="success">去重后：{{ dedupedCount }}（去重 {{ results.length - dedupedCount }} 条）</el-tag>
          <el-button size="small" text type="primary" @click="handleDeduplicate">
            <el-icon><Select /></el-icon> 去重
          </el-button>
          <span v-if="selectedIds.size > 0" class="batch-actions">
            <el-tag type="warning" size="small">已选 {{ selectedIds.size }} 条</el-tag>
            <el-button size="small" text type="success" @click="handleCopySelected">
              <el-icon><CopyDocument /></el-icon> 复制选中
            </el-button>
            <el-button size="small" text type="danger" @click="handleDeleteSelected">
              <el-icon><Delete /></el-icon> 删除选中
            </el-button>
          </span>
          <el-tag
            class="zoom-tag"
            size="small"
            :type="resultZoom === 130 ? 'info' : 'warning'"
            @click="resultZoom = 130"
            style="cursor:pointer"
            title="点击重置"
          >🔍 {{ displayZoom }}%</el-tag>

          <div class="export-buttons">
            <el-button size="small" @click="handleCopy">
              <el-icon><CopyDocument /></el-icon> 复制全部
            </el-button>
            <el-button size="small" @click="handleCopyMarkdown">
              <el-icon><CopyDocument /></el-icon> 复制Markdown
            </el-button>
            <el-button size="small" @click="handleCopyLastDigits" v-show="hasIdCardData">
              <el-icon><CopyDocument /></el-icon> 复制后{{ idCardParams.lastDigits }}位
            </el-button>
            <el-button size="small" @click="handleExport('txt')">TXT</el-button>
            <el-button size="small" @click="handleExport('csv')">CSV</el-button>
            <el-button size="small" @click="handleExport('sql')">SQL</el-button>
            <el-button size="small" @click="handleExport('md')">MD</el-button>
            <el-button size="small" @click="handleExport('json')">JSON</el-button>
            <el-button size="small" @click="handleExport('xlsx')" type="success">XLSX</el-button>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-if="results.length === 0 && !isGenerating" class="empty-state">
          <div class="empty-illustration">
            <el-icon :size="64" color="#c0c4cc"><Coin /></el-icon>
            <div class="empty-dots">
              <span></span><span></span><span></span>
            </div>
          </div>
          <h3 class="empty-title">暂无数据</h3>
          <p class="empty-desc">选择左侧数据类型，设置参数后点击「一键生成」</p>
          <div class="empty-hints">
            <span>💡 可多选生成器</span>
            <span>📋 支持 Ctrl+C 复制全部</span>
            <span>📤 支持 TXT / CSV / JSON / XLSX 导出</span>
            <span>🔒 敏感数据已加脱敏标识</span>
          </div>
        </div>

        <!-- 结果列表（支持缩放） -->
        <div v-if="results.length > 0" class="result-list" ref="resultListRef" :style="{ zoom: resultZoom / 100 }">
          <div class="result-header">
            <span class="col-check">
              <el-checkbox :checked="isAllSelected" :indeterminate="isIndeterminate" @change="toggleSelectAll" size="small" />
            </span>
            <span class="col-id">#</span>
            <span class="col-type">类型</span>
            <span class="col-value">内容</span>
            <span class="col-last6" v-show="hasIdCardData">后{{ idCardParams.lastDigits }}位</span>
            <span class="col-action">操作</span>
          </div>
          <el-scrollbar height="100%" ref="scrollbarRef">
            <div
              v-for="item in pagedResults"
              :key="item.id"
              class="result-row"
              :class="{ selected: selectedIds.has(item.id) }"
            >
              <span class="col-check">
                <el-checkbox
                  :checked="selectedIds.has(item.id)"
                  @change="toggleSelect(item.id)"
                  size="small"
                />
              </span>
              <span class="col-id">{{ item.id }}</span>
              <span class="col-type">
                <el-tag :type="typeTag(item.type)" size="small">
                  <template #default>
                    <span v-if="isSensitiveType(item.type)" class="sensitive-badge">🔒</span>
                    {{ item.type }}
                  </template>
                </el-tag>
              </span>
              <span class="col-value"
                v-if="editingId !== item.id"
                :title="item.value"
                @dblclick="startEdit(item)"
              >{{ item.value }}</span>
              <span v-else class="col-value editing">
                <el-input
                  v-model="editingValue"
                  size="small"
                  @keyup.enter="saveEdit(item)"
                  @keyup.escape="cancelEdit"
                  @blur="saveEdit(item)"
                  autofocus
                />
              </span>
              <span class="col-last6" v-show="hasIdCardData">{{ item.last6 || '-' }}</span>
              <span class="col-action">
                <el-button size="small" text type="primary" @click="copySingle(item.value)" title="复制">
                  <el-icon><CopyDocument /></el-icon>
                </el-button>
                <el-button size="small" text type="danger" @click="deleteSingleItem(item.id)" title="删除">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </span>
            </div>
          </el-scrollbar>
          <!-- 分页 -->
          <div v-if="displayResults.length > pageSize" class="pagination-bar">
            <el-pagination
              v-model:current-page="currentPage"
              :page-size="pageSize"
              :total="displayResults.length"
              layout="total, prev, pager, next"
              small
              background
            />
          </div>
        </div>

        <!-- 加载动画 -->
        <div v-if="isGenerating" class="loading-overlay">
          <el-progress type="circle" :percentage="generateProgress" :width="80" :stroke-width="6" color="#409eff" />
          <p class="loading-text">⏳ 正在生成数据...</p>
          <p class="loading-hint">生成 {{ generateCount }} 条 × {{ selectedTypes.size }} 种类型</p>
        </div>
      </main>
    </div>

    <!-- 免责声明 -->
    <footer class="app-footer">
      <span>⚠️ 本工具仅供合法的软件测试使用，严禁用于任何非法用途。</span>
    </footer>

    <!-- 首次访问免责弹窗 -->
    <el-dialog v-model="showDisclaimerDialog" title="使用声明" width="400px" :close-on-click-modal="false" :show-close="false">
      <div class="disclaimer-body">
        <el-icon :size="48" color="#e6a23c"><WarningFilled /></el-icon>
        <p><strong>本工具仅供软件测试使用</strong></p>
        <p>生成的数据均为虚拟构造，随机生成，不对应任何真实个人身份信息。</p>
        <p class="disclaimer-warn">严禁将生成数据用于非法用途，包括但不限于身份冒用、欺诈、虚假注册等行为。</p>
        <p class="disclaimer-warn">使用者须自行承担一切法律责任。</p>
      </div>
      <template #footer>
        <el-button type="primary" @click="dismissDisclaimer">我已了解，开始使用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Coin, Lightning, Plus, Delete, CopyDocument, Select,
  Sunny, Moon, Fold, Expand, StarFilled, Edit, WarningFilled,
} from '@element-plus/icons-vue'
import { generateData, deduplicate } from './utils/index'
import { exportData, copyAsMarkdownTable } from './utils/export'
import { REGEX_PRESETS } from './utils/regexGenerator'
import type { GenerateResultItem, GeneratorId, ExportFormat } from './types/types'

// ── 主题 ──────────────────────────────────────────────
const isDark = ref(localStorage.getItem('tdg-dark') === 'true')
function applyDark(v: boolean) {
  localStorage.setItem('tdg-dark', v ? 'true' : 'false')
  document.documentElement.classList.toggle('dark', v)
}
watch(isDark, applyDark)
// 初始化时同步到 html
applyDark(isDark.value)

// ── 持久化参数 ─────────────────────────────────────────
const PERSIST_KEYS = {
  idCardGender: 'tdg-idcard-gender',
  idCardType: 'tdg-idcard-type',
  birthYear: 'tdg-birthyear',
  longTextLang: 'tdg-lang',
  longTextLen: 'tdg-len',
  emailDomains: 'tdg-email-domains',
  emailSpecial: 'tdg-email-special',
  phonePrefixes: 'tdg-phone-prefixes',
  dateFormat: 'tdg-date-format',
  dateYear: 'tdg-date-year',
  generateCount: 'tdg-count',
}

function loadPersist<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) : fallback
  } catch { return fallback }
}

const savedGender = loadPersist(PERSIST_KEYS.idCardGender, 'random')
const savedIdType = loadPersist(PERSIST_KEYS.idCardType, 'mainland')
const savedBirthYear = loadPersist(PERSIST_KEYS.birthYear, [1990, 2005])
const savedLang = loadPersist(PERSIST_KEYS.longTextLang, 'zh')
const savedTextLen = loadPersist(PERSIST_KEYS.longTextLen, [100, 1000])
const savedEmailDomains = loadPersist(PERSIST_KEYS.emailDomains, ['qq.com', 'gmail.com', '163.com'])
const savedEmailSpecial = loadPersist(PERSIST_KEYS.emailSpecial, true)
const savedPhonePrefixes = loadPersist(PERSIST_KEYS.phonePrefixes, ['138', '139', '186', '188'])
const savedDateFormat = loadPersist(PERSIST_KEYS.dateFormat, 'date')
const savedDateYear = loadPersist(PERSIST_KEYS.dateYear, [2020, 2030])
const savedCount = loadPersist(PERSIST_KEYS.generateCount, 10)

// ── 侧栏折叠 + 置顶 ──────────────────────────────────
const sidebarCollapsed = ref(localStorage.getItem('tdg-sidebar') === 'true')
watch(sidebarCollapsed, v => {
  localStorage.setItem('tdg-sidebar', v ? 'true' : 'false')
})

const pinnedTypes = ref<Set<GeneratorId>>(
  new Set(JSON.parse(localStorage.getItem('tdg-pinned') || '[]'))
)
watch(pinnedTypes, v => {
  localStorage.setItem('tdg-pinned', JSON.stringify(Array.from(v)))
}, { deep: true })

function togglePin(id: GeneratorId, e: MouseEvent) {
  e.stopPropagation()
  const next = new Set(pinnedTypes.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  pinnedTypes.value = next
}

/** 生成器列表：置顶的排在前面 */
// ── 生成器列表 ─────────────────────────────────────────
const generators = [
  { id: 'sqlInjection' as GeneratorId, label: 'SQL注入/XSS', icon: 'WarningFilled', description: 'SQL注入、XSS、模板注入等攻击载荷' },
  { id: 'idCard' as GeneratorId, label: '身份证', icon: 'CreditCard', description: '大陆18位/香港/澳门身份证' },
  { id: 'name' as GeneratorId, label: '姓名', icon: 'User', description: '中文姓名（百家姓）' },
  { id: 'email' as GeneratorId, label: '邮箱', icon: 'Message', description: '多域名邮箱地址' },
  { id: 'longText' as GeneratorId, label: '超长文本', icon: 'Document', description: '中/英/日文超长文本' },
  { id: 'phone' as GeneratorId, label: '手机号', icon: 'Iphone', description: '中国大陆11位手机号' },
  { id: 'url' as GeneratorId, label: 'URL', icon: 'Link', description: 'URL 地址' },
  { id: 'ip' as GeneratorId, label: 'IP地址', icon: 'Monitor', description: 'IPv4/IPv6 地址' },
  { id: 'date' as GeneratorId, label: '日期', icon: 'Calendar', description: '日期/时间/时间戳' },
  { id: 'boundary' as GeneratorId, label: '边界值', icon: 'WarningFilled', description: '空/超长/Unicode/Emoji/RTL等' },
  { id: 'bankCard' as GeneratorId, label: '银行卡号', icon: 'CreditCard', description: 'Visa/MasterCard/银联卡号(Luhn校验)' },
  { id: 'licensePlate' as GeneratorId, label: '车牌号', icon: 'Iphone', description: '蓝牌/绿牌新能源/使馆/警用车牌' },
  { id: 'macAddress' as GeneratorId, label: 'MAC地址', icon: 'Monitor', description: '随机 MAC 地址（可指定厂商）' },
  { id: 'uuid' as GeneratorId, label: 'UUID', icon: 'Key', description: 'UUID v4 随机标识符' },
  { id: 'imagePlaceholder' as GeneratorId, label: '占位图', icon: 'Picture', description: '随机图片占位图链接' },
  { id: 'loremIpsum' as GeneratorId, label: '段落文本', icon: 'Document', description: '中文/英文随机段落' },
  { id: 'regex' as GeneratorId, label: '正则生成', icon: 'Edit', description: '自定义正则表达式生成数据' },
]

// ── 数据类型分组 ───────────────────────────────────────
const GENERATOR_GROUPS: { title: string; ids: GeneratorId[] }[] = [
  {
    title: '个人信息',
    ids: ['idCard', 'name', 'phone', 'email', 'bankCard', 'licensePlate'],
  },
  {
    title: '网络数据',
    ids: ['url', 'ip', 'macAddress', 'uuid'],
  },
  {
    title: '通用数据',
    ids: ['date', 'longText', 'loremIpsum', 'imagePlaceholder'],
  },
  {
    title: '测试专用',
    ids: ['sqlInjection', 'boundary', 'regex'],
  },
]

/** 按分组排序 + 置顶优先 */
const sortedGroups = computed(() => {
  const pinned = pinnedTypes.value
  return GENERATOR_GROUPS.map(group => {
    const items = group.ids
      .map(id => generators.find(g => g.id === id)!)
      .filter(Boolean)
    // 置顶的排前面
    items.sort((a, b) => {
      const aPinned = pinned.has(a.id) ? 0 : 1
      const bPinned = pinned.has(b.id) ? 0 : 1
      return aPinned - bPinned
    })
    return { ...group, items }
  })
})
const selectedTypes = ref<Set<GeneratorId>>(new Set(['name']))

/** 当前应该展示参数面板的类别：取第一个选中的类型 */
const activeCategory = computed(() => {
  for (const t of selectedTypes.value) {
    return t
  }
  return null
})

const activeCategoryParams = computed(() => activeCategory.value !== null)

/** 单选切换：点击卡片即选中该类型（取消其他所有选中） */
function toggleCategory(id: GeneratorId) {
  // 点击已选中的不做变化
  if (selectedTypes.value.has(id) && selectedTypes.value.size === 1) return
  selectedTypes.value = new Set([id])
}

// ── 参数配置 ──────────────────────────────────────────
const nameWithPinyin = ref(false)
const nameEthnicity = ref<'han' | 'xinjiang' | 'tibetan' | 'random'>('random')

const idCardParams = reactive({
  gender: savedGender as 'male' | 'female' | 'random',
  idType: savedIdType as 'mainland' | 'hk' | 'macau',
  lastDigits: 6,
})
const birthYearRange = ref(savedBirthYear)

const longTextParams = reactive({
  language: savedLang as 'zh' | 'en' | 'ja' | 'mix',
})
const longTextLengthRange = ref(savedTextLen)

const emailParams = reactive({
  domains: savedEmailDomains,
  allowSpecialChars: savedEmailSpecial,
})
const commonDomains = ['qq.com', '163.com', '126.com', 'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'foxmail.com', 'sina.com']

const phoneParams = reactive({
  prefixes: savedPhonePrefixes,
})
const commonPrefixes = ['130', '131', '135', '138', '139', '150', '186', '188', '199', '166', '177']

const ipParams = reactive({
  version: 4 as 4 | 6,
  categories: ['A', 'B', 'C'] as ('A' | 'B' | 'C' | 'private' | 'loopback')[],
})

const dateParams = reactive({
  format: savedDateFormat as 'date' | 'datetime' | 'timestamp',
})
const dateYearRange = ref(savedDateYear)

const boundaryParams = reactive({
  types: ['empty', 'oversize', 'unicode', 'emoji'] as ('empty' | 'oversize' | 'unicode' | 'emoji' | 'rtl' | 'zerowidth' | 'newline')[],
  extraLength: 10000,
})

const bankCardParams = reactive({
  brand: 'random' as 'random' | 'visa' | 'mastercard' | 'unionpay',
})

const licensePlateParams = reactive({
  type: 'random' as 'random' | 'blue' | 'green' | 'embassy' | 'police',
})

const macAddressParams = reactive({
  separator: ':' as ':' | '-' | 'none',
  oui: undefined as string | undefined,
})

const imagePlaceholderParams = reactive({
  width: 800,
  height: 600,
  service: 'picsum' as 'picsum' | 'placeholder',
})

const loremIpsumParams = reactive({
  language: 'zh' as 'zh' | 'en',
  paragraphs: 3,
  sentencesPerParagraph: 5,
})

const regexPattern = ref('[a-zA-Z0-9]{8}')
const regexFlags = ref('')
const regexPresets = REGEX_PRESETS

const excludeText = ref('')

// ── 配置模板 ──────────────────────────────────────────
interface ConfigTemplate {
  name: string
  data: Record<string, any>
  createdAt: string
}
const configTemplates = ref<ConfigTemplate[]>(
  JSON.parse(localStorage.getItem('tdg-templates') || '[]')
)
watch(configTemplates, v => {
  localStorage.setItem('tdg-templates', JSON.stringify(v))
}, { deep: true })

const templateNameInput = ref('')
const showTemplateDialog = ref(false)

function saveCurrentTemplate() {
  const name = templateNameInput.value.trim()
  if (!name) {
    ElMessage.warning('请输入模板名称')
    return
  }
  // 收集当前所有参数
  const data: Record<string, any> = {
    selectedTypes: Array.from(selectedTypes.value),
    generateCount: generateCount.value,
    nameWithPinyin: nameWithPinyin.value,
    idCardParams: { ...idCardParams },
    birthYearRange: [...birthYearRange.value],
    longTextParams: { ...longTextParams },
    longTextLengthRange: [...longTextLengthRange.value],
    emailParams: { ...emailParams },
    phoneParams: { ...phoneParams },
    ipParams: { ...ipParams },
    dateParams: { ...dateParams },
    dateYearRange: [...dateYearRange.value],
    boundaryParams: { ...boundaryParams },
    bankCardParams: { ...bankCardParams },
    licensePlateParams: { ...licensePlateParams },
    macAddressParams: { ...macAddressParams },
    imagePlaceholderParams: { ...imagePlaceholderParams },
    loremIpsumParams: { ...loremIpsumParams },
    regexPattern: regexPattern.value,
    regexFlags: regexFlags.value,
    excludeText: excludeText.value,
    isDark: isDark.value,
    sidebarCollapsed: sidebarCollapsed.value,
    pinnedTypes: Array.from(pinnedTypes.value),
  }
  configTemplates.value.push({ name, data, createdAt: new Date().toISOString() })
  templateNameInput.value = ''
  showTemplateDialog.value = false
  ElMessage.success(`模板「${name}」已保存`)
}

function loadTemplate(tpl: ConfigTemplate) {
  const d = tpl.data
  if (d.selectedTypes) selectedTypes.value = new Set(d.selectedTypes)
  if (d.generateCount) generateCount.value = d.generateCount
  if (d.nameWithPinyin !== undefined) nameWithPinyin.value = d.nameWithPinyin
  if (d.idCardParams) Object.assign(idCardParams, d.idCardParams)
  if (d.birthYearRange) birthYearRange.value = d.birthYearRange
  if (d.longTextParams) Object.assign(longTextParams, d.longTextParams)
  if (d.longTextLengthRange) longTextLengthRange.value = d.longTextLengthRange
  if (d.emailParams) Object.assign(emailParams, d.emailParams)
  if (d.phoneParams) Object.assign(phoneParams, d.phoneParams)
  if (d.ipParams) Object.assign(ipParams, d.ipParams)
  if (d.dateParams) Object.assign(dateParams, d.dateParams)
  if (d.dateYearRange) dateYearRange.value = d.dateYearRange
  if (d.boundaryParams) Object.assign(boundaryParams, d.boundaryParams)
  if (d.bankCardParams) Object.assign(bankCardParams, d.bankCardParams)
  if (d.licensePlateParams) Object.assign(licensePlateParams, d.licensePlateParams)
  if (d.macAddressParams) Object.assign(macAddressParams, d.macAddressParams)
  if (d.imagePlaceholderParams) Object.assign(imagePlaceholderParams, d.imagePlaceholderParams)
  if (d.loremIpsumParams) Object.assign(loremIpsumParams, d.loremIpsumParams)
  if (d.regexPattern) regexPattern.value = d.regexPattern
  if (d.regexFlags) regexFlags.value = d.regexFlags
  if (d.excludeText !== undefined) excludeText.value = d.excludeText
  if (d.isDark !== undefined) isDark.value = d.isDark
  if (d.sidebarCollapsed !== undefined) sidebarCollapsed.value = d.sidebarCollapsed
  if (d.pinnedTypes) pinnedTypes.value = new Set(d.pinnedTypes)
  ElMessage.success(`已加载模板「${tpl.name}」`)
}

function deleteTemplate(index: number) {
  const name = configTemplates.value[index].name
  configTemplates.value.splice(index, 1)
  ElMessage.info(`模板「${name}」已删除`)
}

// ── 免责声明 ──────────────────────────────────────────
const showDisclaimerDialog = ref(!localStorage.getItem('tdg-disclaimer-shown'))

function dismissDisclaimer() {
  showDisclaimerDialog.value = false
  localStorage.setItem('tdg-disclaimer-shown', 'true')
}

// ── 选中/批量操作 ────────────────────────────────────
const selectedIds = ref(new Set<number>())
const isAllSelected = computed(() =>
  pagedResults.value.length > 0 && pagedResults.value.every(item => selectedIds.value.has(item.id))
)
const isIndeterminate = computed(() => {
  const some = pagedResults.value.some(item => selectedIds.value.has(item.id))
  return some && !isAllSelected.value
})
function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value = new Set()
  } else {
    selectedIds.value = new Set(pagedResults.value.map(item => item.id))
  }
}
function toggleSelect(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}
async function handleCopySelected() {
  const selected = displayResults.value.filter(item => selectedIds.value.has(item.id))
  if (selected.length === 0) { ElMessage.warning('请先勾选数据'); return }
  const text = selected.map(i => i.value).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${selected.length} 条`)
  } catch { ElMessage.warning('复制失败') }
}
function handleDeleteSelected() {
  const ids = selectedIds.value
  if (ids.size === 0) { ElMessage.warning('请先勾选数据'); return }
  results.value = results.value
    .filter(item => !ids.has(item.id))
    .map((item, idx) => ({ ...item, id: idx + 1 }))
  dedupedResults.value = deduplicate(results.value)
  selectedIds.value = new Set()
  ElMessage.success(`已删除 ${ids.size} 条`)
}
const generateCount = ref(savedCount)
const quickCounts = [10, 50, 100, 500, 1000]
const isGenerating = ref(false)
const generateProgress = ref(0)

const results = ref<GenerateResultItem[]>([])
const showDeduped = ref(false)
const dedupedResults = ref<GenerateResultItem[]>([])

const displayResults = computed(() => showDeduped.value ? dedupedResults.value : results.value)
const dedupedCount = computed(() => dedupedResults.value.length)

/** 当前结果中是否有身份证数据 */
const hasIdCardData = computed(() =>
  displayResults.value.some(item => item.type.includes('身份证'))
)

// 分页/虚拟滚动：简单分页，每页 500 条
const currentPage = ref(1)
const pageSize = 500
const pagedResults = computed(() => {
  const all = displayResults.value
  const start = (currentPage.value - 1) * pageSize
  return all.slice(start, start + pageSize)
})

watch(displayResults, () => { currentPage.value = 1 })

// ── 持久化 watchers ──────────────────────────────────
watch(() => idCardParams.gender, v => localStorage.setItem(PERSIST_KEYS.idCardGender, JSON.stringify(v)))
watch(() => idCardParams.idType, v => localStorage.setItem(PERSIST_KEYS.idCardType, JSON.stringify(v)))
watch(birthYearRange, v => localStorage.setItem(PERSIST_KEYS.birthYear, JSON.stringify(v)))
watch(() => longTextParams.language, v => localStorage.setItem(PERSIST_KEYS.longTextLang, JSON.stringify(v)))
watch(longTextLengthRange, v => localStorage.setItem(PERSIST_KEYS.longTextLen, JSON.stringify(v)))
watch(() => emailParams.domains, v => localStorage.setItem(PERSIST_KEYS.emailDomains, JSON.stringify(v)), { deep: true })
watch(() => emailParams.allowSpecialChars, v => localStorage.setItem(PERSIST_KEYS.emailSpecial, JSON.stringify(v)))
watch(() => phoneParams.prefixes, v => localStorage.setItem(PERSIST_KEYS.phonePrefixes, JSON.stringify(v)), { deep: true })
watch(() => dateParams.format, v => localStorage.setItem(PERSIST_KEYS.dateFormat, JSON.stringify(v)))
watch(dateYearRange, v => localStorage.setItem(PERSIST_KEYS.dateYear, JSON.stringify(v)))
watch(generateCount, v => localStorage.setItem(PERSIST_KEYS.generateCount, JSON.stringify(v)))

function typeTag(type: string): string {
  const map: Record<string, string> = {
    'SQL注入/XSS': 'danger',
    '身份证': 'warning',
    '香港身份证': 'warning',
    '澳门身份证': 'warning',
    '姓名': '',
    '邮箱': 'info',
    '超长文本(zh)': 'primary',
    '超长文本(en)': 'primary',
    '超长文本(ja)': 'primary',
    '超长文本(mix)': 'primary',
    '手机号': 'success',
    'URL': 'info',
    'IPv4': '',
    'IPv6': '',
    '日期': '',
    '边界值': 'danger',
    '银行卡号': 'success',
    '车牌号': 'success',
    'MAC地址': 'info',
    'UUID': 'primary',
    '占位图链接': 'info',
    '段落文本(中文)': '',
    '段落文本(EN)': '',
    '正则匹配': 'primary',
  }
  return map[type] || ''
}

/** 判断是否为敏感数据类型（需要脱敏标识） */
const SENSITIVE_TYPES = new Set(['身份证', '香港身份证', '澳门身份证', '手机号', '银行卡号'])
function isSensitiveType(type: string): boolean {
  return SENSITIVE_TYPES.has(type)
}

// ── 生成逻辑 ──────────────────────────────────────────
let currentMaxId = 0

function buildResultsAndDedup(newItems: GenerateResultItem[], append: boolean) {
  const combined = append ? [...results.value, ...newItems] : newItems
  results.value = combined
  dedupedResults.value = deduplicate(combined)
  showDeduped.value = false
  currentMaxId = combined.reduce((max, item) => Math.max(max, item.id), 0)
}

async function handleGenerate() {
  if (selectedTypes.value.size === 0) {
    ElMessage.warning('请至少选择一种数据类型')
    return
  }

  isGenerating.value = true
  generateProgress.value = 0
  currentMaxId = 0  // 重新生成从 1 开始编号

  // 阶梯式进度模拟（按生成器类型分步）
  const typeList = Array.from(selectedTypes.value)
  const stepSize = Math.floor(85 / typeList.length)
  const progressTimer = setInterval(() => {
    if (generateProgress.value < 85) {
      generateProgress.value += 0.5
    }
  }, 80)

  try {
    const allResults: GenerateResultItem[] = []
    let step = 0

    for (const typeId of typeList) {
      const cfg = buildConfig(typeId, generateCount.value)
      const items = generateData(cfg)
      items.forEach(item => { item.id = ++currentMaxId })
      allResults.push(...items)
      step++
      generateProgress.value = Math.min(85, step * stepSize)
    }

    buildResultsAndDedup(allResults, false)
    generateProgress.value = 100

    ElMessage.success(`成功生成 ${allResults.length} 条数据`)
  } catch (err) {
    ElMessage.error('生成失败：' + String(err))
  } finally {
    clearInterval(progressTimer)
    setTimeout(() => { isGenerating.value = false }, 300)
  }
}

function handleGenerateMore() {
  if (selectedTypes.value.size === 0) {
    ElMessage.warning('请至少选择一种数据类型')
    return
  }
  // 重新生成并追加
  isGenerating.value = true
  setTimeout(async () => {
    try {
      const moreResults: GenerateResultItem[] = []
      for (const typeId of selectedTypes.value) {
        const cfg = buildConfig(typeId, generateCount.value)
        const items = generateData(cfg)
        items.forEach(item => { item.id = ++currentMaxId })
        moreResults.push(...items)
      }
      buildResultsAndDedup(moreResults, true)
      ElMessage.success(`追加 ${moreResults.length} 条，共 ${results.value.length} 条`)
    } catch (err) {
      ElMessage.error('追加失败：' + String(err))
    } finally {
      isGenerating.value = false
    }
  }, 50)
}

function handleClear() {
  results.value = []
  dedupedResults.value = []
  showDeduped.value = false
  currentMaxId = 0
}

function handleDeduplicate() {
  if (dedupedResults.value.length === 0) return
  showDeduped.value = !showDeduped.value
  ElMessage.info(showDeduped.value ? '已显示去重后结果' : '已显示全部结果')
}

/** 行内编辑：双击编辑结果值 */
const editingId = ref<number | null>(null)
const editingValue = ref('')

function startEdit(item: GenerateResultItem) {
  editingId.value = item.id
  editingValue.value = item.value
}

function saveEdit(item: GenerateResultItem) {
  if (editingValue.value.trim()) {
    item.value = editingValue.value.trim()
    // 同步更新 dedupedResults
    const dedupItem = dedupedResults.value.find(i => i.id === item.id)
    if (dedupItem) dedupItem.value = item.value
  }
  editingId.value = null
  editingValue.value = ''
}

function cancelEdit() {
  editingId.value = null
  editingValue.value = ''
}

/** 删除单条数据并重新编号 */
function deleteSingleItem(id: number) {
  results.value = results.value
    .filter(item => item.id !== id)
    .map((item, idx) => ({ ...item, id: idx + 1 }))
  dedupedResults.value = deduplicate(results.value)
  if (editingId.value === id) cancelEdit()
  ElMessage.success('已删除')
}

// ── 构建配置 ──────────────────────────────────────────
function buildConfig(id: GeneratorId, count: number) {
  const base: any = { id, count }
  // 全局排除项
  const excludes = excludeText.value.split('\n').map(s => s.trim()).filter(Boolean)
  if (excludes.length > 0) base.excludeValues = excludes
  switch (id) {
    case 'name':
      base.nameWithPinyin = nameWithPinyin.value
      base.nameEthnicity = nameEthnicity.value
      break
    case 'idCard':
      base.idCard = { ...idCardParams, birthYearMin: birthYearRange.value[0], birthYearMax: birthYearRange.value[1] }
      base.idCardLastDigits = idCardParams.lastDigits
      break
    case 'longText':
      base.longText = { ...longTextParams, minLength: longTextLengthRange.value[0], maxLength: longTextLengthRange.value[1] }
      break
    case 'email':
      base.email = { ...emailParams }
      break
    case 'phone':
      base.phone = { ...phoneParams }
      break
    case 'ip':
      base.ip = { ...ipParams }
      break
    case 'date':
      base.date = { ...dateParams, yearMin: dateYearRange.value[0], yearMax: dateYearRange.value[1] }
      break
    case 'boundary':
      base.boundary = { ...boundaryParams }
      break
    case 'bankCard':
      base.bankCard = { ...bankCardParams }
      break
    case 'licensePlate':
      base.licensePlate = { ...licensePlateParams }
      break
    case 'uuid':
      // UUID 无额外参数
      break
    case 'macAddress':
      base.macAddress = { ...macAddressParams }
      break
    case 'imagePlaceholder':
      base.imagePlaceholder = { ...imagePlaceholderParams }
      break
    case 'loremIpsum':
      base.loremIpsum = { ...loremIpsumParams }
      break
    case 'regex':
      base.regexPattern = regexPattern.value
      base.regexFlags = regexFlags.value
      break
  }
  return base
}

// ── 复制 ──────────────────────────────────────────────
async function copySingle(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败')
  }
}

async function handleCopy() {
  const allValues = displayResults.value.map(i => i.value).join('\n')
  try {
    await navigator.clipboard.writeText(allValues)
    ElMessage.success('已复制全部 ' + displayResults.value.length + ' 条')
  } catch {
    ElMessage.warning('复制失败')
  }
}

async function handleCopyMarkdown() {
  const table = copyAsMarkdownTable(displayResults.value)
  try {
    await navigator.clipboard.writeText(table)
    ElMessage.success('已复制 Markdown 表格（' + displayResults.value.length + ' 条）')
  } catch {
    ElMessage.warning('复制失败')
  }
}

/** 复制身份证后 N 位 */
async function handleCopyLastDigits() {
  const items = displayResults.value.filter(i => SENSITIVE_TYPES.has(i.type) && i.last6)
  if (items.length === 0) { ElMessage.warning('没有身份证数据'); return }
  const text = items.map(i => i.last6).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${items.length} 条后 ${idCardParams.lastDigits} 位`)
  } catch {
    ElMessage.warning('复制失败')
  }
}

// ── 导出 ──────────────────────────────────────────────
function makeExportFilename(extension: string): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const types = Array.from(selectedTypes.value)
  const typeStr = types.length > 0 ? types.join('_') : '全部'
  return `测试数据_${typeStr}_${dateStr}.${extension}`
}

async function handleExport(format: ExportFormat) {
  try {
    const { content, extension } = await exportData(displayResults.value, format)
    const isBinary = format === 'xlsx'
    const filename = makeExportFilename(extension)

    // 尝试用 Electron API 保存
    if (window.electronAPI) {
      const result = await window.electronAPI.saveFile(
        filename,
        isBinary ? (content as Uint8Array) : (content as string),
        [{ name: `${format.toUpperCase()} Files`, extensions: [extension] }],
        isBinary ? undefined : 'utf-8'
      )
      if (result.success) {
        ElMessage.success(`已导出为 ${filename}`)
      } else if (result.reason !== 'canceled') {
        ElMessage.warning('导出失败')
      }
    } else {
      // 浏览器环境：下载
      const blob = isBinary
        ? new Blob([content as BlobPart])
        : new Blob([content as string], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      ElMessage.success(`已下载 ${filename}`)
    }
  } catch (err) {
    ElMessage.error('导出失败：' + String(err))
  }
}

// ── 键盘快捷键 ────────────────────────────────────────
function handleKeydown(e: KeyboardEvent) {
  // Ctrl+Enter: 生成
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    handleGenerate()
    return
  }
  // Ctrl+Shift+C: 复制全部（带格式）
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
    e.preventDefault()
    handleCopy()
    return
  }
  // Esc: 取消编辑
  if (e.key === 'Escape' && editingId.value !== null) {
    cancelEdit()
    return
  }
  // Ctrl+L: 清空结果
  if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
    e.preventDefault()
    handleClear()
    return
  }
  // Ctrl+= / Ctrl+- / Ctrl+0: 缩放
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(10); return }
    if (e.key === '-') { e.preventDefault(); adjustZoom(-10); return }
    if (e.key === '0') { e.preventDefault(); resultZoom.value = 130; return }
  }
}

// ── 结果区缩放 ────────────────────────────────────────
/** CSS zoom 实际值（130 = 1.3 倍，作为基准） */
const resultZoom = ref(Number(localStorage.getItem('tdg-zoom')) || 130)
/** 显示用百分比：以 130 为 100% 基准 */
const displayZoom = computed(() => Math.round(resultZoom.value / 130 * 100))
watch(resultZoom, v => {
  localStorage.setItem('tdg-zoom', String(v))
})
function adjustZoom(delta: number) {
  resultZoom.value = Math.max(78, Math.min(260, resultZoom.value + delta * 1.3))
  // 78~260 对应显示 60%~200%
}
function handleWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  adjustZoom(e.deltaY > 0 ? -10 : 10)
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('wheel', handleWheel, { passive: false })
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('wheel', handleWheel)
})

// ── 暴露给模板的事件
</script>

<style>
/* 全局 CSS 变量 — 统一 Element Plus 色板 */
:root {
  --el-color-primary: #409eff;
  --el-color-success: #67c23a;
  --el-color-danger: #f56c6c;
  --el-color-warning: #e6a23c;
  --el-color-info: #909399;
}
</style>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f7fa;
  color: #333;
  transition: background 0.3s, color 0.3s;
  overflow-x: hidden;
  min-width: 0;
}
.app-container.dark {
  background: #1a1a2e;
  color: #e0e0e0;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  z-index: 10;
  flex-shrink: 0;
}
.dark .app-header {
  background: #16213e;
  border-color: #2a2a4a;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.app-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左侧面板 */
.left-panel {
  width: 280px;
  min-width: 280px;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  overflow: hidden;
  flex-shrink: 0;
  transition: width 0.25s ease, min-width 0.25s ease;
}
.left-panel.collapsed {
  width: 60px;
  min-width: 60px;
}
.dark .left-panel {
  background: #16213e;
  border-color: #2a2a4a;
}

/* 侧栏折叠按钮 */
.sidebar-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  color: #999;
  transition: color 0.2s;
  border-bottom: 1px solid #ebeef5;
  user-select: none;
}
.sidebar-toggle:hover {
  color: #409eff;
}
.dark .sidebar-toggle {
  border-color: #2a2a4a;
}
.dark .sidebar-toggle:hover {
  color: #7ec8f0;
}
.left-panel.collapsed .sidebar-toggle {
  justify-content: center;
  padding: 8px 0;
}
.toggle-label {
  font-size: 13px;
  white-space: nowrap;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  margin: 16px 16px 8px;
  color: #666;
}
.dark .panel-title { color: #aaa; }

.category-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 0 12px 12px;
}
.left-panel.collapsed .category-grid {
  grid-template-columns: 1fr;
  padding: 0 6px 12px;
  justify-items: center;
}
.category-grid.collapsed .category-card {
  justify-content: center;
  padding: 6px 0;
}
.group-title {
  font-size: 12px;
  color: #86909c;
  margin: 16px 16px 6px;
  padding: 0;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.dark .group-title { color: #6a6a8a; }
.category-card {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px;
  border-radius: 6px;
  border: 1px solid #ebeef5;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  position: relative;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.category-card.pinned {
  border-color: #e6a23c;
  background: #fdf6ec;
}
.dark .category-card.pinned {
  background: #3a2a0a;
  border-color: #e6a23c;
}
.pin-icon {
  color: #ddd;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.2s, transform 0.2s;
  margin-left: auto;
}
.pin-icon:hover {
  color: #e6a23c;
  transform: scale(1.2);
}
.pin-icon.pinned {
  color: #e6a23c;
}
.category-card:hover {
  border-color: #409eff;
  background: #ecf5ff;
}
.category-card.active {
  border-color: #409eff;
  background: #ecf5ff;
  color: #409eff;
  font-weight: 500;
}
.dark .category-card {
  border-color: #2a2a4a;
  color: #ccc;
}
.dark .category-card.active {
  background: #1a3a5c;
  border-color: #409eff;
  color: #7ec8f0;
}
.cat-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.params-section {
  border-top: 1px solid #ebeef5;
  padding: 0 16px 16px;
}
.dark .params-section { border-color: #2a2a4a; }

.range-labels {
  font-size: 11px;
  color: #999;
  margin-top: 4px;
  text-align: center;
}

.range-input-group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.range-sep {
  font-size: 14px;
  color: #999;
  flex-shrink: 0;
}

/* 主面板 */
.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-width: 0;
}

.control-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.dark .control-bar {
  background: #16213e;
  border-color: #2a2a4a;
}
.control-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.control-label { font-size: 14px; white-space: nowrap; }
.quick-btns { display: flex; gap: 4px; }
.control-right { display: flex; gap: 6px; flex-wrap: wrap; }

.stats-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #fafafa;
  border-bottom: 1px solid #ebeef5;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.dark .stats-bar {
  background: #1a1a2e;
  border-color: #2a2a4a;
}
.zoom-tag {
  cursor: pointer !important;
  user-select: none;
}
.zoom-tag:hover {
  opacity: 0.8;
}
.export-buttons {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.batch-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #999;
  gap: 12px;
  user-select: none;
}
.empty-illustration {
  position: relative;
  margin-bottom: 8px;
}
.empty-dots {
  display: flex;
  gap: 6px;
  justify-content: center;
  margin-top: 8px;
}
.empty-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d9d9d9;
  animation: dotPulse 1.5s ease-in-out infinite;
}
.empty-dots span:nth-child(2) { animation-delay: 0.3s; }
.empty-dots span:nth-child(3) { animation-delay: 0.6s; }
.dark .empty-dots span { background: #4a4a6a; }
@keyframes dotPulse {
  0%, 60%, 100% { transform: scale(0.6); opacity: 0.4; }
  30% { transform: scale(1); opacity: 1; }
}
.empty-title {
  font-size: 20px;
  font-weight: 600;
  color: #909399;
  margin: 0;
}
.dark .empty-title { color: #6a6a8a; }
.empty-desc {
  font-size: 15px;
  color: #c0c4cc;
  margin: 0;
}
.empty-hints {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-top: 12px;
  font-size: 13px;
  color: #bbb;
}
.empty-hints span {
  padding: 4px 12px;
  background: #f5f7fa;
  border-radius: 12px;
  white-space: nowrap;
}
.dark .empty-hints span {
  background: #2a2a4a;
  color: #888;
}

/* 正则预设标签 */
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.preset-tag {
  cursor: pointer;
  transition: all 0.2s;
}
.preset-tag:hover {
  transform: scale(1.05);
}

/* 排除项 */
.exclude-section :deep(.el-divider) {
  margin: 8px 0;
}

/* 配置模板 */
.template-section {
  padding: 0 16px;
}
.template-section :deep(.el-divider) {
  margin: 8px 0;
}
.template-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.template-title {
  font-size: 13px;
  font-weight: 600;
  color: #999;
}
.template-empty {
  font-size: 12px;
  color: #ccc;
  padding: 4px 0;
}
.template-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: default;
  transition: background 0.15s;
}
.template-item:hover {
  background: #f5f7fa;
}
.dark .template-item:hover {
  background: #2a2a4a;
}
.template-name {
  font-size: 13px;
  cursor: pointer;
  color: #409eff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.template-name:hover {
  color: #66b1ff;
}

.result-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.result-header {
  display: flex;
  padding: 6px 16px;
  background: #f5f7fa;
  font-size: 14px;
  font-weight: 600;
  color: #666;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}
.dark .result-header {
  background: #1a1a2e;
  color: #aaa;
  border-color: #2a2a4a;
}
.result-row {
  display: flex;
  padding: 12px 16px;
  font-size: 14px;
  border-bottom: 1px solid #f0f0f0;
  align-items: center;
  transition: background 0.15s, border-color 0.15s;
  min-width: 0;
  border-left: 3px solid transparent;
}
.result-row:hover {
  background: #eef4ff;
  border-left-color: #409eff;
}
.result-row:nth-child(even) { background: #fafbfc; }
.result-row:nth-child(even):hover { background: #e8f0fe; }
.result-row.selected {
  background: #e8f3ff !important;
  border-left-color: #409eff;
}
.dark .result-row.selected {
  background: #1a2a4a !important;
  border-left-color: #409eff;
}
.dark .result-row { border-color: #2a2a4a; }
.dark .result-row:hover {
  background: #1e2a4a;
  border-left-color: #7ec8f0;
}
.dark .result-row:nth-child(even) { background: #1a1a30; }
.dark .result-row:nth-child(even):hover { background: #1e2a4a; }

.col-id {
  width: 40px;
  min-width: 40px;
  color: #999;
  font-family: monospace;
}
.col-check {
  width: 36px;
  min-width: 36px;
  text-align: center;
}
.col-type {
  width: 130px;
  min-width: 130px;
}
.col-last6 {
  width: 85px;
  min-width: 85px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 15px;
  color: #e6a23c;
  font-weight: 600;
  text-align: right;
  padding-right: 8px;
}
.sensitive-badge {
  margin-right: 2px;
  font-size: 11px;
}
.col-value {
  flex: 1;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Courier New', Courier, monospace;
  font-size: 15px;
}
.col-value.editing {
  overflow: visible;
}
.col-value.editing :deep(.el-input) {
  width: 100%;
}
.col-action {
  width: 80px;
  min-width: 80px;
  text-align: center;
  display: flex;
  gap: 2px;
  justify-content: center;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(255,255,255,0.85);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  z-index: 20;
}
.dark .loading-overlay {
  background: rgba(0,0,0,0.75);
}
.loading-text {
  font-weight: 500;
}
.loading-hint {
  font-size: 11px;
  color: #999;
}
.dark .loading-hint { color: #666; }

.pagination-bar {
  display: flex;
  justify-content: center;
  padding: 8px;
  border-top: 1px solid #ebeef5;
  flex-shrink: 0;
  background: #fff;
}
.dark .pagination-bar {
  border-color: #2a2a4a;
  background: #16213e;
}

/* 底部免责声明 */
.app-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 40px;
  padding: 0 16px;
  background: #f7f8fa;
  border-top: 1px solid #e5e6eb;
  font-size: 12px;
  color: #86909c;
  flex-shrink: 0;
}
.dark .app-footer {
  background: #1a1a2e;
  border-color: #2a2a4a;
  color: #666;
}
.footer-link {
  color: #409eff;
  text-decoration: none;
  flex-shrink: 0;
}
.footer-link:hover {
  text-decoration: underline;
}

.disclaimer-body {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  line-height: 1.6;
}
.disclaimer-body p { margin: 0; }
.disclaimer-warn {
  color: #e6a23c;
  font-weight: 500;
}
</style>
