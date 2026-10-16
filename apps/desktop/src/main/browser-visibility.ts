export interface BrowserNodeGeometry {
  bounds: { x: number; y: number; width: number; height: number }
  point: { x: number; y: number }
  tag: string
  inputType?: string
}

/** 在网页自身的坐标系内检查布局、滚动裁切与遮挡，文本使用自己的 Range。 */
export const browserNodeGeometry = `function(requireEnabled = false) {
  if (!this.isConnected) return null;
  const text = this.nodeType === 3;
  const element = text ? this.parentElement : this;
  if (!element || element.nodeType !== 1) return null;
  const document = element.ownerDocument, view = document.defaultView;
  const parent = node => node.parentElement || node.getRootNode().host;
  const contains = node => {
    for (let current = node; current; current = parent(current)) if (current === element) return true;
    return false;
  };
  const hitAt = (x,y) => {
    let hit = document.elementFromPoint(x,y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x,y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return text ? hit === element : contains(hit);
  };
  let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
  if (view.getComputedStyle(element).visibility !== 'visible') return null;
  for (let current = element; current; current = parent(current)) {
    if (requireEnabled && current.matches(':disabled,[aria-disabled="true"]')) throw Error('元素不可用，请重新观察');
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || Number(style.opacity) === 0) return null;
    if (current === element) continue;
    const rect = current.getBoundingClientRect();
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
      left = Math.max(left, rect.left + current.clientLeft);
      right = Math.min(right, rect.left + current.clientLeft + current.clientWidth);
    }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
      top = Math.max(top, rect.top + current.clientTop);
      bottom = Math.min(bottom, rect.top + current.clientTop + current.clientHeight);
    }
  }
  let rects;
  if (text) {
    const range = document.createRange();
    range.selectNodeContents(this);
    rects = range.getClientRects();
  } else rects = element.getClientRects();
  for (const rect of rects) {
    const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
    const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
    if (width < 1 || height < 1) continue;
    const positions = [[0.5,0.5],[0.1,0.1],[0.9,0.1],[0.1,0.9],[0.9,0.9]];
    for (const [dx,dy] of positions) {
      const point = {x:x + width * dx, y:y + height * dy};
      if (hitAt(point.x,point.y)) return {bounds:{x,y,width,height}, point,
        tag:element.localName, ...(element.localName === 'input' ? {inputType:element.type} : {})};
    }
  }
  return null;
}`
