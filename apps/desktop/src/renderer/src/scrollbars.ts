import { createScrollbarActivity } from '../../shared/scrollbar-activity.ts'

export const scrollbars = createScrollbarActivity(document)
if (import.meta.hot) import.meta.hot.dispose(() => scrollbars.dispose())
