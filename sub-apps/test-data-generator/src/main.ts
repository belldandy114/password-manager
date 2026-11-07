import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
// 只注册实际用到的图标。之前是把 @element-plus/icons-vue 全量（几百个组件）循环注册，
// 会明显拖慢子应用首屏解析。
// 注意：这份清单必须覆盖「模板里直接写的图标」+「generators 里 icon 字段引用的图标」，
// 少一个对应位置就是空白（侧栏卡片曾经整排没有图标，就是漏了动态那批）。
import {
  Calendar, Coin, CopyDocument, CreditCard, Delete, Document, Edit, Expand, Fold,
  Iphone, Key, Lightning, Link, Message, Monitor, Picture, Plus, Select, StarFilled,
  User, WarningFilled,
} from '@element-plus/icons-vue'
import App from './App.vue'

const icons = {
  Calendar, Coin, CopyDocument, CreditCard, Delete, Document, Edit, Expand, Fold,
  Iphone, Key, Lightning, Link, Message, Monitor, Picture, Plus, Select, StarFilled,
  User, WarningFilled,
}

const app = createApp(App)
for (const [key, component] of Object.entries(icons)) {
  app.component(key, component)
}

app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
