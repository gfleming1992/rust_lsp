/** 
 * Creates a vertical or horizontal drag-to-resize handler.
 * @param handleId - DOM id of the resize handle element
 * @param getTarget - Function returning the element to resize (or its style property)
 * @param axis - 'y' for vertical (height), 'x' for horizontal (width)
 * @param min - Minimum size in pixels
 * @param max - Maximum size in pixels
 * @param property - CSS property to modify ('maxHeight', 'maxWidth', 'width', 'height')
 */
export function setupResizeHandle(
  handleId: string,
  getTarget: () => HTMLElement | null,
  axis: 'x' | 'y',
  min: number,
  max: number,
  property: 'maxHeight' | 'maxWidth' | 'width' | 'height' = axis === 'y' ? 'maxHeight' : 'width'
) {
  const handle = document.getElementById(handleId);
  if (!handle) return;

  let isDragging = false;
  let startPos = 0;
  let startSize = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    startPos = axis === 'y' ? e.clientY : e.clientX;
    const target = getTarget();
    startSize = target ? (axis === 'y' ? target.offsetHeight : target.offsetWidth) : 200;
    document.body.style.cursor = axis === 'y' ? 'ns-resize' : 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const delta = (axis === 'y' ? e.clientY : e.clientX) - startPos;
    const newSize = Math.max(min, Math.min(max, startSize + delta));
    const target = getTarget();
    if (target) target.style[property] = `${newSize}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}
