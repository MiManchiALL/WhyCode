import { memo, useMemo, type RefObject } from 'react'
import {
  conversationNavigationEntries,
  conversationNavigationEntryY,
  conversationNavigationMarkerWidth,
  sameConversationNavigationTimeline,
  visibleConversationNavigationMarkers,
  type ConversationNavigationEntry,
} from './conversation-navigation.ts'
import type { ConversationSection } from './conversation-sections.ts'
import { useConversationNavigator } from './use-conversation-navigator.ts'

const TOOLTIP_EDGE_PX = 64

interface ConversationNavigatorProps {
  sections: readonly ConversationSection[]
  scrollRef: RefObject<HTMLElement | null>
  onNavigate: (targetId: string) => void
}

/** 历史长度不影响 DOM 数量；高速滚轮只移动固定窗口，不切换语义预览。 */
export const ConversationNavigator = memo(
  function ConversationNavigator(props: ConversationNavigatorProps) {
    const entries = useMemo(
      () => conversationNavigationEntries(props.sections),
      [props.sections],
    )
    const navigation = useConversationNavigator(entries, props.scrollRef)
    const markers = visibleConversationNavigationMarkers(
      entries.length,
      navigation.height,
      navigation.offset,
    )
    const preview = navigation.previewIndex === null
      ? null
      : entries[navigation.previewIndex] ?? null
    const tooltipTop = navigation.previewIndex === null
      ? 0
      : clamp(
          conversationNavigationEntryY(
            navigation.previewIndex,
            entries.length,
            navigation.height,
            navigation.offset,
          ),
          TOOLTIP_EDGE_PX,
          Math.max(TOOLTIP_EDGE_PX, navigation.height - TOOLTIP_EDGE_PX),
        )

    return (
      <aside
        className="wc-conversation-navigator"
        aria-label="会话定位"
      >
        <div
          ref={navigation.railRef}
          className="wc-conversation-navigator-rail"
          onPointerEnter={navigation.handlePointerEnter}
          onPointerMove={navigation.handlePointerMove}
          onPointerLeave={navigation.handlePointerLeave}
        >
          <div className="wc-conversation-navigator-track">
            {markers.map((marker) => (
              <ConversationNavigationMarker
                key={entries[marker.entryIndex]!.id}
                entry={entries[marker.entryIndex]!}
                entryIndex={marker.entryIndex}
                y={marker.y}
                edgeOpacity={marker.edgeOpacity}
                waveIndex={navigation.waveIndex}
                hovered={marker.entryIndex === navigation.highlightIndex}
                activated={entries[marker.entryIndex]!.id === navigation.activatedEntryId}
                onNavigate={() => {
                  navigation.activateEntry(entries[marker.entryIndex]!.id)
                  props.onNavigate(entries[marker.entryIndex]!.id)
                }}
              />
            ))}
          </div>
          {navigation.pointerInside && navigation.waveIndex !== null && preview && (
            <ConversationNavigationPreview entry={preview} top={tooltipTop} />
          )}
        </div>
      </aside>
    )
  },
  (previous, next) => previous.scrollRef === next.scrollRef
    && previous.onNavigate === next.onNavigate
    && sameConversationNavigationTimeline(previous.sections, next.sections),
)

function ConversationNavigationMarker({
  entry,
  entryIndex,
  y,
  edgeOpacity,
  waveIndex,
  hovered,
  activated,
  onNavigate,
}: {
  entry: ConversationNavigationEntry
  entryIndex: number
  y: number
  edgeOpacity: number
  waveIndex: number | null
  hovered: boolean
  activated: boolean
  onNavigate: () => void
}) {
  const width = conversationNavigationMarkerWidth(entryIndex, waveIndex)
  return (
    <button
      type="button"
      className="wc-conversation-navigator-marker wc-focus-ring"
      style={{
        opacity: hovered || activated ? 1 : edgeOpacity,
        transform: `translateY(${y - 6}px)`,
      }}
      aria-label={`跳转到：${entry.title}`}
      aria-current={activated ? 'location' : undefined}
      data-hovered={hovered ? 'true' : undefined}
      onClick={onNavigate}
    >
      <span
        style={{
          width,
          height: entryIndex % 2 === 0 ? 1.7 : 1.6,
        }}
      />
    </button>
  )
}

function ConversationNavigationPreview({
  entry,
  top,
}: {
  entry: ConversationNavigationEntry
  top: number
}) {
  return (
    <div className="wc-conversation-navigator-preview" style={{ top }}>
      <div className="wc-conversation-navigator-preview-title">{entry.title}</div>
      {entry.preview && (
        <div className="wc-conversation-navigator-preview-text">{entry.preview}</div>
      )}
    </div>
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
