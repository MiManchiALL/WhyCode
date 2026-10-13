/** Electron guest 的 Input.insertText 可静默失效，直接对已确认的 DOM 编辑目标执行输入。 */
export const browserInputFunction = `function(text, replace) {
  const element = this;
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (!element.isConnected || element.disabled || element.readOnly || !element.getClientRects().length)
    throw Error('输入目标不可编辑，请重新观察');
  element.focus({preventScroll:true});
  if (element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement) {
    if (element instanceof view.HTMLInputElement && ['file','checkbox','radio','button','submit','reset','image','hidden'].includes(element.type))
      throw Error('此元素不支持文本输入');
    const start = replace ? 0 : (element.selectionStart ?? element.value.length);
    const end = replace ? element.value.length : (element.selectionEnd ?? start);
    const next = element.value.slice(0, start) + text + element.value.slice(end);
    const prototype = element instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, next);
    if (element.value !== next) throw Error('输入内容不符合控件格式');
    if (element.selectionStart !== null) element.setSelectionRange(start + text.length, start + text.length);
    element.dispatchEvent(new view.InputEvent('input', {bubbles:true, composed:true, inputType:'insertText', data:text}));
    if (element.value !== next) throw Error('网页未保留输入内容，请重新观察');
    return {value:element.value};
  }
  if (!element.isContentEditable) throw Error('当前焦点不是可编辑文本，请先选择输入框');
  if (replace) {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) throw Error('网页拒绝了文本编辑');
  return {value:element.textContent};
}`

export const focusedBrowserElement = `(() => {
  let root = document;
  for (let depth = 0; depth < 20; depth++) {
    const element = root.activeElement;
    if (!element) return null;
    if (element.shadowRoot?.activeElement) { root = element.shadowRoot; continue; }
    if (element.tagName === 'IFRAME' && element.contentDocument) { root = element.contentDocument; continue; }
    return element;
  }
  return null;
})()`
