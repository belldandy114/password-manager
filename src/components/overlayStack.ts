/**
 * 浮层叠放顺序（谁在最上面）。
 *
 * 问题：Modal、ImageLightbox、TagSidebar 的自定义遮罩都各自往 document 上挂 keydown，
 * 一堆浮层同时打开时按一次 Esc 会全部关掉（嵌套确认框最明显）。
 *
 * 做法：每个浮层打开时拿一个 token 压栈、关闭时出栈，处理 Esc / Tab 前先问
 * `isTopOverlay(token)`。栈按「打开顺序」而不是 DOM 顺序，和视觉层级一致——
 * 灯箱从弹窗里点开时，它就是最后入栈的那个。
 */

const stack: symbol[] = [];

export function createOverlayToken(): symbol {
  return Symbol('overlay');
}

export function pushOverlay(token: symbol): void {
  removeOverlay(token);
  stack.push(token);
}

export function removeOverlay(token: symbol): void {
  const index = stack.lastIndexOf(token);
  if (index >= 0) stack.splice(index, 1);
}

export function isTopOverlay(token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** 单测用：清空栈 */
export function resetOverlayStack(): void {
  stack.length = 0;
}
