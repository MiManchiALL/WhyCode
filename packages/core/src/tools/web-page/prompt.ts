export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const WEB_FETCH_TOOL_PROMPT = [
  '读取公开 HTTP(S) 网页。已知 URL 时只需传 url。正文带行号，可用 offset 和 limit 读取指定范围。',
  '在本会话已读取的网页中查找文字时，传同一 url 和 pattern。pattern 可以是一个关键词或一组关键词，返回匹配任一词的行号和正文。只想查词且页面尚未缓存时，先传 url 和 limit=1，收到正文后再查找。',
  '远程 PDF 返回会话附件引用，用 ReadFile 按页读取。',
].join('\n\n')
