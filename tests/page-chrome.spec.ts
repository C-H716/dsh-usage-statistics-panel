/**
 * Source guard for the standalone panel's top strip.
 *
 * A main panel starts at the window's top-left corner, and window dragging is
 * owned per chrome row over that row's own box (app-regions are geometry, not
 * stacking). The 28px top inset therefore has to sit on the row's box, not on
 * the scrolling `.page` container: an inset painted by the container is a strip
 * above the content that no drag region covers. No local runtime can observe
 * dragging, so the rule is pinned at the source, the way the host pins its own
 * app-region rules (packages/client/ui-dockkit/tests/app-region-styles.client.spec.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SHEET = join(__dirname, '..', 'src', 'client', 'UsageStatsPanel.module.css')

/** The declaration block of one simple class selector, without its comments. */
function block(css: string, selector: string): string {
  const matched = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'u').exec(css.replace(/\/\*[\s\S]*?\*\//gu, ''))
  expect(matched, `${selector} rule is missing`).not.toBeNull()
  return matched?.[1] ?? ''
}

describe('standalone panel chrome', () => {
  const css = readFileSync(SHEET, 'utf8')

  it('keeps the page container free of a top inset', () => {
    // `.page > *` must not answer here, so the selector is matched literally.
    expect(block(css, '.page')).toMatch(/padding:\s*0\s/u)
  })

  it('carries the 28px top inset on the back row instead', () => {
    const backRow = block(css, '.backRow')
    expect(backRow).toMatch(/padding-top:\s*28px/u)
    // The row starts at the window's top edge, so its box must stay the size
    // its content needs rather than growing by the inset.
    expect(backRow).toMatch(/box-sizing:\s*border-box/u)
  })
})
