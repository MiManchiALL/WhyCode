import type { WebSource } from '@whycode/core/web-source'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Copy, ExternalLink, FileText, GitBranch, Globe2 } from 'lucide-react'
import { sourceKindForUrl, type SourceKind } from './markdown-sources.ts'

export function SourceIcon({ kind }: { kind: SourceKind }) {
  const Icon = kind === 'git' ? GitBranch : kind === 'document' ? FileText : Globe2
  return <Icon className="wc-source-link-icon" aria-hidden="true" />
}

export function SourceCapsule({ source }: { source: WebSource }) {
  const copyLink = () => {
    void navigator.clipboard.writeText(source.url).catch(() => undefined)
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="wc-source-capsule"
          data-source-capsule-url={source.url}
          aria-label={`查看来源：${source.title}`}
        >
          <SourceIcon kind={sourceKindForUrl(source.url)} />
          <span className="wc-source-label">{source.title}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="wc-menu-content wc-source-menu-content"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <DropdownMenu.Label className="wc-source-menu-heading">
            <span className="wc-source-menu-icon" aria-hidden="true">
              <SourceIcon kind={sourceKindForUrl(source.url)} />
            </span>
            <span className="wc-source-menu-summary">
              <span className="wc-source-menu-title">{source.title}</span>
              <span className="wc-source-menu-domain">{new URL(source.url).hostname.replace(/^www\./u, '')}</span>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="wc-source-menu-separator" />
          <DropdownMenu.Item asChild className="wc-menu-item">
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={14} aria-hidden="true" />
              打开来源
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" onSelect={copyLink}>
            <Copy size={14} aria-hidden="true" />
            复制链接
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
