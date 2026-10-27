import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
// 只注册实际用到的图标。之前是把 @element-plus/icons-vue 全量（几百个组件）循环注册，
// 会明显拖慢子应用首屏解析。
import { Coin, CopyDocument, Delete, Lightning, Plus, Select, StarFilled, WarningFilled } from '@element-plus/icons-vue'
import App from './App.vue'

const app = createApp(App)

const icons = { Coin, CopyDocument, Delete, Lightning, Plus, Select, StarFilled, WarningFilled }
for (const [key, component] of Object.entries(icons)) {
  app.component(key, component)
}

app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
