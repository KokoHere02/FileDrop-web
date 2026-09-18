/** 在按钮点击期间调用，兼容不提供 Clipboard API 的 HTTP 页面。 */
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return } catch { /* 尝试旧式复制。 */ }
  }
  const active = document.activeElement as HTMLElement | null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = value
  field.readOnly = true
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px;'
  document.body.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, value.length)
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择并复制内容')
  } finally {
    field.remove()
    active?.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      ranges.forEach(range => selection.addRange(range))
    }
  }
}
