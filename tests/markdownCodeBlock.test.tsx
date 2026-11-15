// @vitest-environment jsdom
// A reply's code block has its language, Copy and Wrap in a small header; Wrap is one choice for every block, kept between
// launches. Markdown elsewhere (plans, comments) keeps plain blocks.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Markdown } from '../src/renderer/src/components/Markdown'
import { resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const text = '```ts\nexport const safe = (path: string) => path\n```'

beforeEach(resetFake)
afterEach(cleanup)

describe('a code block in a reply', () => {
  it('has its language, Copy and a Wrap toggle that every block shares', async () => {
    // After setup, which puts its own clipboard in place.
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = render(
      <>
        <Markdown text={text} codeTools />
        <Markdown text={text} codeTools />
      </>
    )
    expect(container.querySelector('.code-block .snippet-toolbar')?.textContent).toContain('ts')
    await user.click(screen.getAllByRole('button', { name: 'Copy code' })[0])
    expect(writeText).toHaveBeenCalledWith('export const safe = (path: string) => path')
    expect((storeModule.showToast as Mock).mock.calls.at(-1)?.[0]).toBe('Copied')

    const [wrap, other] = screen.getAllByRole('button', { name: 'Wrap lines' })
    const was = wrap.getAttribute('aria-pressed') === 'true'
    await user.click(wrap)
    expect(other.getAttribute('aria-pressed')).toBe(String(!was))
    expect(container.querySelectorAll('.code-block[data-wrap]').length).toBe(was ? 0 : 2)
    expect(localStorage.getItem('foreman:codeWrap')).toBe(was ? '0' : '1')
  })

  it('stays a plain block where Markdown isn’t a reply', () => {
    const { container } = render(<Markdown text={text} />)
    expect(container.querySelector('.code-block')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull()
  })
})
